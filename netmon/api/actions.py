"""Operator write-action endpoints (spec 11 D4, approved 2026-07-28).

Four POSTs, one per ZCD action: Reevaluate Access, Restart Port, Cycle PoE,
Reboot AP. Every one goes through ``netmon.actions.AuditedAction`` so an attempt
is recorded before the call leaves, and through a per-action config flag so any
can be switched off without a deploy.

Design rules that are not negotiable here:

* **The target is resolved server-side from the registry.** A caller supplies a
  ``device_id`` (and a port/MAC that must belong to it), never a URL, host, path
  or snippet body. That is what stops these endpoints becoming an SSRF pivot or
  an arbitrary-command channel into the management network.
* **No retries.** A state-changing call that times out may already have landed;
  re-sending could reboot an AP twice or bounce a port twice. The operator sees
  an honest "unknown" and re-checks.
* **GET /api/actions** advertises what is available so the UI can render real
  buttons instead of guessing, and can explain *why* one is unavailable.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.engine import Engine

from netmon import db
from netmon.actions import ACTIONS, ActionRefused, AuditedAction, action_or_refuse
from netmon.api.deps import current_user, get_engine, require_role
from netmon.config import Config
from netmon.models.schemas import Role

log = logging.getLogger("netmon.api.actions")

router = APIRouter(prefix="/api/actions", tags=["actions"])


def _cfg(request: Request) -> Config:
    return request.app.state.config


def _flag(cfg: Config, key: str) -> bool:
    a = cfg.actions
    return bool(a.enabled and getattr(a, key, False))


def _require_enabled(cfg: Config, key: str) -> None:
    if not cfg.actions.enabled:
        raise ActionRefused("write actions are disabled ([actions] enabled = false)")
    if not getattr(cfg.actions, key, False):
        raise ActionRefused(f"{key} is disabled ([actions] {key} = false)")


def _gate(request: Request):
    """Role gate honouring the configured floor, defaulting to operator."""
    floor = getattr(_cfg(request).actions, "min_role", "operator")
    try:
        role = Role(floor)
    except ValueError:  # pragma: no cover — config validation rejects this
        role = Role.operator
    return require_role(role)


def _device(engine: Engine, device_id: int, *, want_type: str | None = None) -> dict:
    row = db.fetch_one(
        engine,
        "SELECT id, name, site, device_type, mgmt_ip, enabled, xiq_device_id "
        "FROM devices WHERE id = :id",
        {"id": device_id},
    )
    if row is None:
        raise ActionRefused(f"device {device_id} is not in the registry")
    d = dict(row)
    if not d.get("enabled"):
        raise ActionRefused(f"{d['name']} is disabled in the registry")
    if want_type and d.get("device_type") != want_type:
        raise ActionRefused(f"{d['name']} is a {d.get('device_type')}, not a {want_type}")
    return d


# ───────────────────────── request models ─────────────────────────

class NodeActionBody(BaseModel):
    mac: str = Field(min_length=6, max_length=64)
    device_id: int | None = None     # switch the endpoint is on, for the audit trail


class PoeCycleBody(BaseModel):
    device_id: int
    port: str = Field(min_length=1, max_length=64)
    member: int = Field(default=1, ge=1, le=8)


class ApRebootBody(BaseModel):
    device_id: int


# ───────────────────────── capability advertisement ─────────────────────────

@router.get("")
def list_actions(request: Request, _user=Depends(require_role(Role.viewer))) -> dict:
    """What the operator may do, and why not when they may not.

    The UI reads this to decide whether to render a live button, a disabled one
    with a reason, or nothing at all — rather than hardcoding assumptions that
    drift from config.
    """
    cfg = _cfg(request)
    user = getattr(request.state, "user", None)
    out = []
    for spec in ACTIONS.values():
        enabled = _flag(cfg, spec.key)
        reason = ""
        if not cfg.actions.enabled:
            reason = "write actions are disabled"
        elif not enabled:
            reason = f"{spec.key} is disabled in config"
        out.append({
            "key": spec.key, "label": spec.label, "source": spec.source,
            "effect": spec.effect, "disruptive": spec.disruptive,
            "enabled": enabled, "reason": reason,
        })
    return {
        "actions": out,
        "min_role": cfg.actions.min_role,
        "your_role": getattr(user, "role", None) and user.role.value,
    }


def _refused(exc: ActionRefused) -> HTTPException:
    """A refusal is a 409, not a 500.

    Nothing was sent to the source, the reason is operator-facing, and the
    attempt is already in action_audit — so the client gets the explanation
    rather than a stack trace.
    """
    return HTTPException(status_code=409, detail=str(exc))


# ───────────────────────── the four actions ─────────────────────────

@router.post("/reevaluate-access")
async def reevaluate_access(body: NodeActionBody, request: Request,
                            engine: Engine = Depends(get_engine),
                            user=Depends(current_user)) -> dict:
    try:
        return await _pf_action(request, engine, user, body, "reevaluate_access")
    except ActionRefused as exc:
        raise _refused(exc) from exc


@router.post("/restart-port")
async def restart_port(body: NodeActionBody, request: Request,
                       engine: Engine = Depends(get_engine),
                       user=Depends(current_user)) -> dict:
    try:
        return await _pf_action(request, engine, user, body, "restart_port")
    except ActionRefused as exc:
        raise _refused(exc) from exc


async def _pf_action(request, engine: Engine, user, body: NodeActionBody, key: str) -> dict:
    from netmon.collectors.pf_client import PfClient, PfError

    cfg = _cfg(request)
    spec = action_or_refuse(key)
    _authorise(request, user)
    op = "reevaluate_access" if key == "reevaluate_access" else "restart_switchport"
    mac = body.mac.strip().lower()
    with AuditedAction(engine, spec, actor=_actor(user), role=_role(user),
                       device_id=body.device_id, target=mac,
                       params={"mac": mac, "op": op}) as audit:
        _require_enabled(cfg, key)
        s = (cfg.sources.get("packetfence").settings if cfg.sources.get("packetfence") else {})
        if not (s.get("url") or "").strip():
            raise ActionRefused("PacketFence is not configured")
        client = PfClient(
            url=(s.get("url") or "").strip(), user=(s.get("user") or "").strip(),
            password=s.get("pass") or "",
            verify_ssl=str(s.get("verify_ssl", "true")).strip().lower() in ("1", "true", "yes", "on"),
        )
        try:
            msg, status = await client.node_action(mac, op)
        except PfError as exc:
            audit.failed(str(exc))
            raise HTTPException(status_code=502, detail=f"PacketFence: {exc}") from exc
        audit.ok(msg, http_status=status)
        return {"ok": True, "action": key, "target": mac, "message": msg}


@router.post("/poe-cycle")
async def poe_cycle(body: PoeCycleBody, request: Request,
                    engine: Engine = Depends(get_engine),
                    user=Depends(current_user)) -> dict:
    try:
        return await _poe_cycle_impl(body, request, engine, user)
    except ActionRefused as exc:
        raise _refused(exc) from exc


async def _poe_cycle_impl(body: PoeCycleBody, request: Request, engine: Engine, user) -> dict:
    from netmon.collectors.rconfig_client import RConfigClient, RConfigError

    cfg = _cfg(request)
    spec = action_or_refuse("poe_cycle")
    _authorise(request, user)
    with AuditedAction(engine, spec, actor=_actor(user), role=_role(user),
                       device_id=body.device_id, target=f"port {body.port}",
                       params={"port": body.port, "member": body.member,
                               "snippet_id": cfg.actions.poe_snippet_id}) as audit:
        _require_enabled(cfg, "poe_cycle")
        dev = _device(engine, body.device_id, want_type="switch")
        _port_belongs(engine, body.device_id, body.port)
        s = (cfg.sources.get("rconfig").settings if cfg.sources.get("rconfig") else {})
        if not (s.get("url") or "").strip():
            raise ActionRefused("rConfig is not configured")
        client = RConfigClient(
            url=(s.get("url") or "").strip(), token=s.get("api_token") or "",
            verify_ssl=str(s.get("verify_ssl", "true")).strip().lower() in ("1", "true", "yes", "on"),
        )
        try:
            # NetMon holds no rconfig_device_id for any device, so resolve now.
            rc_id = await client.resolve_device_id(mgmt_ip=str(dev.get("mgmt_ip") or ""),
                                                   name=str(dev.get("name") or ""))
            if rc_id is None:
                raise ActionRefused(
                    f"{dev['name']} ({dev.get('mgmt_ip')}) is not a device rConfig knows — "
                    "it cannot run the PoE snippet against it")
            msg, status = await client.deploy_snippet(
                rc_id, cfg.actions.poe_snippet_id,
                {"port": str(body.port), "member": str(body.member)},
            )
        except RConfigError as exc:
            audit.failed(str(exc))
            raise HTTPException(status_code=502, detail=f"rConfig: {exc}") from exc
        audit.ok(msg, http_status=status)
        return {"ok": True, "action": "poe_cycle", "target": f"{dev['name']} port {body.port}",
                "message": msg}


@router.post("/ap-reboot")
async def ap_reboot(body: ApRebootBody, request: Request,
                    engine: Engine = Depends(get_engine),
                    user=Depends(current_user)) -> dict:
    try:
        return await _ap_reboot_impl(body, request, engine, user)
    except ActionRefused as exc:
        raise _refused(exc) from exc


async def _ap_reboot_impl(body: ApRebootBody, request: Request, engine: Engine, user) -> dict:
    from netmon.collectors.xiq_client import XiqClient, XiqError

    cfg = _cfg(request)
    spec = action_or_refuse("ap_reboot")
    _authorise(request, user)
    with AuditedAction(engine, spec, actor=_actor(user), role=_role(user),
                       device_id=body.device_id, target=None) as audit:
        _require_enabled(cfg, "ap_reboot")
        dev = _device(engine, body.device_id, want_type="ap")
        xiq_id = str(dev.get("xiq_device_id") or "").strip()
        if not xiq_id.isdigit():
            raise ActionRefused(f"{dev['name']} has no XIQ device id — XIQ cannot reboot it")
        s = (cfg.sources.get("xiq").settings if cfg.sources.get("xiq") else {})
        token = s.get("api_token") or s.get("token") or ""
        if not token:
            raise ActionRefused("XIQ is not configured")
        client = XiqClient(token=token)
        try:
            msg, status = await client.reboot_device(int(xiq_id))
        except XiqError as exc:
            audit.failed(str(exc))
            raise HTTPException(status_code=502, detail=f"XIQ: {exc}") from exc
        audit.ok(msg, http_status=status)
        return {"ok": True, "action": "ap_reboot", "target": dev["name"], "message": msg}


# ───────────────────────── audit trail ─────────────────────────

@router.get("/audit")
def audit_log(request: Request, limit: int = 100, device_id: int | None = None,
              engine: Engine = Depends(get_engine),
              _user=Depends(require_role(Role.viewer))) -> list[dict]:
    """Recent attempts. Viewer-readable on purpose — who bounced what is
    operational history, not a secret, and hiding it would defeat the audit."""
    limit = max(1, min(int(limit), 500))
    sql = ("SELECT id, requested_at, completed_at, actor, actor_role, action, source, "
           "device_id, target, outcome, http_status, message, duration_ms "
           "FROM action_audit ")
    params: dict = {"lim": limit}
    if device_id is not None:
        sql += "WHERE device_id = :dev "
        params["dev"] = device_id
    sql += "ORDER BY id DESC LIMIT :lim"
    return [dict(r) for r in db.fetch_all(engine, sql, params)]


# ───────────────────────── helpers ─────────────────────────

def _actor(user) -> str:
    return str(getattr(user, "username", None) or getattr(user, "sub", None) or "unknown")[:190]


def _role(user) -> str:
    r = getattr(user, "role", None)
    return str(getattr(r, "value", r) or "unknown")[:16]


def _authorise(request: Request, user) -> None:
    """Enforce the configured role floor.

    Done here rather than as a route dependency because the floor is
    configurable, and a dependency is resolved before config is consulted.
    """
    from netmon.config import ROLES

    floor = getattr(_cfg(request).actions, "min_role", "operator")
    have = _role(user)
    try:
        if ROLES.index(have) < ROLES.index(floor):
            raise HTTPException(status_code=403,
                                detail=f"write actions require role {floor} or higher")
    except ValueError:  # unknown role string — refuse rather than guess
        raise HTTPException(status_code=403, detail="role not recognised") from None


def _port_belongs(engine: Engine, device_id: int, port: str) -> None:
    """The port must exist on that switch.

    Without this a caller could pass any port string and have it substituted
    into the rConfig snippet — the snippet is trusted, its arguments are not.
    """
    row = db.fetch_one(
        engine,
        "SELECT 1 AS ok FROM switch_ports WHERE device_id = :d AND (name = :p OR ifindex = :i) LIMIT 1",
        {"d": device_id, "p": port, "i": _as_int(port)},
    )
    if row is None:
        raise ActionRefused(
            f"port {port!r} is not a known port on device {device_id} "
            "(run an SNMP inventory sweep first, or check the port name)")


def _as_int(v: str) -> int:
    try:
        return int(str(v).strip())
    except ValueError:
        return -1
