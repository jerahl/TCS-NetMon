"""Surveillance (Milestone) API — Phase 10.4: read-only, viewer role, DB-only.

Serves the 013 camera/recording-server tables + `milestone.overview`
snapshot. The camera's "Linked Switch Port" is the FDB payoff computed at
query time: `cameras.mac ⋈ fdb_entries` → switch + port, zero source calls.
Live alarms need the Events/State WebSocket (⛔ D5); until then the Alarms
view is NetMon alerts scoped to surveillance devices (served from /api/alerts).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import get_engine, require_role
from netmon.models.schemas import Role
from netmon.snapshots import read_snapshot

router = APIRouter(prefix="/api/surveillance", tags=["surveillance"])


@router.get("/summary")
def summary(engine: Engine = Depends(get_engine), _user=Depends(require_role(Role.viewer))) -> dict:
    cam = db.fetch_one(
        engine,
        "SELECT COUNT(*) AS total, "
        " SUM(CASE WHEN c.enabled = 1 THEN 1 ELSE 0 END) AS enabled, "
        " MAX(c.updated_at) AS updated_at FROM cameras c") or {}
    # Recording state comes from device_state (the state machine), not cameras.enabled.
    rec = {r["value"]: r["n"] for r in db.fetch_all(
        engine, "SELECT value, COUNT(*) AS n FROM device_state "
                "WHERE dimension = 'recording' GROUP BY value")}
    srv = db.fetch_one(
        engine, "SELECT COUNT(*) AS total, SUM(storage_used_gb) AS used, "
                "SUM(storage_total_gb) AS total_gb FROM recording_servers") or {}
    srv_up = {r["value"]: r["n"] for r in db.fetch_all(
        engine, "SELECT value, COUNT(*) AS n FROM device_state d "
                "JOIN recording_servers rs ON rs.device_id = d.device_id "
                "WHERE d.dimension = 'source_status' GROUP BY value")}
    return {
        "cameras_total": cam.get("total") or 0,
        "cameras_recording": rec.get("up", 0),
        "cameras_not_recording": rec.get("down", 0),
        "cameras_blind": rec.get("blind", 0),
        "servers_total": srv.get("total") or 0,
        "servers_up": srv_up.get("up", 0),
        "servers_down": srv_up.get("down", 0) + srv_up.get("blind", 0),
        "storage_used_gb": round(srv.get("used") or 0, 1),
        "storage_total_gb": round(srv.get("total_gb") or 0, 1),
        "overview": read_snapshot(engine, "milestone.overview"),
        "updated_at": cam.get("updated_at"),
    }


_CAMERA_COLS = ("c.device_id, d.name, d.site, c.model, c.resolution, c.fps_target, "
                "c.codec, c.recording_mode, c.state_msg, c.ip, c.mac, c.enabled, "
                "c.recording_server_device_id, c.updated_at, "
                "rs.name AS recording_server, "
                "st.value AS recording_state")

_CAMERA_FROM = ("FROM cameras c JOIN devices d ON d.id = c.device_id "
                "LEFT JOIN devices rs ON rs.id = c.recording_server_device_id "
                "LEFT JOIN device_state st ON st.device_id = c.device_id AND st.dimension = 'recording'")


@router.get("/cameras")
def cameras(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
    q: str | None = None,
    site: str | None = None,
) -> list[dict]:
    conds, params = [], {}
    if q:
        conds.append("(d.name LIKE :q OR c.ip LIKE :q OR c.model LIKE :q OR c.mac LIKE :q)")
        params["q"] = f"%{q}%"
    if site:
        conds.append("d.site = :site")
        params["site"] = site
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    return [dict(r) for r in db.fetch_all(
        engine, f"SELECT {_CAMERA_COLS} {_CAMERA_FROM} {where} ORDER BY d.site, d.name", params)]


@router.get("/cameras/{device_id}")
def camera_detail(
    device_id: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    row = db.fetch_one(
        engine, f"SELECT {_CAMERA_COLS} {_CAMERA_FROM} WHERE c.device_id = :d", {"d": device_id})
    if row is None:
        raise HTTPException(status_code=404, detail="camera not found")
    out = dict(row)
    # Linked switch port via FDB (the marquee join): the camera's MAC learned
    # on a switch port → switch name + port. Zero source calls.
    out["switch_port"] = None
    if out.get("mac"):
        out["switch_port"] = db.fetch_one(
            engine,
            "SELECT d.name AS switch, sp.name AS port, f.updated_at "
            "FROM fdb_entries f JOIN devices d ON d.id = f.device_id "
            "LEFT JOIN switch_ports sp ON sp.device_id = f.device_id AND sp.ifindex = f.ifindex "
            "WHERE f.mac = :mac ORDER BY f.updated_at DESC LIMIT 1",
            {"mac": out["mac"]})
    return out


@router.get("/servers")
def servers(engine: Engine = Depends(get_engine), _user=Depends(require_role(Role.viewer))) -> list[dict]:
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT rs.device_id, d.name, d.site, rs.hostname, rs.role, rs.version, "
        "rs.chans_total, rs.chans_recording, rs.storage_used_gb, rs.storage_total_gb, "
        "rs.retention_days, rs.updated_at, st.value AS status "
        "FROM recording_servers rs JOIN devices d ON d.id = rs.device_id "
        "LEFT JOIN device_state st ON st.device_id = rs.device_id AND st.dimension = 'source_status' "
        "ORDER BY d.site, d.name")]


@router.get("/storage")
def storage(engine: Engine = Depends(get_engine), _user=Depends(require_role(Role.viewer))) -> list[dict]:
    """Per-server storage volumes (the subset the Config API exposes)."""
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT d.name, rs.hostname, rs.storage_used_gb, rs.storage_total_gb, "
        "rs.retention_days, rs.updated_at FROM recording_servers rs "
        "JOIN devices d ON d.id = rs.device_id "
        "WHERE rs.storage_total_gb IS NOT NULL ORDER BY d.name")]
