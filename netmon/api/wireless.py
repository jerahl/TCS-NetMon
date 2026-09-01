"""Wireless API (spec 10 §6, Phase 10.2) — read-only, viewer role, DB-only.

Serves the 011 wireless tables the XIQ collector cycles write. Zero source
calls at render time; every list carries row ``updated_at`` so the UI badges
staleness honestly. Fleet aggregates are SQL over the tables, not extra XIQ
calls (spec §3).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
import re
from typing import Any

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


# MAC spellings differ per source: ap_details.mgmt_mac arrives from XIQ
# unpunctuated ("bcf310163600"), while fdb_entries and pf_nodes store the
# colon form. Joining raw matched 0 of 783 APs; normalising matches 741.
_MACN = "LOWER(REPLACE(REPLACE(REPLACE({}, ':', ''), '-', ''), '.', ''))"

_AP_UPLINK_SQL = f"""
SELECT f.device_id AS switch_device_id, sw.name AS switch_name, sw.site AS switch_site,
       f.ifindex AS ifindex, sp.name AS port, sp.poe_delivering AS poe_delivering,
       sp.poe_watts AS poe_watts, sp.is_sfp AS is_sfp, sp.speed_mbps AS speed_mbps,
       sp.oper_state AS oper_state, f.vlan_id AS vlan_id, f.updated_at AS updated_at,
       (SELECT COUNT(*) FROM fdb_entries f2
         WHERE f2.device_id = f.device_id AND f2.ifindex = f.ifindex) AS macs_on_port
FROM fdb_entries f
JOIN devices sw ON sw.id = f.device_id
LEFT JOIN switch_ports sp ON sp.device_id = f.device_id AND sp.ifindex = f.ifindex
WHERE {_MACN.format('f.mac')} = :mac
ORDER BY macs_on_port ASC
"""


def _pf_port_form(port: Any) -> str | None:
    """PacketFence spells an Extreme stacked port "5035"; SNMP spells it "5:35"."""
    p = str(port or "").strip()
    if not p:
        return None
    if ":" in p:
        return p
    if p.isdigit() and len(p) >= 4:
        return f"{int(p[:-3])}:{int(p[-3:])}"
    return p


def _ap_uplink(engine: Engine, detail: dict, pf: dict | None = None) -> dict | None:
    """Which switch port an AP is plugged into, from the FDB.

    A MAC is learned on *every* port in its path, not just the access port:
    on this fleet an AP's MAC appears on a median of 5 ports and up to 14, and
    all but one of them are uplink trunks. Taking any FDB row would therefore
    point Cycle PoE at a 10G uplink carrying 168 MACs — bouncing a whole
    switch's worth of devices instead of one AP.

    The access port is the one carrying the fewest MACs, and two independent
    signals corroborate it: it should be copper (``is_sfp = 0``) and actually
    delivering PoE. Fleet-wide the fewest-MACs pick is PoE-delivering for 91%
    of APs and copper for 94%.

    ``poe_cycle_safe`` is that corroboration, and it gates the destructive
    action rather than the display: an uplink that cannot be confirmed is still
    shown (with its candidates) but must not be power-cycled on a guess.
    """
    mac = (detail or {}).get("mgmt_mac") or ""
    norm = re.sub(r"[^0-9a-f]", "", str(mac).lower())
    if len(norm) != 12:
        return None
    rows = [dict(r) for r in db.fetch_all(engine, _AP_UPLINK_SQL, {"mac": norm})]
    if not rows:
        return None
    best = rows[0]
    corroborated = best.get("poe_delivering") == 1 and best.get("is_sfp") == 0
    # A tie on MAC count means the fewest-MACs rule did not actually pick a
    # winner, so it is not evidence of anything.
    tied = len(rows) > 1 and rows[1].get("macs_on_port") == best.get("macs_on_port")
    # Second, independent source. PacketFence records the switch and port it
    # last saw the endpoint on, derived from RADIUS/SNMP traps rather than from
    # the FDB — so agreement is genuine corroboration, not the same evidence
    # counted twice. Across the fleet the two agree on 485 APs and disagree on
    # 32; every one of those 32 already failed the PoE/copper test, so this
    # check has never been the only thing standing between an operator and the
    # wrong port. It is here so that stays true when the fleet changes.
    pf_port = _pf_port_form((pf or {}).get("last_port"))
    own_port = _pf_port_form(best.get("port"))
    pf_agrees = None if not pf_port or not own_port else (pf_port == own_port)

    best["candidates"] = len(rows)
    best["pf_agrees"] = pf_agrees
    best["pf_port"] = pf_port
    best["poe_cycle_safe"] = bool(corroborated and not tied and pf_agrees is not False)
    best["why"] = (
        "PacketFence last saw this endpoint on a different port"
        if pf_agrees is False
        else "ambiguous — two ports tie on MAC count" if tied
        else "port is not confirmed as PoE-delivering copper, so it may be an uplink"
        if not corroborated
        else "fewest MACs on port, PoE-delivering copper"
        + (", confirmed by PacketFence" if pf_agrees else "")
    )
    return best


def _ap_pf_node(engine: Engine, mac: str | None) -> dict | None:
    """The AP's own PacketFence node row, if PF knows it.

    APs are endpoints to PF as much as laptops are: 745 of 783 resolve. This is
    what makes Reevaluate Access and the PF deep-link meaningful on an AP page.
    """
    norm = re.sub(r"[^0-9a-f]", "", str(mac or "").lower())
    if len(norm) != 12:
        return None
    row = db.fetch_one(
        engine,
        f"SELECT mac, computername, owner, role, reg_status, ip, vendor, os, "
        f"       vlan, last_switch, last_port, conn_method, online, last_seen, updated_at "
        f"FROM pf_nodes WHERE {_MACN.format('mac')} = :mac",
        {"mac": norm},
    )
    return dict(row) if row else None


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
    # ``clients`` is derived here, not read from ``ap_radios.clients`` — that
    # column is NULL on every row by design, because XIQ's radio payload
    # carries SSID descriptors rather than clients (see build_radio_rows). The
    # association lives on the client side, in ``interface_name``, so the count
    # is rolled up at read time the way ``ssids`` already does it. NULL still
    # renders "—": a radio with no clients reports 0, and a fleet where the
    # clients cycle has never run reports nothing rather than a false 0.
    out["radios"] = [dict(r) for r in db.fetch_all(
        engine,
        "SELECT r.radio, r.band, r.channel, r.width_mhz, r.tx_power_dbm, "
        "       r.util_pct, r.noise_dbm, r.updated_at, "
        "       (SELECT COUNT(*) FROM wireless_clients w "
        "         WHERE w.device_id = r.device_id AND w.radio = r.radio) AS clients "
        "FROM ap_radios r WHERE r.device_id = :d ORDER BY r.radio",
        {"d": device_id},
    )]
    out["pf"] = _ap_pf_node(engine, (out.get("detail") or {}).get("mgmt_mac"))
    out["uplink"] = _ap_uplink(engine, out.get("detail") or {}, out["pf"])
    out["clients"] = [dict(r) for r in db.fetch_all(
        engine,
        "SELECT w.mac, w.ssid, w.band, w.rssi_dbm, w.snr_db, w.os, w.hostname, "
        "w.username, w.ip, w.connected_since, w.updated_at, "
        "p.owner AS pf_owner, p.role AS pf_role, p.reg_status AS pf_status "
        "FROM wireless_clients w LEFT JOIN pf_nodes p ON p.mac = w.mac "
        "WHERE w.device_id = :d ORDER BY w.ssid, w.mac",
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
