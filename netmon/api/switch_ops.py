"""Direct SNMP switch operations API (spec 26).

* ``GET  /api/switch-ops``                       what is enabled, and why not
* ``GET  /api/switch-ops/check/{sid}/{ifindex}``  would this port be refused?
* ``POST /api/switch-ops/poe-cycle``             one or more ports on one switch
* ``POST /api/switch-ops/port-bounce``           one or more ports on one switch
* ``GET  /api/switch-ops/live/{sid}/{ifindex}``  live port view (viewer)

Writes are operator-and-up; a bulk request above ``bulk_max_operator`` ports
needs admin, and so does overriding an uplink refusal. Ports in a bulk request
run one after another — one write in flight per switch — and each gets its
own audit row.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.engine import Engine

from netmon.actions import ActionRefused
from netmon.api.deps import current_user, get_engine, require_role
from netmon.config import ROLES, Config
from netmon.models.schemas import Role
from netmon.switchops import ops, ports as P
from netmon.switchops.live import LiveCapReached, LivePortHub
from netmon.switchops.snmp import SnmpReader, SnmpWriter

log = logging.getLogger("netmon.api.switch_ops")

router = APIRouter(prefix="/api/switch-ops", tags=["switch-ops"])


class PortsBody(BaseModel):
    device_id: int
    ports: list[str] = Field(min_length=1, max_length=96)
    override_confirm: str | None = Field(default=None, max_length=64)


class BounceBody(PortsBody):
    down_s: int | None = Field(default=None, ge=1, le=30)


def _cfg(request: Request) -> Config:
    return request.app.state.config


def writer(request: Request) -> SnmpWriter:
    w = getattr(request.app.state, "switch_writer", None)
    if w is None:
        w = request.app.state.switch_writer = SnmpWriter(_cfg(request).switch_ops)
    return w


def reader(request: Request) -> SnmpReader:
    r = getattr(request.app.state, "switch_reader", None)
    if r is None:
        cfg = _cfg(request)
        r = request.app.state.switch_reader = SnmpReader(cfg.poller, cfg.switch_ops)
    return r


def hub(request: Request) -> LivePortHub:
    h = getattr(request.app.state, "live_ports", None)
    if h is None:
        h = request.app.state.live_ports = LivePortHub(_cfg(request).switch_ops, reader(request))
    return h


def _actor(user) -> str:
    return str(getattr(user, "username", None) or "unknown")[:190]


def _role(user) -> str:
    r = getattr(user, "role", None)
    return str(getattr(r, "value", r) or "viewer")


@router.get("")
def capabilities(request: Request, user=Depends(require_role(Role.viewer))) -> dict:
    so = _cfg(request).switch_ops
    reason = ""
    if not so.enabled:
        reason = "switch operations are disabled ([switch_ops] enabled = false)"
    elif not so.dry_run and not so.has_credentials:
        reason = "no SNMPv3 write credentials configured"
    return {
        "enabled": so.enabled, "dry_run": so.dry_run, "has_credentials": so.has_credentials,
        "reason": reason,
        "actions": {"snmp_poe_cycle": so.enabled and so.poe_cycle,
                    "snmp_port_bounce": so.enabled and so.port_bounce},
        "live_port": so.live_port, "live_interval_s": so.live_interval_s,
        "cooldown_s": so.cooldown_s, "bounce_down_s": so.bounce_down_s,
        "bounce_max_s": so.bounce_max_s,
        "bulk_max_operator": so.bulk_max_operator, "bulk_max_admin": so.bulk_max_admin,
        "your_role": _role(user),
    }


@router.get("/check/{sid}/{ifindex}")
def check_port(sid: int, ifindex: int, action: str, request: Request,
               engine: Engine = Depends(get_engine), user=Depends(require_role(Role.viewer))) -> dict:
    """Dry evaluation of the refusal rules, for the UI to explain a disabled button."""
    if action not in ("snmp_poe_cycle", "snmp_port_bounce"):
        raise HTTPException(status_code=422, detail="unknown action")
    try:
        p = P.resolve(engine, sid, ifindex)
        v = P.check(engine, p, action, role=_role(user))
        cool = P.cooldown_refusal(engine, p, _cfg(request).switch_ops.cooldown_s)
    except ActionRefused as exc:
        return {"allowed": False, "reasons": [str(exc)], "overridable": False}
    reasons = list(v.reasons) + ([cool] if cool else [])
    return {"allowed": v.allowed and not cool, "reasons": reasons,
            "overridable": v.overridable, "port": p.name}


async def _run(action: str, body: PortsBody, request: Request, engine: Engine, user,
               down_s: int | None = None) -> dict:
    so = _cfg(request).switch_ops
    role = _role(user)
    if ROLES.index(role) < ROLES.index("operator"):
        raise HTTPException(status_code=403, detail="switch operations require operator or higher")
    cap = so.bulk_max_admin if role == "admin" else so.bulk_max_operator
    if len(body.ports) > cap:
        raise HTTPException(status_code=403, detail=(
            f"{len(body.ports)} ports exceeds the {role} limit of {cap} per request"
            + ("" if role == "admin" else "; an admin can do more")))
    if len(set(body.ports)) != len(body.ports):
        raise HTTPException(status_code=422, detail="duplicate ports in request")
    results = []
    for port in body.ports:
        try:
            res = await ops.run_port_action(
                engine, so, writer(request), reader(request), action=action,
                device_id=body.device_id, port=port, actor=_actor(user), role=role,
                override_confirm=body.override_confirm, down_s=down_s)
        except ActionRefused as exc:
            res = {"ok": False, "refused": True, "port": port, "message": str(exc)}
        results.append(res)
    if len(results) == 1 and results[0].get("refused"):
        raise HTTPException(status_code=409, detail=results[0]["message"])
    return {"ok": all(r.get("ok") for r in results), "results": results}


@router.post("/poe-cycle")
async def poe_cycle(body: PortsBody, request: Request, engine: Engine = Depends(get_engine),
                    user=Depends(current_user)) -> dict:
    return await _run("snmp_poe_cycle", body, request, engine, user)


@router.post("/port-bounce")
async def port_bounce(body: BounceBody, request: Request, engine: Engine = Depends(get_engine),
                      user=Depends(current_user)) -> dict:
    return await _run("snmp_port_bounce", body, request, engine, user, down_s=body.down_s)


@router.get("/live/{sid}/{ifindex}")
async def live_port(sid: int, ifindex: int, request: Request,
                    engine: Engine = Depends(get_engine),
                    _user=Depends(require_role(Role.viewer))) -> dict:
    from netmon import db

    if not _cfg(request).switch_ops.live_port:
        raise HTTPException(status_code=404, detail="live port view is disabled "
                                                    "([switch_ops] live_port = false)")
    try:
        p = P.resolve(engine, sid, ifindex)
    except ActionRefused as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    try:
        data = await hub(request).read(p)
    except LiveCapReached as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    macs = data["fdb"]["macs"]
    ident: dict[str, dict] = {}
    if macs:
        names = {f"m{i}": m for i, m in enumerate(macs[:256])}
        rows = db.fetch_all(
            engine,
            "SELECT mac, computername, owner, role, ip, vendor, dot1x_user FROM pf_nodes "
            f"WHERE mac IN ({', '.join(':' + k for k in names)})", names)
        ident = {r["mac"]: dict(r) for r in rows}
    data["fdb"]["macs"] = [{"mac": m, **{k: v for k, v in ident.get(m, {}).items() if k != "mac"}}
                           for m in macs]
    data["port"] = {"device_id": p.device_id, "switch": p.switch_name, "ifindex": p.ifindex,
                    "name": p.name, "poe_capable": p.poe_capable}
    return data
