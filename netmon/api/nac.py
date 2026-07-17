"""NAC (PacketFence) API — Phase 10.3: served from NetMon's DB.

``pf_nodes`` (replace-on-refresh, 5 min cadence) + ``snapshot_cache`` keys.
The Phase 5 in-memory snapshot is gone; zero PF calls at render time. Every
response carries freshness so the UI badges staleness honestly.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import get_engine, require_role
from netmon.macmatch import mac_expr, mac_norm
from netmon.models.schemas import Role
from netmon.snapshots import read_snapshot

router = APIRouter(tags=["nac"])

_NODE_COLS = ("mac, computername, ip, vendor, os, device_type, owner, role, "
              "reg_status, vlan, last_switch, last_port, last_ssid, conn_method, "
              "conn_sub, dot1x_user, last_seen, online, updated_at")


def _freshness(engine: Engine):
    row = db.fetch_one(engine, "SELECT MAX(updated_at) AS t, COUNT(*) AS n FROM pf_nodes")
    return (row or {}).get("t"), (row or {}).get("n") or 0


@router.get("/api/nac")
def nac_summary(
    request: Request,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    updated_at, total = _freshness(engine)
    cfg = request.app.state.config
    if total == 0 and not cfg.source_enabled("packetfence"):
        return {"enabled": False}
    by_status = {(r["reg_status"] or "unknown"): r["n"] for r in db.fetch_all(
        engine, "SELECT reg_status, COUNT(*) AS n FROM pf_nodes GROUP BY reg_status")}
    by_role = [dict(r) for r in db.fetch_all(
        engine, "SELECT role, COUNT(*) AS n FROM pf_nodes WHERE role IS NOT NULL "
                "GROUP BY role ORDER BY n DESC LIMIT 10")]
    auth_split = [dict(r) for r in db.fetch_all(
        engine, "SELECT conn_method, COUNT(*) AS n FROM pf_nodes "
                "WHERE online = 1 AND conn_method IS NOT NULL "
                "GROUP BY conn_method ORDER BY n DESC")]
    rejects = read_snapshot(engine, "pf.rejects")
    return {
        "enabled": True,
        "total": total,
        "registered": by_status.get("reg", 0),
        "unregistered": by_status.get("unreg", 0),
        "pending": by_status.get("pending", 0),
        "by_status": by_status,
        "online": db.fetch_one(engine, "SELECT COUNT(*) AS n FROM pf_nodes WHERE online = 1")["n"],
        "by_role": by_role,
        "auth_split": auth_split,
        "rejects": rejects,
        "updated_at": updated_at,
    }


@router.get("/api/nac/nodes")
def nac_nodes(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
    q: str | None = None,
    role: str | None = None,
    status: str | None = None,
    online: bool | None = None,
    limit: int = 200,
) -> list[dict]:
    limit = max(1, min(limit, 1000))
    conds, params = [], {"limit": limit}
    if q:
        # MAC matched separator-agnostically (bcf310be9980 == bc:f3:10:…); the
        # text columns keep the plain substring match.
        text_cols = "computername LIKE :q OR owner LIKE :q OR ip LIKE :q OR dot1x_user LIKE :q"
        norm = mac_norm(q)
        if norm:
            conds.append(f"({text_cols} OR {mac_expr('mac')} LIKE :macq)")
            params["macq"] = f"%{norm}%"
        else:
            conds.append(f"(mac LIKE :q OR {text_cols})")
        params["q"] = f"%{q}%"
    if role:
        conds.append("role = :role")
        params["role"] = role
    if status:
        conds.append("reg_status = :status")
        params["status"] = status
    if online is not None:
        conds.append("online = :online")
        params["online"] = 1 if online else 0
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    return [dict(r) for r in db.fetch_all(
        engine,
        f"SELECT {_NODE_COLS} FROM pf_nodes {where} "
        f"ORDER BY online DESC, last_seen DESC LIMIT :limit",
        params,
    )]


@router.get("/api/nac/sessions")
def nac_sessions(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
    limit: int = 500,
) -> dict:
    """Active (open-locationlog) sessions + auth split + the reject tail."""
    limit = max(1, min(limit, 2000))
    rows = [dict(r) for r in db.fetch_all(
        engine,
        f"SELECT {_NODE_COLS} FROM pf_nodes WHERE online = 1 "
        f"ORDER BY last_seen DESC LIMIT :limit",
        {"limit": limit},
    )]
    auth_split = [dict(r) for r in db.fetch_all(
        engine, "SELECT conn_method, conn_sub, COUNT(*) AS n FROM pf_nodes "
                "WHERE online = 1 GROUP BY conn_method, conn_sub ORDER BY n DESC")]
    updated_at, _ = _freshness(engine)
    return {"sessions": rows, "auth_split": auth_split,
            "rejects": read_snapshot(engine, "pf.rejects"), "updated_at": updated_at}


@router.get("/api/nac/quarantine")
def nac_quarantine(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    """Non-registered nodes + the violation (security-event) catalog. No
    release buttons — write actions are D4-gated (render nothing here)."""
    rows = [dict(r) for r in db.fetch_all(
        engine,
        f"SELECT {_NODE_COLS} FROM pf_nodes "
        f"WHERE reg_status IS NOT NULL AND reg_status != 'reg' "
        f"ORDER BY last_seen DESC LIMIT 500",
    )]
    updated_at, _ = _freshness(engine)
    return {"nodes": rows, "violations": read_snapshot(engine, "pf.violations"),
            "updated_at": updated_at}


@router.get("/api/nac/policies")
def nac_policies(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    """Read-only render of the PF configuration snapshots."""
    return {
        "sources": read_snapshot(engine, "pf.sources"),
        "profiles": read_snapshot(engine, "pf.profiles"),
        "violations": read_snapshot(engine, "pf.violations"),
    }


@router.get("/api/nac/cluster")
def nac_cluster(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    return {
        "cluster": read_snapshot(engine, "pf.cluster"),
        "services": read_snapshot(engine, "pf.services"),
        "queues": read_snapshot(engine, "pf.queues"),
    }
