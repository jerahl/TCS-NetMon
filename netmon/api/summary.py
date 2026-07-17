"""Global dashboard summary API (spec 10 §6 / phase 10.5): read-only, viewer
role, DB-only.

``GET /api/summary`` is everything the Global page needs above its site heatmap
and event stream (which keep their own endpoints, `/api/sites` + `/api/events`):

  * a **fleet** count (up/down/unknown/blind) for the severity strip,
  * a device **severity** roll-up (each device's worst dimension),
  * an open-**alerts** roll-up (crit/warn, acked/assigned), and
  * per-domain **system cards** (switching, wireless, nac, surveillance, voip,
    config-backup) — each card folds the domain's device-state roll-up with the
    backing collector's health so a *blind* source never renders as ``ok``
    (§4.5 fail-loud), and carries the source's last-success timestamp so the UI
    badges staleness honestly.

Every number is a roll-up over NetMon's own tables — zero source-platform calls
at render (spec 10 §1).
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import get_engine, require_role
from netmon.models.schemas import (
    Role,
    Severity,
    Summary,
    SummaryAlerts,
    SummaryFleet,
    SummaryKpi,
    SystemDomain,
)

router = APIRouter(tags=["summary"])

_SEV_RANK = {"unknown": 0, "ok": 1, "warn": 2, "crit": 3}
_RANK_SEV = {v: k for k, v in _SEV_RANK.items()}


def _sev(value) -> str:
    v = str(value or "unknown")
    return v if v in _SEV_RANK else "unknown"


def _worse(a: str, b: str) -> str:
    return a if _SEV_RANK[a] >= _SEV_RANK[b] else b


# Per-enabled-device dimension states, so we can roll each device up to its
# worst severity and read its ping / source_status in one pass.
_DEVICE_STATE_SQL = """
SELECT d.id AS id, d.device_type AS device_type,
       s.dimension AS dimension, s.value AS value, s.severity AS severity
