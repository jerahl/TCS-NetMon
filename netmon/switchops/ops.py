"""PoE cycle, port bounce, verification and the restore sweep (spec 26).

Order of every write, and why:

1. **Audit row first** (``AuditedAction``) — an attempt is evidence even if
   the process dies mid-cycle.
2. **Refusals** — policy (``ports.check``), cooldown, one-in-flight-per-switch.
3. **Pre-read** of the exact objects about to be SET. A switch that does not
   have the instance is refused here, before anything is sent, so a wrong
   index can never become a SET.
4. For anything that *takes something away* (ifAdminStatus down,
   pethPsePortAdminEnable false): **the restore is written down before the
   SET** in ``switch_port_restores``, then the SET, the wait, the restore SET,
   and the row is deleted only once the restore was accepted. If any step
   after the first SET fails or the process dies, the row survives and the
   restore sweep in netmon-poller.service puts the port back.
5. **Verification** runs after the switch lock is released, in the
   background, and appends its result (timings, pass/fail) to the same audit
   row — so a bulk action does not hold a switch for minutes per port.

Dry run (``[switch_ops] dry_run = true``, the default) does steps 1–3 for real
— the pre-read is a GET — and records the exact snmpset commands it would
have run instead of sending them. No restore row, no verification.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.actions import ActionError, ActionRefused, AuditedAction, action_or_refuse
from netmon.config import EngineConfig, SwitchOpsConfig
from netmon.poller.snmp_inventory import mac_from_fdb_suffix
from netmon.switchops import ports as P
from netmon.switchops import snmp as S

log = logging.getLogger("netmon.switchops")

RESTORE_RULE = "switch_port_restore"

_LOCKS: dict[int, asyncio.Lock] = {}
_BACKGROUND: set[asyncio.Task] = set()


def _lock(device_id: int) -> asyncio.Lock:
    lk = _LOCKS.get(device_id)
    if lk is None:
        lk = _LOCKS[device_id] = asyncio.Lock()
    return lk


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Outcome:
    ok: bool
    message: str
    method: str = ""
    dry_run: bool = False
    commands: list[str] = field(default_factory=list)
    verify: dict[str, Any] | None = None   # what the background verifier needs


# ───────────────────────── entry point ─────────────────────────

async def run_port_action(
    engine: Engine, cfg: SwitchOpsConfig, writer: S.SnmpWriter, reader: S.SnmpReader, *,
    action: str, device_id: int, port: str, actor: str, role: str,
    override_confirm: str | None = None, down_s: int | None = None,
    background_verify: bool = True,
) -> dict[str, Any]:
    """One audited PoE cycle or port bounce on one port.

    Raises ``ActionRefused`` (``ports.Unavailable`` for a missing capability)
    when nothing was sent; returns a result dict otherwise, ``ok`` False when
    a SET was refused by the switch or a restore did not land.
    """
    spec = action_or_refuse(action)
    if spec.source != "switch":
        raise ActionRefused(f"{action} is not a switch action")
    resolved: P.Port | None = None
    resolve_exc: ActionRefused | None = None
    try:
        resolved = P.resolve(engine, device_id, port)
    except ActionRefused as exc:
        resolve_exc = exc
    params: dict[str, Any] = {"port": str(port), "dry_run": cfg.dry_run}
    if down_s is not None:
        params["down_s"] = down_s
    if override_confirm:
        params["override_confirm"] = override_confirm
    target = resolved.target if resolved else f"port {port}"

    with AuditedAction(engine, spec, actor=actor, role=role, device_id=device_id,
                       target=target, params=params) as audit:
        if not cfg.enabled:
            raise P.Unavailable("switch operations are disabled ([switch_ops] enabled = false)")
        flag = {"snmp_poe_cycle": cfg.poe_cycle, "snmp_port_bounce": cfg.port_bounce}[action]
        if not flag:
            raise P.Unavailable(f"{action} is disabled in [switch_ops]")
        if resolve_exc is not None:
            raise resolve_exc
        p = resolved
        assert p is not None
        if not cfg.dry_run and not cfg.has_credentials:
            raise P.Unavailable("no SNMPv3 write credentials — set NETMON_SNMP_RW_USER/"
                                "_AUTH/_PRIV in /etc/netmon/netmon.env")
        verdict = P.check(engine, p, action, role=role, override_confirm=override_confirm)
        if not verdict.allowed:
            raise ActionRefused(f"{p.switch_name} {p.name}: " + "; ".join(verdict.reasons))
        if verdict.reasons:  # an admin override: say so in the trail
            log.warning("%s on %s %s by %s: %s", action, p.switch_name, p.name, actor,
                        "; ".join(verdict.reasons))
        why = (P.cooldown_refusal(engine, p, cfg.cooldown_s, exclude_audit_id=audit.audit_id)
               or P.in_flight_refusal(engine, p.device_id, exclude_audit_id=audit.audit_id))
        if why:
            raise ActionRefused(why)
        if _lock(p.device_id).locked():
            raise ActionRefused("another write is in flight on this switch; one at a time")
        outstanding = db.fetch_one(
            engine, "SELECT id FROM switch_port_restores WHERE device_id = :d AND ifindex = :i",
            {"d": p.device_id, "i": p.ifindex})
        if outstanding:
            raise ActionRefused(f"{p.name} still has an outstanding restore (#{outstanding['id']}); "
                                "wait for the restore sweep")

        async with _lock(p.device_id):
            if action == "snmp_poe_cycle":
                out = await _poe_cycle(engine, cfg, writer, reader, p, actor, audit.audit_id)
            else:
                d = min(max(int(down_s or cfg.bounce_down_s), 1), cfg.bounce_max_s)
                out = await _bounce(engine, cfg, writer, reader, p, actor, audit.audit_id, d)

        prefix = "DRY RUN — " if out.dry_run else ""
        override = f" [{verdict.reasons[0]}]" if verdict.reasons else ""
        msg = f"{prefix}{out.message}{override}"
        if out.ok:
            audit.ok(msg + ("" if out.dry_run or not out.verify else " | verifying…"))
        else:
            audit.failed(msg)
        audit_id = audit.audit_id

    if out.ok and out.verify and not out.dry_run:
        coro = verify(engine, cfg, reader, p, action, audit_id, msg, **out.verify)
        if background_verify:
            t = asyncio.get_running_loop().create_task(coro)
            _BACKGROUND.add(t)
            t.add_done_callback(_BACKGROUND.discard)
        else:
            await coro
    return {"ok": out.ok, "action": action, "switch": p.switch_name, "port": p.name,
            "method": out.method, "dry_run": out.dry_run, "commands": out.commands,
            "message": msg, "audit_id": audit_id}


# ───────────────────────── the two actions ─────────────────────────

async def _pre_read(reader: S.SnmpReader, ip: str, oids: list[str]) -> dict[str, str]:
    try:
        return await reader.get(ip, oids)
    except S.SnmpReadError as exc:
        raise ActionRefused(f"could not read the port before acting, nothing was sent: {exc}") \
            from exc


def _pre_macs(engine: Engine, p: P.Port) -> list[str]:
    return [r["mac"] for r in db.fetch_all(
        engine, "SELECT mac FROM fdb_entries WHERE device_id = :d AND ifindex = :i",
        {"d": p.device_id, "i": p.ifindex})]


async def _poe_cycle(engine: Engine, cfg: SwitchOpsConfig, writer: S.SnmpWriter,
                     reader: S.SnmpReader, p: P.Port, actor: str, audit_id: int | None
                     ) -> Outcome:
    reset_oid = f"{S.EXT_POE_RESET}.{p.poe_index}"
    admin_oid = f"{S.PETH_ADMIN}.{p.poe_index}"
    pre = await _pre_read(reader, p.mgmt_ip, [reset_oid, admin_oid])
    has_reset = not S.is_missing(pre.get(reset_oid))
    has_admin = not S.is_missing(pre.get(admin_oid))
    if not has_reset and not has_admin:
        raise P.Unavailable(f"{p.switch_name} has no PoE object for {p.name} "
                            f"(index {p.poe_index}); nothing was sent")
    if has_admin and S.enum_int(pre.get(admin_oid)) == 2:
        raise ActionRefused(f"PoE is administratively off on {p.name}; a cycle would turn it on")
    verify = {"pre_macs": _pre_macs(engine, p), "t0": time.monotonic()}

    if has_reset:
        r = await writer.set_int(p.mgmt_ip, reset_oid, 1)
        if r.ok:
            return Outcome(True, f"PoE reset on {p.switch_name} {p.name} "
                                 f"(extremePethPortResetPower.{p.poe_index} = set)",
                           method="reset", dry_run=r.dry_run, commands=[r.command], verify=verify)
        if r.unanswered:
            # Possibly landed. A second, different cycle on top would cut power twice.
            return Outcome(False, f"no answer to the PoE reset on {p.name}: it may have "
                                  f"happened; not falling back to a second cycle ({r.detail})",
                           method="reset", commands=[r.command])
        if not has_admin:
            return Outcome(False, f"switch refused the PoE reset on {p.name}: {r.detail}",
                           method="reset", commands=[r.command])
        log.warning("PoE reset refused on %s %s (%s); falling back to admin off/on",
                    p.switch_name, p.name, r.detail)

    out = await _take_and_restore(
        engine, cfg, writer, p, actor, audit_id, action="snmp_poe_cycle",
        oid=admin_oid, off_value=2, on_value=1, hold_s=cfg.poe_off_wait_s,
        what=f"PoE off/on on {p.switch_name} {p.name} (pethPsePortAdminEnable.{p.poe_index})")
    out.method = "admin_off_on"
    out.verify = verify if out.ok else None
    return out


async def _bounce(engine: Engine, cfg: SwitchOpsConfig, writer: S.SnmpWriter,
                  reader: S.SnmpReader, p: P.Port, actor: str, audit_id: int | None,
                  down_s: int) -> Outcome:
    admin_oid = f"{S.IF_ADMIN}.{p.ifindex}"
    pre = await _pre_read(reader, p.mgmt_ip, [admin_oid])
    if S.is_missing(pre.get(admin_oid)):
        raise P.Unavailable(f"{p.switch_name} has no ifAdminStatus.{p.ifindex}; nothing was sent")
    if S.enum_int(pre.get(admin_oid)) == 2:
        raise ActionRefused(f"{p.name} is administratively down on the switch; "
                            "a bounce would bring it up")
    out = await _take_and_restore(
        engine, cfg, writer, p, actor, audit_id, action="snmp_port_bounce",
        oid=admin_oid, off_value=2, on_value=1, hold_s=down_s,
        what=f"port bounce on {p.switch_name} {p.name} ({down_s}s down)")
    out.method = "if_admin"
    if out.ok:
        out.verify = {"pre_macs": _pre_macs(engine, p), "t0": time.monotonic()}
    return out


async def _take_and_restore(engine: Engine, cfg: SwitchOpsConfig, writer: S.SnmpWriter,
                            p: P.Port, actor: str, audit_id: int | None, *, action: str,
                            oid: str, off_value: int, on_value: int, hold_s: int,
                            what: str) -> Outcome:
    if cfg.dry_run:
        r1 = await writer.set_int(p.mgmt_ip, oid, off_value)
        r2 = await writer.set_int(p.mgmt_ip, oid, on_value)
        return Outcome(True, f"{what}: would SET {off_value}, wait {hold_s}s, SET {on_value}",
                       dry_run=True, commands=[r1.command, f"sleep {hold_s}", r2.command])

    deadline = _now() + timedelta(seconds=hold_s + cfg.restore_grace_s)
    row_id = add_restore(engine, p, action=action, oid=oid, value=on_value,
                         deadline=deadline, actor=actor, audit_id=audit_id)
    r1 = await writer.set_int(p.mgmt_ip, oid, off_value)
    if not r1.ok and not r1.unanswered:
        delete_restore(engine, row_id)   # refused outright: nothing was taken away
        return Outcome(False, f"switch refused {what}: {r1.detail}", commands=[r1.command])
    await asyncio.sleep(hold_s)
    r2 = None
    for attempt in range(3):          # restoring is idempotent, so retrying is safe
        r2 = await writer.set_int(p.mgmt_ip, oid, on_value)
        if r2.ok:
            break
        await asyncio.sleep(2)
    assert r2 is not None
    cmds = [r1.command, f"sleep {hold_s}", r2.command]
    if r2.ok:
        delete_restore(engine, row_id)
        note = "" if r1.ok else " (the first SET went unanswered but the restore landed)"
        return Outcome(True, f"{what}: done{note}", commands=cmds)
    note_restore_error(engine, row_id, r2.detail)
    return Outcome(False, f"{what}: the restore SET failed ({r2.detail}); the port may still "
                          f"be off — the restore sweep will retry and raise an alert",
                   commands=cmds)


# ───────────────────────── restore ledger ─────────────────────────

def add_restore(engine: Engine, p: P.Port, *, action: str, oid: str, value: int,
                deadline: datetime, actor: str, audit_id: int | None) -> int:
    db.execute(
        engine,
        "INSERT INTO switch_port_restores (device_id, ifindex, port, action, restore_oid, "
        "restore_value, deadline, actor, audit_id, created_at) "
        "VALUES (:d, :i, :p, :a, :o, :v, :dl, :actor, :aud, :now)",
        {"d": p.device_id, "i": p.ifindex, "p": p.name, "a": action, "o": oid, "v": value,
         "dl": deadline, "actor": actor, "aud": audit_id, "now": _now()},
    )
    row = db.fetch_one(engine, "SELECT id FROM switch_port_restores WHERE device_id = :d "
                               "AND ifindex = :i AND action = :a", {"d": p.device_id,
                                                                     "i": p.ifindex, "a": action})
    if row is None:  # pragma: no cover — the insert would have raised
        raise ActionError("could not record the pending restore; nothing was sent")
    return int(row["id"])


def delete_restore(engine: Engine, row_id: int) -> None:
    db.execute(engine, "DELETE FROM switch_port_restores WHERE id = :id", {"id": row_id})


def note_restore_error(engine: Engine, row_id: int, err: str) -> None:
    db.execute(engine, "UPDATE switch_port_restores SET attempts = attempts + 1, "
                       "last_attempt_at = :now, last_error = :e WHERE id = :id",
               {"now": _now(), "e": (err or "")[:500], "id": row_id})


async def restore_sweep(engine: Engine, cfg: SwitchOpsConfig, writer: S.SnmpWriter,
                        engine_cfg: EngineConfig) -> int:
    """Re-apply every restore whose deadline has passed. Returns rows handled.

    Runs regardless of ``enabled``/``dry_run``: putting a port back is the safe
    direction, and a port left down by a live cycle must come back even if
    someone has since switched the feature off.
    """
    rows = db.fetch_all(
        engine,
        "SELECT r.*, d.name AS switch_name, d.mgmt_ip FROM switch_port_restores r "
        "JOIN devices d ON d.id = r.device_id WHERE r.deadline <= :now ORDER BY r.id",
        {"now": _now()},
    )
    for r in rows:
        ip = str(r.get("mgmt_ip") or "").strip()
        res = await writer.set_int(ip, r["restore_oid"], int(r["restore_value"]), dry_run=False)
        if res.ok:
            delete_restore(engine, int(r["id"]))
            text = (f"NetMon restored {r['switch_name']} {r['port']}: {r['action']} by "
                    f"{r['actor']} (audit #{r['audit_id']}) did not complete, so the restore "
                    f"sweep set {r['restore_oid']} = {r['restore_value']}")
            log.error(text)
        else:
            note_restore_error(engine, int(r["id"]), res.detail)
            text = (f"{r['switch_name']} {r['port']} may still be DOWN: {r['action']} by "
                    f"{r['actor']} (audit #{r['audit_id']}) left it off and the restore "
                    f"sweep could not put it back ({res.detail})")
            log.error(text)
        _alert(engine, engine_cfg, int(r["device_id"]), text)
    _close_recovered(engine)
    return len(rows)


def _alert(engine: Engine, engine_cfg: EngineConfig, device_id: int, text: str) -> None:
    from netmon.engine.engine import maintenance_active, open_alert_id
    from netmon.engine.notify import record_notification

    rule = db.fetch_one(engine, "SELECT id, target, enabled FROM alert_rules WHERE name = :n",
                        {"n": RESTORE_RULE})
    if rule is None or not rule["enabled"]:
        log.error("cannot raise %s alert (rule missing or disabled): %s", RESTORE_RULE, text)
        return
    now = _now()
    rid = int(rule["id"])
    existing = open_alert_id(engine, device_id, rid)
    if existing is None:
        db.execute(engine, "INSERT INTO alerts (device_id, rule_id, opened_at, last_seen_at) "
                           "VALUES (:d, :r, :now, :now)", {"d": device_id, "r": rid, "now": now})
        existing = open_alert_id(engine, device_id, rid) or 0
    else:
        db.execute(engine, "UPDATE alerts SET last_seen_at = :now WHERE id = :id",
                   {"now": now, "id": existing})
    try:
        record_notification(engine, engine_cfg, alert_id=existing,
                            target=rule.get("target") or engine_cfg.default_target,
                            summary=text, suppressed=maintenance_active(engine, device_id, now))
    except Exception:  # noqa: BLE001 — the alert is open; the mail is secondary
        log.exception("restore alert #%s opened but the notification failed", existing)


def _close_recovered(engine: Engine) -> None:
    """Close a device's restore alert once it has no overdue restore left."""
    db.execute(
        engine,
        "UPDATE alerts SET closed_at = :now WHERE closed_at IS NULL "
        "AND rule_id IN (SELECT id FROM alert_rules WHERE name = :n) "
        "AND device_id NOT IN (SELECT device_id FROM switch_port_restores WHERE deadline <= :now)",
        {"now": _now(), "n": RESTORE_RULE},
    )


