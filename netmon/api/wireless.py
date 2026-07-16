"""Wireless API (spec 10 §6, Phase 10.2) — read-only, viewer role, DB-only.

Serves the 011 wireless tables the XIQ collector cycles write. Zero source
calls at render time; every list carries row ``updated_at`` so the UI badges
staleness honestly. Fleet aggregates are SQL over the tables, not extra XIQ
calls (spec §3).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import get_engine, require_role
from netmon.models.schemas import Role

router = APIRouter(prefix="/api/wireless", tags=["wireless"])

_AP_LIST_SQL = """
SELECT d.id, d.name, d.site, d.mgmt_ip,
       s.value AS status, s.updated_at AS status_updated_at,
       a.model, a.serial, a.fw_version, a.ip, a.network_policy,
       a.uptime_s, a.clients_total, a.updated_at
FROM devices d
LEFT JOIN ap_details a ON a.device_id = d.id
LEFT JOIN device_state s ON s.device_id = d.id AND s.dimension = 'source_status'
WHERE d.device_type = 'ap' AND d.enabled = 1
ORDER BY d.site, d.name
"""


@router.get("/summary")
def wireless_summary(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    aps = db.fetch_all(
        engine,
        "SELECT s.value AS status, COUNT(*) AS n FROM devices d "
        "LEFT JOIN device_state s ON s.device_id = d.id AND s.dimension = 'source_status' "
        "WHERE d.device_type = 'ap' AND d.enabled = 1 GROUP BY s.value",
    )
    by_status = {(r["status"] or "unknown"): r["n"] for r in aps}
    bands = db.fetch_all(
        engine,
        "SELECT band, COUNT(*) AS n FROM wireless_clients GROUP BY band",
    )
    fw = db.fetch_all(
        engine,
        "SELECT fw_version, COUNT(*) AS n FROM ap_details "
        "WHERE fw_version IS NOT NULL GROUP BY fw_version ORDER BY n DESC",
    )
    top_ssids = db.fetch_all(
        engine,
        "SELECT ssid, COUNT(*) AS n FROM wireless_clients "
        "WHERE ssid IS NOT NULL GROUP BY ssid ORDER BY n DESC LIMIT 8",
    )
    freshness = db.fetch_one(
        engine,
        "SELECT MAX(updated_at) AS details, "
        " (SELECT MAX(updated_at) FROM wireless_clients) AS clients FROM ap_details",
    ) or {}
    return {
        "aps_total": sum(by_status.values()),
        "aps_up": by_status.get("up", 0),
        "aps_down": by_status.get("down", 0),
        "aps_blind": by_status.get("blind", 0),
        "clients_total": db.fetch_one(
            engine, "SELECT COUNT(*) AS n FROM wireless_clients")["n"],
        "clients_by_band": {(r["band"] or "?"): r["n"] for r in bands},
        "firmware": [dict(r) for r in fw],
        "top_ssids": [dict(r) for r in top_ssids],
        "details_updated_at": freshness.get("details"),
        "clients_updated_at": freshness.get("clients"),
    }


@router.get("/aps")
def list_aps(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    return [dict(r) for r in db.fetch_all(engine, _AP_LIST_SQL)]


@router.get("/aps/{device_id}")
def ap_detail(
    device_id: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    dev = db.fetch_one(
        engine,
        "SELECT id, name, site, device_type, mgmt_ip FROM devices WHERE id = :d",
        {"d": device_id},
    )
    if dev is None:
        raise HTTPException(status_code=404, detail="device not found")
    out = dict(dev)
    detail = db.fetch_one(
        engine, "SELECT * FROM ap_details WHERE device_id = :d", {"d": device_id})
    out["detail"] = dict(detail) if detail else None
    out["radios"] = [dict(r) for r in db.fetch_all(
        engine,
        "SELECT radio, band, channel, width_mhz, tx_power_dbm, util_pct, noise_dbm, "
        "clients, updated_at FROM ap_radios WHERE device_id = :d ORDER BY radio",
        {"d": device_id},
    )]
    out["clients"] = [dict(r) for r in db.fetch_all(
        engine,
        "SELECT mac, ssid, band, rssi_dbm, snr_db, os, hostname, username, ip, "
        "connected_since, updated_at FROM wireless_clients "
        "WHERE device_id = :d ORDER BY ssid, mac",
        {"d": device_id},
    )]
    return out


@router.get("/ssids")
def list_ssids(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    """SSIDs with client counts rolled up at read time (spec §3 — counts are
    derived, never stored)."""
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT s.name, s.auth, s.enabled, s.network_policy, s.updated_at, "
        " (SELECT COUNT(*) FROM wireless_clients w WHERE w.ssid = s.name) AS clients "
        "FROM ssids s ORDER BY clients DESC, s.name",
    )]


@router.get("/clients")
def list_clients(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
    q: str | None = None,
    limit: int = 200,
) -> list[dict]:
    limit = max(1, min(limit, 1000))
    params: dict = {"limit": limit}
    where = ""
    if q:
        where = ("WHERE w.mac LIKE :q OR w.hostname LIKE :q OR w.username LIKE :q "
                 "OR w.ssid LIKE :q OR w.ip LIKE :q")
        params["q"] = f"%{q}%"
    return [dict(r) for r in db.fetch_all(
        engine,
        f"SELECT w.mac, w.ssid, w.band, w.rssi_dbm, w.snr_db, w.os, w.hostname, "
        f"w.username, w.ip, w.connected_since, w.updated_at, "
        f"w.device_id, d.name AS ap_name, d.site "
        f"FROM wireless_clients w LEFT JOIN devices d ON d.id = w.device_id "
        f"{where} ORDER BY w.ssid, w.mac LIMIT :limit",
        params,
    )]