FROM devices d
LEFT JOIN device_state s ON s.device_id = d.id
WHERE d.enabled = 1
"""


class _DeviceRoll:
    __slots__ = ("device_type", "worst", "ping", "source_status", "has_state")

    def __init__(self, device_type: str) -> None:
        self.device_type = device_type or "other"
        self.worst = "unknown"
        self.ping: str | None = None
        self.source_status: str | None = None
        self.has_state = False


def _device_rolls(engine: Engine) -> dict[int, _DeviceRoll]:
    rolls: dict[int, _DeviceRoll] = {}
    for r in db.fetch_all(engine, _DEVICE_STATE_SQL):
        roll = rolls.get(r["id"])
        if roll is None:
            roll = _DeviceRoll(r.get("device_type"))
            rolls[r["id"]] = roll
        dim = r.get("dimension")
        if dim is None:
            continue  # LEFT JOIN: device with no state rows yet
        roll.has_state = True
        roll.worst = _worse(roll.worst, _sev(r.get("severity")))
        if dim == "ping":
            roll.ping = r.get("value")
        elif dim == "source_status":
            roll.source_status = r.get("value")
    return rolls


def _fleet(rolls: dict[int, _DeviceRoll]) -> SummaryFleet:
    f = SummaryFleet(total=len(rolls))
    by_type: dict[str, int] = {}
    for roll in rolls.values():
        by_type[roll.device_type] = by_type.get(roll.device_type, 0) + 1
        if roll.ping == "up":
            f.up += 1
        elif roll.ping == "down":
            f.down += 1
        else:
            f.unknown += 1
        if roll.source_status == "blind":
            f.blind += 1
    f.by_type = by_type
    return f


def _severity_counts(rolls: dict[int, _DeviceRoll]) -> dict[str, int]:
    counts = {s.value: 0 for s in Severity}
    for roll in rolls.values():
        counts[roll.worst if roll.has_state else "unknown"] += 1
    return counts


def _alerts(engine: Engine) -> SummaryAlerts:
    rows = db.fetch_all(
        engine,
        "SELECT r.severity AS severity, a.acked_by AS acked_by, "
        "a.assigned_to AS assigned_to "
        "FROM alerts a JOIN alert_rules r ON r.id = a.rule_id "
        "WHERE a.closed_at IS NULL",
    )
    out = SummaryAlerts()
    for r in rows:
        out.open += 1
        sev = _sev(r.get("severity"))
        if sev == "crit":
            out.crit += 1
        elif sev == "warn":
            out.warn += 1
        if r.get("acked_by"):
            out.acked += 1
        else:
            out.unacked += 1
        if r.get("assigned_to"):
            out.assigned += 1
    return out


def _source_health(engine: Engine) -> dict[str, dict]:
    """collector_health keyed by name → {status, last_success}.

    ``status`` mirrors netmon.api.health._derive_status: error when there are
    consecutive failures, unknown when it never succeeded, else ok.
    """
    out: dict[str, dict] = {}
    for r in db.fetch_all(
        engine,
        "SELECT name, last_success, consecutive_failures FROM collector_health",
    ):
        failures = r.get("consecutive_failures") or 0
        if failures and failures > 0:
            status = "error"
        elif r.get("last_success") is None:
            status = "unknown"
        else:
            status = "ok"
        out[r["name"]] = {"status": status, "last_success": r.get("last_success")}
    return out


def _kpi(label: str, value, severity: str = "unknown") -> SummaryKpi:
    return SummaryKpi(label=label, value=str(value), severity=Severity(severity))


def _domain(
    *, key, label, source, health, device_severity, headline, href, kpis,
) -> SystemDomain:
    """Fold a domain's device-severity roll-up with its source health into one
    honest status. A failing source ('error') is blind → at least ``warn`` and
    never ``ok``; a source that never succeeded leaves the domain ``unknown``."""
    hs = health.get(source or "", {})
    src_status = hs.get("status", "unknown")
    blind = src_status == "error"
    status = device_severity
    if blind:
        status = _worse(status, "warn")
    elif src_status == "unknown" and device_severity == "unknown":
        status = "unknown"
    return SystemDomain(
        key=key,
        label=label,
        status=Severity(status),
        blind=blind,
        source=source,
        updated_at=hs.get("last_success"),
        headline=headline,
        href=href,
        kpis=kpis,
    )


def _domain_severity(rolls: dict[int, _DeviceRoll], types: set[str]) -> str:
    worst = "unknown"
    seen = False
    for roll in rolls.values():
        if roll.device_type in types and roll.has_state:
            seen = True
            worst = _worse(worst, roll.worst)
    return worst if seen else "unknown"


def _scalar(engine: Engine, sql: str, params: dict | None = None) -> int:
    row = db.fetch_one(engine, sql, params)
    return int(next(iter(row.values())) or 0) if row else 0


def _build_domains(engine: Engine, rolls: dict[int, _DeviceRoll], health: dict) -> list[SystemDomain]:
    domains: list[SystemDomain] = []

    # --- Switching (native SNMP; ping via poller, inventory via snmp_inventory)
    sw_total = sum(1 for r in rolls.values() if r.device_type == "switch")
    sw_up = sum(1 for r in rolls.values() if r.device_type == "switch" and r.ping == "up")
    ports = db.fetch_one(
        engine,
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN oper_state = 'up' THEN 1 ELSE 0 END) AS up FROM switch_ports",
    ) or {}
    ports_total = int(ports.get("total") or 0)
    ports_up = int(ports.get("up") or 0)
    domains.append(_domain(
        key="switching", label="Switching", source="snmp_inventory", health=health,
        device_severity=_domain_severity(rolls, {"switch"}),
        headline=f"{sw_up}/{sw_total} switches up",
        href="#/switches",
        kpis=[
            _kpi("Switches up", f"{sw_up}/{sw_total}", "ok" if sw_up == sw_total else "warn"),
            _kpi("Ports up", f"{ports_up}/{ports_total}" if ports_total else "—"),
        ],
    ))

    # --- Wireless (XIQ)
    ap_total = sum(1 for r in rolls.values() if r.device_type == "ap")
    ap_up = sum(1 for r in rolls.values() if r.device_type == "ap" and r.ping == "up")
    clients = _scalar(engine, "SELECT COUNT(*) FROM wireless_clients")
    domains.append(_domain(
        key="wireless", label="Wireless (XIQ)", source="xiq", health=health,
        device_severity=_domain_severity(rolls, {"ap"}),
        headline=f"{ap_up}/{ap_total} APs up",
        href="#/xiq",
        kpis=[
            _kpi("APs up", f"{ap_up}/{ap_total}", "ok" if ap_up == ap_total else "warn"),
            _kpi("Clients", clients),
        ],
    ))

    # --- NAC (PacketFence) — pf_nodes, not registry devices
    nac = db.fetch_one(
        engine,
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) AS online, "
        "SUM(CASE WHEN reg_status = 'unreg' THEN 1 ELSE 0 END) AS unreg FROM pf_nodes",
    ) or {}
    nac_total = int(nac.get("total") or 0)
    domains.append(_domain(
        key="nac", label="NAC (PacketFence)", source="packetfence", health=health,
        device_severity="ok" if nac_total else "unknown",
        headline=f"{int(nac.get('online') or 0)} endpoints online",
        href="#/nac",
        kpis=[
            _kpi("Nodes", nac_total),
            _kpi("Online", int(nac.get("online") or 0)),
            _kpi("Unregistered", int(nac.get("unreg") or 0),
                 "warn" if int(nac.get("unreg") or 0) else "ok"),
        ],
    ))

    # --- Surveillance (Milestone)
    cam_total = sum(1 for r in rolls.values() if r.device_type == "camera")
    cam_rec = _scalar(
        engine,
        "SELECT COUNT(*) FROM device_state WHERE dimension = 'recording' AND value = 'up'")
    rs_total = sum(1 for r in rolls.values() if r.device_type == "recording_server")
    domains.append(_domain(
        key="surveillance", label="Surveillance", source="milestone", health=health,
        device_severity=_domain_severity(rolls, {"camera", "recording_server"}),
        headline=f"{cam_rec}/{cam_total} cameras recording",
        href="#/surveillance",
        kpis=[
            _kpi("Recording", f"{cam_rec}/{cam_total}" if cam_total else "—",
                 "ok" if cam_total and cam_rec == cam_total else ("warn" if cam_total else "unknown")),
            _kpi("Servers", rs_total),
        ],
    ))

    # --- VoIP (3CX)
    trunks = db.fetch_one(
        engine,
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN reg_status = 'registered' THEN 1 ELSE 0 END) AS reg FROM trunks",
    ) or {}
    ext = db.fetch_one(
        engine,
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN registered = 1 THEN 1 ELSE 0 END) AS reg FROM extensions",
    ) or {}
    tr_total = int(trunks.get("total") or 0)
    tr_reg = int(trunks.get("reg") or 0)
    domains.append(_domain(
        key="voip", label="VoIP (3CX)", source="threecx", health=health,
        device_severity=_domain_severity(rolls, {"trunk", "pbx"}),
        headline=f"{tr_reg}/{tr_total} trunks registered",
        href="#/voip",
        kpis=[
            _kpi("Trunks", f"{tr_reg}/{tr_total}" if tr_total else "—",
                 "ok" if tr_total and tr_reg == tr_total else ("crit" if tr_total else "unknown")),
            _kpi("Extensions", f"{int(ext.get('reg') or 0)}/{int(ext.get('total') or 0)}"
                 if int(ext.get("total") or 0) else "—"),
        ],
    ))

    # --- Config backups (rConfig) — freshness lives in device_state.config_backup
    cb = {r["severity"]: r["n"] for r in db.fetch_all(
        engine,
        "SELECT severity, COUNT(*) AS n FROM device_state "
        "WHERE dimension = 'config_backup' GROUP BY severity")}
    cb_worst = "unknown"
    for s in ("crit", "warn", "ok"):
        if cb.get(s):
            cb_worst = _worse(cb_worst, s)
    cb_ok = int(cb.get("ok") or 0)
    cb_total = sum(int(v or 0) for v in cb.values())
    domains.append(_domain(
        key="config", label="Config backups", source="rconfig", health=health,
        device_severity=cb_worst,
        headline=f"{cb_ok}/{cb_total} backups current" if cb_total else "no backup data",
        href="#/switches",
        kpis=[
            _kpi("Current", f"{cb_ok}/{cb_total}" if cb_total else "—",
                 cb_worst if cb_total else "unknown"),
            _kpi("Stale", int(cb.get("warn") or 0) + int(cb.get("crit") or 0),
                 "warn" if (int(cb.get("warn") or 0) + int(cb.get("crit") or 0)) else "ok"),
        ],
    ))

    return domains


@router.get("/api/summary", response_model=Summary)
def summary(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> Summary:
    rolls = _device_rolls(engine)
    health = _source_health(engine)
    return Summary(
        generated_at=datetime.now(timezone.utc),
        fleet=_fleet(rolls),
        severity=_severity_counts(rolls),
        alerts=_alerts(engine),
        domains=_build_domains(engine, rolls, health),
    )
