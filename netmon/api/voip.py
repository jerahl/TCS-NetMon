"""VoIP (3CX) API — Phase 10.4: read-only, viewer role, DB-only.

Serves the 013 trunks/extensions tables + `threecx.system` snapshot. Active
calls / MOS / queues depend on the Phase 0 3CX-ODBC decision and are not
persisted here (spec §7).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import get_engine, require_role
from netmon.models.schemas import Role
from netmon.snapshots import read_snapshot

router = APIRouter(prefix="/api/voip", tags=["voip"])


@router.get("/summary")
def summary(engine: Engine = Depends(get_engine), _user=Depends(require_role(Role.viewer))) -> dict:
    trunks = db.fetch_one(
        engine,
        "SELECT COUNT(*) AS total, "
        " SUM(CASE WHEN reg_status = 'registered' THEN 1 ELSE 0 END) AS registered, "
        " SUM(ch_in_use) AS ch_in_use, SUM(ch_total) AS ch_total, "
        " MAX(updated_at) AS updated_at FROM trunks") or {}
    ext = db.fetch_one(
        engine,
        "SELECT COUNT(*) AS total, "
        " SUM(CASE WHEN registered = 1 THEN 1 ELSE 0 END) AS registered FROM extensions") or {}
    return {
        "trunks_total": trunks.get("total") or 0,
        "trunks_registered": trunks.get("registered") or 0,
        "channels_in_use": trunks.get("ch_in_use") or 0,
        "channels_total": trunks.get("ch_total") or 0,
        "extensions_total": ext.get("total") or 0,
        "extensions_registered": ext.get("registered") or 0,
        "system": read_snapshot(engine, "threecx.system"),
        "updated_at": trunks.get("updated_at"),
    }


@router.get("/trunks")
def trunks(engine: Engine = Depends(get_engine), _user=Depends(require_role(Role.viewer))) -> list[dict]:
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT t.device_id, d.name AS device_name, t.name, t.provider_host, t.did, "
        "t.reg_status, t.ch_total, t.ch_in_use, t.updated_at, "
        "st.value AS trunk_state FROM trunks t JOIN devices d ON d.id = t.device_id "
        "LEFT JOIN device_state st ON st.device_id = t.device_id AND st.dimension = 'trunk' "
        "ORDER BY t.name")]


@router.get("/extensions")
def extensions(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
    q: str | None = None,
    registered: bool | None = None,
) -> list[dict]:
    conds, params = [], {}
    if q:
        conds.append("(ext LIKE :q OR name LIKE :q OR site LIKE :q)")
        params["q"] = f"%{q}%"
    if registered is not None:
        conds.append("registered = :reg")
        params["reg"] = 1 if registered else 0
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    return [dict(r) for r in db.fetch_all(
        engine,
        f"SELECT ext, name, site, registered, dnd, updated_at FROM extensions "
        f"{where} ORDER BY ext", params)]
