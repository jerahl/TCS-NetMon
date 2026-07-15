"""Switch inventory API (spec 10 §6) — read-only, viewer role, DB-only.

Serves the 006 SNMP-inventory tables the Switches dashboard reads at render
time. Zero source calls: the sweep collector (netmon.poller.snmp_inventory)
is the only writer. Every row carries ``updated_at`` so the UI can badge
staleness honestly.

The FDB⋈PacketFence identity join the port-detail pane wants (spec §3 marquee
feature) lands with `pf_nodes` in Phase 10.3; until then the port detail
returns the raw MAC list on the port and enriches when `pf_nodes` exists.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import get_engine, require_role
from netmon.models.schemas import Role

router = APIRouter(prefix="/api/switches", tags=["switches"])


def _switch_or_404(engine: Engine, sid: int) -> dict:
    row = db.fetch_one(
        engine,
        "SELECT id, name, site, mgmt_ip, enabled FROM devices "
        "WHERE id = :id AND device_type = 'switch'",
        {"id": sid},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="switch not found")
    return dict(row)


@router.get("")
def list_switches(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    """Switches with a port-state roll-up for the navigator/KPI strip."""
    rows = db.fetch_all(
        engine,
        "SELECT d.id, d.name, d.site, d.mgmt_ip, "
        "  COUNT(p.ifindex) AS ports_total, "
        "  SUM(CASE WHEN p.oper_state = 'up' THEN 1 ELSE 0 END) AS ports_up, "
        "  MAX(p.updated_at) AS ports_updated_at "
        "FROM devices d "
        "LEFT JOIN switch_ports p ON p.device_id = d.id "
        "WHERE d.device_type = 'switch' AND d.enabled = 1 "
        "GROUP BY d.id, d.name, d.site, d.mgmt_ip "
        "ORDER BY d.site, d.name",
    )
    return [dict(r) for r in rows]


@router.get("/{sid}")
def switch_detail(
    sid: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    sw = _switch_or_404(engine, sid)
    sw["stack"] = [dict(r) for r in db.fetch_all(
        engine,
        "SELECT slot, role, status, serial, fw_version, uptime_s, cpu_pct, mem_pct, "
        "temp_c, fans, psus, warn_msg, updated_at FROM stack_members "
        "WHERE device_id = :d ORDER BY slot",
        {"d": sid},
    )]
    return sw


@router.get("/{sid}/ports")
def switch_ports(
    sid: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    _switch_or_404(engine, sid)
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT ifindex, name, member, oper_state, admin_up, speed_mbps, duplex, "
        "poe_admin, poe_delivering, poe_class, poe_watts, in_kbps, out_kbps, util_pct, "
        "err_in_delta, err_out_delta, disc_in_delta, disc_out_delta, updated_at "
        "FROM switch_ports WHERE device_id = :d ORDER BY member, ifindex",
        {"d": sid},
    )]


@router.get("/{sid}/ports/{ifindex}")
def port_detail(
    sid: int,
    ifindex: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    """One port plus the MAC addresses learned on it (the FDB payoff). PF
    identity enrichment is added when `pf_nodes` exists (Phase 10.3)."""
    _switch_or_404(engine, sid)
    port = db.fetch_one(
        engine,
        "SELECT ifindex, name, member, oper_state, admin_up, speed_mbps, duplex, "
        "poe_admin, poe_delivering, poe_class, poe_watts, in_kbps, out_kbps, util_pct, "
        "err_in_delta, err_out_delta, disc_in_delta, disc_out_delta, updated_at "
        "FROM switch_ports WHERE device_id = :d AND ifindex = :i",
        {"d": sid, "i": ifindex},
    )
    if port is None:
        raise HTTPException(status_code=404, detail="port not found")
    macs = [dict(r) for r in db.fetch_all(
        engine,
        "SELECT mac, vlan_id, updated_at FROM fdb_entries "
        "WHERE device_id = :d AND ifindex = :i ORDER BY mac",
        {"d": sid, "i": ifindex},
    )]
    return {"port": dict(port), "macs": macs}


@router.get("/{sid}/fdb")
def switch_fdb(
    sid: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    _switch_or_404(engine, sid)
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT mac, vlan_id, ifindex, first_seen, updated_at FROM fdb_entries "
        "WHERE device_id = :d ORDER BY ifindex, mac",
        {"d": sid},
    )]


@router.get("/{sid}/lldp")
def switch_lldp(
    sid: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    _switch_or_404(engine, sid)
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT local_ifindex, remote_sysname, remote_port, remote_sysdesc, "
        "remote_chassis, updated_at FROM lldp_neighbors "
        "WHERE device_id = :d ORDER BY local_ifindex",
        {"d": sid},
    )]


@router.get("/{sid}/vlans")
def switch_vlans(
    sid: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    _switch_or_404(engine, sid)
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT vlan_id, name, admin_up, untagged_count, tagged_count, updated_at "
        "FROM switch_vlans WHERE device_id = :d ORDER BY vlan_id",
        {"d": sid},
    )]