# ───────────────────────── verification ─────────────────────────

async def verify(engine: Engine, cfg: SwitchOpsConfig, reader: S.SnmpReader, p: P.Port,
                 action: str, audit_id: int | None, message: str, *,
                 pre_macs: list[str], t0: float, poll_s: float = 5.0) -> dict[str, Any]:
    """Read the port back until it is healthy or ``verify_timeout_s`` passes.

    PoE: power delivering (pethPsePortDetectionStatus = deliveringPower and
    measured mW > 0) and link up. Bounce: link up. Both: when the port had MACs
    before and ``verify_mac_return`` is on, at least one of them back in the
    switch's FDB on this port. Appends timings to the audit row; a port that
    never recovers turns the row's outcome to ``failed``.
    """
    oper_oid = f"{S.IF_OPER}.{p.ifindex}"
    det_oid = f"{S.PETH_DETECT}.{p.poe_index}"
    mw_oid = f"{S.EXT_POE_MW}.{p.poe_index}"
    oids = [oper_oid] + ([det_oid, mw_oid] if action == "snmp_poe_cycle" else [])
    want_mac = bool(cfg.verify_mac_return and pre_macs)
    seen: dict[str, float] = {}
    last_err = ""
    bport: list[str] | None = None
    next_fdb = 0.0
    deadline = t0 + cfg.verify_timeout_s
    while time.monotonic() < deadline:
        try:
            v = await reader.get(p.mgmt_ip, oids)
            el = round(time.monotonic() - t0, 1)
            if S.enum_int(v.get(oper_oid)) == 1:
                seen.setdefault("link", el)
            if action == "snmp_poe_cycle":
                if S.enum_int(v.get(det_oid)) == 3 and (S.enum_int(v.get(mw_oid)) or 0) > 0:
                    seen.setdefault("power", el)
            if want_mac and "link" in seen and "mac" not in seen and time.monotonic() >= next_fdb:
                next_fdb = time.monotonic() + cfg.live_fdb_interval_s
                if bport is None:
                    base = await reader.walk(p.mgmt_ip, S.BASE_PORT_IFINDEX)
                    bport = [k for k, val in base.items() if S.enum_int(val) == p.ifindex]
                fdb = await reader.walk(p.mgmt_ip, S.FDB_PORT)
                back = {mac_from_fdb_suffix(k) for k, val in fdb.items() if val.split()[0] in bport}
                if back & set(pre_macs):
                    seen["mac"] = round(time.monotonic() - t0, 1)
        except S.SnmpReadError as exc:
            last_err = str(exc)
        need = {"link"} | ({"power"} if action == "snmp_poe_cycle" else set()) | (
            {"mac"} if want_mac else set())
        if need <= seen.keys():
            break
        await asyncio.sleep(poll_s)

    need = {"link"} | ({"power"} if action == "snmp_poe_cycle" else set())
    passed = need <= seen.keys()
    parts = [f"{k} {seen[k]}s" if k in seen else f"no {k}" for k in
             (["power"] if action == "snmp_poe_cycle" else []) + ["link"]]
    if want_mac:
        parts.append(f"MAC back {seen['mac']}s" if "mac" in seen
                     else f"none of {len(pre_macs)} prior MAC(s) back")
    elif not pre_macs:
        parts.append("no prior MACs to compare")
    summary = ("verified: " if passed else "verification FAILED: ") + ", ".join(parts)
    if last_err and not passed:
        summary += f" (last read error: {last_err[:80]})"
    if audit_id is not None:
        final = f"{message} | {summary}"[:500]
        db.execute(engine, "UPDATE action_audit SET message = :m, outcome = :o WHERE id = :id",
                   {"m": final, "o": "ok" if passed else "failed", "id": audit_id})
    log.info("%s %s %s: %s", action, p.switch_name, p.name, summary)
    return {"passed": passed, "seen": seen, "summary": summary}
