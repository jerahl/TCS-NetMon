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
from netmon.state import REACHABILITY_FLAGS_SQL, device_down, device_reachable

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
    """Switches with a port-state roll-up + reachability for the navigator.

    ``status`` is the switch's own up/down (``up|down|unknown``), derived from
    the same predicates the site roll-up uses (netmon.state) so the navigator
    and the site cards can never disagree about whether a switch is down. It is
    deliberately separate from the port counts: a reachable switch with every
    access port idle is healthy, not down.
    """
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
    flags = {
        r["device_id"]: dict(r)
        for r in db.fetch_all(
            engine,
            f"SELECT d.id AS device_id,\n{REACHABILITY_FLAGS_SQL}\n"
            "FROM devices d "
            "LEFT JOIN device_state s ON s.device_id = d.id "
            "WHERE d.device_type = 'switch' AND d.enabled = 1 "
            "GROUP BY d.id",
        )
    }
    out = []
    for r in rows:
        sw = dict(r)
        f = flags.get(sw["id"], {})
        if not f.get("has_state") or not device_reachable(f):
            sw["status"] = "unknown"   # no reading — must never render as up
        elif device_down(f):
            sw["status"] = "down"
        else:
            sw["status"] = "up"
        # Which dimension carried the verdict, so the UI can explain itself.
        sw["status_source"] = (
            "ping" if (f.get("ping_up") or f.get("ping_down"))
            else "snmp" if f.get("snmp_up")
            else "source" if (f.get("source_up") or f.get("source_down"))
            else None
        )
        out.append(sw)
    return out


@router.get("/{sid}")
def switch_detail(
    sid: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    sw = _switch_or_404(engine, sid)
    sw["stack"] = [dict(r) for r in db.fetch_all(
        engine,
        "SELECT slot, role, status, model, serial, fw_version, uptime_s, cpu_pct, mem_pct, "
        "temp_c, fans, psus, warn_msg, "
        "poe_status, poe_budget_w, poe_alloc_w, poe_avail_w, poe_capacity_w, "
        "poe_measured_w, updated_at FROM stack_members "
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
        "SELECT ifindex, name, member, oper_state, admin_up, speed_mbps, duplex, is_sfp, "
        "poe_admin, poe_delivering, poe_class, poe_watts, in_kbps, out_kbps, util_pct, "
        "err_in_delta, err_out_delta, disc_in_delta, disc_out_delta, updated_at "
        "FROM switch_ports WHERE device_id = :d ORDER BY member, ifindex",
        {"d": sid},
    )]


# How many learned MACs make a port look like an uplink rather than an access
# port. An access port carries the endpoint and usually its phone; a trunk
# carries everything beyond it. Cycling PoE on a trunk is how one click takes
# out a wiring closet, so past this count the confirm step has to say so.
UPLINK_MAC_HINT = 8


def _poe_cycle_advice(port: dict, mac_count: int) -> dict:
    """Whether Cycle PoE makes sense on this port, and what to warn about.

    Unlike the AP page — where NetMon *infers* which port to bounce and must
    refuse when it cannot corroborate (see netmon.api.wireless._ap_uplink) — the
    operator picks this port explicitly off the faceplate. So the job here is
    not to guess but to stop two specific mistakes:

    * **A port with no PoE.** The rConfig snippet would run against a port that
      cannot power anything: at best a no-op, at worst an unexplained config
      push. SFP cages are the common case.
    * **A port that is really an uplink.** Nothing forbids power-cycling one,
      and occasionally it is what you want, so this warns rather than blocks —
      but an operator should not discover it from the outage.
    """
    poe_known = port.get("poe_admin") is not None or port.get("poe_delivering") is not None
    has_poe = bool(port.get("poe_delivering")) or bool(port.get("poe_admin"))
    if port.get("is_sfp") == 1:
        return {"available": False,
                "reason": "SFP/fiber port — it carries no PoE to cycle"}
    if poe_known and not has_poe:
        return {"available": False,
                "reason": "this port is not configured for PoE, so cycling it would do nothing"}
    warn = None
    if mac_count >= UPLINK_MAC_HINT:
        warn = (f"{mac_count} MACs are learned here — this looks like an uplink, "
                f"not an access port. Cycling it will drop everything behind it.")
    return {"available": True, "reason": None, "warn": warn,
            "unverified": not poe_known}


@router.get("/{sid}/ports/{ifindex}")
def port_detail(
    sid: int,
    ifindex: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    """One port plus the MAC addresses learned on it, each enriched with
    PacketFence identity via ``fdb_entries ⋈ pf_nodes ON mac`` — the design's
    marquee port-detail feature (spec 10 §3), pure SQL, zero source calls."""
    _switch_or_404(engine, sid)
    port = db.fetch_one(
        engine,
        "SELECT ifindex, name, member, oper_state, admin_up, speed_mbps, duplex, is_sfp, "
        "poe_admin, poe_delivering, poe_class, poe_watts, in_kbps, out_kbps, util_pct, "
        "err_in_delta, err_out_delta, disc_in_delta, disc_out_delta, updated_at "
        "FROM switch_ports WHERE device_id = :d AND ifindex = :i",
        {"d": sid, "i": ifindex},
    )
    if port is None:
        raise HTTPException(status_code=404, detail="port not found")
    macs = [dict(r) for r in db.fetch_all(
        engine,
        "SELECT f.mac, f.vlan_id, f.updated_at, "
        " p.computername, p.owner, p.role, p.reg_status, p.os, p.vendor, "
        " p.ip AS pf_ip, p.dot1x_user, p.updated_at AS pf_updated_at "
        "FROM fdb_entries f LEFT JOIN pf_nodes p ON p.mac = f.mac "
        "WHERE f.device_id = :d AND f.ifindex = :i ORDER BY f.mac",
        {"d": sid, "i": ifindex},
    )]
    return {"port": dict(port), "macs": macs,
            "poe_cycle": _poe_cycle_advice(dict(port), len(macs))}


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


@router.get("/{sid}/neighbors")
def switch_neighbors(
    sid: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    """Discovered neighbors (EDP on this Extreme fleet — spec 10 §4). The
    local port name is joined from switch_ports so the UI shows "1:24", not a
    bare ifIndex."""
    _switch_or_404(engine, sid)
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT n.local_ifindex, sp.name AS local_port, n.remote_sysname, "
        "n.remote_port, n.remote_sysdesc, n.remote_chassis, n.protocol, n.age_s, "
        "n.updated_at FROM neighbors n "
        "LEFT JOIN switch_ports sp ON sp.device_id = n.device_id AND sp.ifindex = n.local_ifindex "
        "WHERE n.device_id = :d ORDER BY n.local_ifindex",
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


@router.get("/{sid}/backups")
def switch_backups(
    sid: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    """rConfig backup metadata (spec 10 §6) — list only; the diff pane is a
    user-initiated read-through or link-out (§10 Q5), never a render-loop
    fetch. Rows are written by the rconfig collector into `config_backups`."""
    _switch_or_404(engine, sid)
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT taken_at, size_bytes, hash, note, updated_at "
        "FROM config_backups WHERE device_id = :d ORDER BY taken_at DESC",
        {"d": sid},
    )]
