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
from netmon.uplink import uplink_for_mac

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
        # `used` stays None when unknown — never 0. The Config API exposes
        # configured size but not consumed space (that is the WinRM dependency,
        # OpenProject #111), and `or 0` here would let the UI divide a real
        # 1.8 PB total by a fabricated zero and report "0% used" across the
        # estate. An honest gap beats a confident wrong number (§4.5).
        "storage_used_gb": None if srv.get("used") is None else round(srv["used"], 1),
        "storage_total_gb": round(srv.get("total_gb") or 0, 1),
        "storage_used_known": srv.get("used") is not None,
        # Per-tier camera counts, so the filter chips can carry their own
        # numbers rather than the UI counting a list it has not fetched yet.
        "cameras_by_status": _camera_status_counts(engine),
        "overview": read_snapshot(engine, "milestone.overview"),
        "updated_at": cam.get("updated_at"),
        # Environment facts the header and the XProtect roll-up show, lifted out
        # of the overview blob so the page reads fields rather than digging
        # through a payload. None where Milestone does not expose it — the page
        # renders "—" and says why (spec 20 §4).
        **_environment(engine),
    }


def _environment(engine: Engine) -> dict:
    """Management server, XProtect version and device-licence counts.

    All three come from the `milestone.overview` snapshot the collector writes
    (`/sites` and `/licenseDetails`). There is deliberately no
    `license_total`: XProtect Professional+ licenses per activated device, so
    the "used of total" ratio ZCD draws as a bar does not exist in either
    licence response. `license_activated` with `license_not_licensed` beside it
    is the whole truth available.
    """
    snap = read_snapshot(engine, "milestone.overview") or {}
    p = snap.get("payload") or {}
    return {
        "management_server": p.get("management_server"),
        "version": p.get("version"),
        "license_product": p.get("license_product"),
        "license_activated": p.get("license_activated"),
        "license_not_licensed": p.get("license_not_licensed"),
    }


_CAMERA_COLS = ("c.device_id, d.name, d.site, c.model, c.resolution, c.fps_target, "
                "c.codec, c.recording_mode, c.state_msg, c.ip, c.mac, c.enabled, "
                "c.recording_server_device_id, c.updated_at, "
                "rs.name AS recording_server, "
                "st.value AS recording_state, "
                # What Milestone's Events/State interface says about the camera
                # (spec 19 §12), and the derived tier that says whether ICMP
                # agrees (§13). Both are needed: "down" alone cannot distinguish
                # a dead camera from one the platform simply cannot reach.
                "src.value AS source_status, "
                "reach.value AS reachability")

_CAMERA_FROM = ("FROM cameras c JOIN devices d ON d.id = c.device_id "
                "LEFT JOIN devices rs ON rs.id = c.recording_server_device_id "
                "LEFT JOIN device_state st ON st.device_id = c.device_id AND st.dimension = 'recording' "
                "LEFT JOIN device_state src ON src.device_id = c.device_id "
                "  AND src.dimension = 'source_status' "
                "LEFT JOIN device_state reach ON reach.device_id = c.device_id "
                "  AND reach.dimension = 'reachability'")


def _camera_status_counts(engine: Engine) -> dict:
    """Cameras per reachability tier, plus the blind count.

    `blind` is tracked separately from the tiers because it is the source
    saying "I cannot tell", not a verdict — folding it into `down` would report
    an outage NetMon has no evidence for (spec 19 §13).
    """
    out = {r["tier"] or "unknown": r["n"] for r in db.fetch_all(
        engine,
        "SELECT reach.value AS tier, COUNT(*) AS n FROM cameras c "
        "JOIN devices d ON d.id = c.device_id "
        "LEFT JOIN device_state reach ON reach.device_id = c.device_id "
        "  AND reach.dimension = 'reachability' "
        "WHERE d.enabled = 1 GROUP BY reach.value")}
    out["blind"] = db.fetch_one(
        engine,
        "SELECT COUNT(*) AS n FROM cameras c JOIN device_state s "
        "  ON s.device_id = c.device_id AND s.dimension = 'source_status' "
        "WHERE s.value = 'blind'")["n"]
    out["down"] = sum(out.get(k, 0) for k in
                      ("down_confirmed", "down_source_only", "down_network_only"))
    return out


@router.get("/sites")
def camera_sites(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    """Cameras rolled up by site, for the overview grid.

    Counts each failure shape separately rather than summing them into one
    "down". A site with 12 cameras Milestone cannot reach has a different
    problem from one with 12 genuinely dead, and a single number cannot say
    which — see spec 19 §13.
    """
    return [dict(r) for r in db.fetch_all(engine, """
        SELECT d.site AS site,
               COUNT(*) AS total,
               SUM(CASE WHEN reach.value = 'up' THEN 1 ELSE 0 END) AS up,
               SUM(CASE WHEN reach.value = 'down_confirmed' THEN 1 ELSE 0 END) AS down_confirmed,
               SUM(CASE WHEN reach.value = 'down_source_only' THEN 1 ELSE 0 END) AS down_source_only,
               SUM(CASE WHEN reach.value = 'down_network_only' THEN 1 ELSE 0 END) AS down_network_only,
               SUM(CASE WHEN src.value = 'blind' THEN 1 ELSE 0 END) AS blind,
               SUM(CASE WHEN rec.value = 'up' THEN 1 ELSE 0 END) AS recording
        FROM cameras c
        JOIN devices d ON d.id = c.device_id
        LEFT JOIN device_state reach ON reach.device_id = c.device_id
             AND reach.dimension = 'reachability'
        LEFT JOIN device_state src ON src.device_id = c.device_id
             AND src.dimension = 'source_status'
        LEFT JOIN device_state rec ON rec.device_id = c.device_id
             AND rec.dimension = 'recording'
        WHERE d.enabled = 1
        GROUP BY d.site ORDER BY d.site""")]


@router.get("/site-context")
def site_context(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    """Per-site recorders, configured storage and network device counts.

    Split from `/sites` rather than joined into it: that query already groups
    2,662 cameras by site, and adding three more aggregates over different
    tables would make one slow query out of two fast ones. The Sites tab (S6)
    and the overview both stitch them by site name.
    """
    return [dict(r) for r in db.fetch_all(engine, """
        SELECT d.site AS site,
               COUNT(DISTINCT rs.device_id) AS recorders,
               SUM(rs.storage_total_gb) AS storage_total_gb,
               MAX(rs.retention_days) AS retention_days
        FROM recording_servers rs JOIN devices d ON d.id = rs.device_id
        WHERE d.enabled = 1 GROUP BY d.site ORDER BY d.site""")]


@router.get("/camera-groups")
def camera_groups(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    """The Milestone camera tree with per-group health (migration 026).

    This is the navigation axis the surveillance team actually uses — XProtect's
    own groups, named by school code — as distinct from `devices.site`, which is
    how the network is organised. The two agree closely here but are not the
    same thing, and the tree must show what Milestone says.

    Labels come from the existing site vocabulary with no new mapping:
    `camera_groups.name` is the school code, which is exactly `sites.name`, so
    `display_name` ("Paul W. Bryant High") and `group_key` (the value in
    `devices.site`) join straight off it.

    Health is counted per group the same way the site tiles count it — each
    failure shape separately, blind apart from down (spec 19 §13) — because a
    collapsed group still has to confess a problem (CLAUDE.md §4.5).
    """
    return [dict(r) for r in db.fetch_all(engine, """
        SELECT g.id, g.name, g.parent_id, g.path, g.description,
               g.camera_count AS milestone_camera_count, g.updated_at,
               s.display_name AS site_display_name, s.group_key AS site,
               COUNT(m.device_id) AS total,
               SUM(CASE WHEN reach.value = 'up' THEN 1 ELSE 0 END) AS up,
               SUM(CASE WHEN reach.value = 'down_confirmed' THEN 1 ELSE 0 END) AS down_confirmed,
               SUM(CASE WHEN reach.value = 'down_source_only' THEN 1 ELSE 0 END) AS down_source_only,
               SUM(CASE WHEN reach.value = 'down_network_only' THEN 1 ELSE 0 END) AS down_network_only,
               SUM(CASE WHEN src.value = 'blind' THEN 1 ELSE 0 END) AS blind,
               SUM(CASE WHEN rec.value = 'up' THEN 1 ELSE 0 END) AS recording
        FROM camera_groups g
        LEFT JOIN camera_group_members m ON m.group_id = g.id
        LEFT JOIN devices d ON d.id = m.device_id AND d.enabled = 1
        LEFT JOIN sites s ON s.name = g.name
        LEFT JOIN device_state reach ON reach.device_id = m.device_id
             AND reach.dimension = 'reachability'
        LEFT JOIN device_state src ON src.device_id = m.device_id
             AND src.dimension = 'source_status'
        LEFT JOIN device_state rec ON rec.device_id = m.device_id
             AND rec.dimension = 'recording'
        GROUP BY g.id, g.name, g.parent_id, g.path, g.description, g.camera_count,
                 g.updated_at, s.display_name, s.group_key
        ORDER BY g.path, g.name""")]


@router.get("/cameras")
def cameras(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
    q: str | None = None,
    site: str | None = None,
    status: str | None = None,
    group: str | None = None,
) -> list[dict]:
    """Cameras, optionally narrowed by search, site, or status.

    ``status`` accepts a reachability tier (`down_confirmed`,
    `down_source_only`, `down_network_only`, `up`, `unknown`) or the shorthand
    ``down``, which means *any* tier where something says down. The shorthand
    exists because "show me what is down" is the question an operator actually
    asks, and answering it with only `down_confirmed` would hide the cameras the
    platform cannot reach.

    ``group`` narrows to one Milestone camera group (migration 026); ``site``
    narrows by the network site resolver. They are different axes and both are
    offered, because the surveillance team files cameras by group while the
    network is organised by site.
    """
    conds, params = [], {}
    if q:
        conds.append("(d.name LIKE :q OR c.ip LIKE :q OR c.model LIKE :q OR c.mac LIKE :q)")
        params["q"] = f"%{q}%"
    if site:
        conds.append("d.site = :site")
        params["site"] = site
    if group:
        # Milestone group membership (migration 026). An EXISTS rather than a
        # join because 25 cameras belong to two groups and a join would return
        # them twice.
        conds.append("EXISTS (SELECT 1 FROM camera_group_members m "
                     "WHERE m.device_id = c.device_id AND m.group_id = :group)")
        params["group"] = group
    if status:
        if status == "down":
            conds.append("reach.value IN ('down_confirmed', 'down_source_only', "
                         "'down_network_only')")
        elif status == "blind":
            conds.append("src.value = 'blind'")
        else:
            conds.append("reach.value = :status")
            params["status"] = status
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    rows = [dict(r) for r in db.fetch_all(
        engine, f"SELECT {_CAMERA_COLS} {_CAMERA_FROM} {where} ORDER BY d.site, d.name", params)]

    # Milestone group membership, attached in one extra query rather than a
    # correlated subquery per row: the Cameras page buckets 2,662 cameras into
    # the group tree client-side, and 25 of them are in two groups, so the
    # field is a list. One read of ~2,700 membership rows beats a join that
    # would duplicate camera rows and a subquery that would run per camera.
    if rows:
        members: dict[int, list[str]] = {}
        for m in db.fetch_all(engine, "SELECT group_id, device_id FROM camera_group_members"):
            members.setdefault(int(m["device_id"]), []).append(m["group_id"])
        for r in rows:
            r["group_ids"] = members.get(int(r["device_id"]), [])
    return rows


@router.get("/cameras/{device_id}")
def camera_detail(
    device_id: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    # Columns the detail page needs and the list does not: `hardware_id` to find
    # the other cameras on the same physical device, `http_port` because six
    # cameras here sit on a non-default port, and the device's own identity
    # (firmware/serial/vendor, migration 025). Selecting them only here keeps
    # the 2,651-row list query narrow.
    row = db.fetch_one(
        engine,
        f"SELECT {_CAMERA_COLS}, c.hardware_id, c.http_port, c.bitrate_mode, "
        f"c.firmware, c.serial, c.vendor "
        f"{_CAMERA_FROM} WHERE c.device_id = :d", {"d": device_id})
    if row is None:
        raise HTTPException(status_code=404, detail="camera not found")
    out = dict(row)

    # Every state dimension this camera carries, so the page can show which
    # probe said what rather than one collapsed verdict.
    out["state"] = {r["dimension"]: {"value": r["value"], "severity": r["severity"],
                                     "source": r["source"], "updated_at": r["updated_at"]}
                    for r in db.fetch_all(
                        engine,
                        "SELECT dimension, value, severity, source, updated_at "
                        "FROM device_state WHERE device_id = :d", {"d": device_id})}

    # Milestone does expose a camera MAC — in hardwareDriverSettings, one
    # resource below /hardware (migration 025). It is the better key: on the
    # first 155 cameras backfilled, 152 were found in the FDB against 124 whose
    # IP PacketFence had seen. PacketFence stays as the fallback for cameras the
    # backfill has not reached, and as the independent second opinion on which
    # port is the access port.
    #
    # Either way the MAC goes through the same access-port logic the AP page
    # uses — trunk-avoidance included, because a camera's MAC appears on every
    # uplink in its path just as an AP's does.
    out["pf"] = None
    out["switch_port"] = None
    if out.get("ip"):
        out["pf"] = db.fetch_one(
            engine,
            "SELECT mac, computername, owner, role, reg_status, vlan, last_switch, "
            "       last_port, conn_method, online, last_seen, updated_at "
            "FROM pf_nodes WHERE ip = :ip ORDER BY updated_at DESC LIMIT 1",
            {"ip": out["ip"]})
    mac = out.get("mac") or (out["pf"] or {}).get("mac")
    if mac:
        out["switch_port"] = uplink_for_mac(engine, mac, out["pf"])

    # Other cameras on the same physical device. 61 hardware records here carry
    # more than one (up to eleven on an AXIS M3007), and they share a network
    # interface — so a fault on one is a fault on all of them, which is only
    # obvious if the page says they exist.
    # Which Milestone group(s) this camera is filed under — the tree the
    # Cameras page navigates by, and worth stating on the detail page because a
    # camera can be in two (25 are here) and because its group is how the
    # surveillance team refers to it.
    out["groups"] = [dict(r) for r in db.fetch_all(
        engine,
        "SELECT g.id, g.name, s.display_name AS site_display_name "
        "FROM camera_group_members m JOIN camera_groups g ON g.id = m.group_id "
        "LEFT JOIN sites s ON s.name = g.name "
        "WHERE m.device_id = :d ORDER BY g.name", {"d": device_id})]

    # This camera's own transition history. `state_events` is NetMon's real
    # history (CLAUDE.md §6) and it is per-device, which is what lets the detail
    # page show a 24h reachability strip and a recent-events list where ZCD's
    # equivalents render empty sparklines — per-camera *series* would need
    # 2,662 series in a ring buffer deliberately kept low-cardinality (D3), so
    # transitions are the honest unit here.
    out["events"] = [dict(r) for r in db.fetch_all(
        engine,
        "SELECT dimension, old_value, new_value, severity, source, occurred_at "
        "FROM state_events WHERE device_id = :d "
        "ORDER BY occurred_at DESC LIMIT 60", {"d": device_id})]

    out["siblings"] = []
    if out.get("hardware_id"):
        out["siblings"] = [dict(r) for r in db.fetch_all(
            engine,
            "SELECT c.device_id, d.name, st.value AS recording_state "
            "FROM cameras c JOIN devices d ON d.id = c.device_id "
            "LEFT JOIN device_state st ON st.device_id = c.device_id "
            "  AND st.dimension = 'recording' "
            "WHERE c.hardware_id = :hw AND c.device_id != :d ORDER BY d.name",
            {"hw": out["hardware_id"], "d": device_id})]
    return out


@router.get("/servers")
def servers(engine: Engine = Depends(get_engine), _user=Depends(require_role(Role.viewer))) -> list[dict]:
    # Channel counts come from the cameras table, not from the Config API:
    # `cameraCount`/`recordingCameraCount` are NULL for all 22 recorders on this
    # deployment, and the camera→recorder link is already stored, so counting is
    # both cheaper and true. COALESCE keeps whatever a future XProtect reports.
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT rs.device_id, d.name, d.site, rs.hostname, rs.role, rs.version, "
        "COALESCE(rs.chans_total, cnt.total) AS chans_total, "
        "COALESCE(rs.chans_recording, cnt.recording) AS chans_recording, "
        "rs.storage_used_gb, rs.storage_total_gb, rs.retention_days, rs.updated_at, "
        # The four Events/State verdicts (migration 027). Descriptive: only
        # comm_state feeds device_state, and `states_at` lets the UI age the set
        # rather than implying every verdict is current — half the estate reads
        # "Service Available Critical" with a timestamp months old.
        "rs.comm_state, rs.cpu_state, rs.retention_state, rs.service_state, rs.states_at, "
        "st.value AS status "
        "FROM recording_servers rs JOIN devices d ON d.id = rs.device_id "
        "LEFT JOIN device_state st ON st.device_id = rs.device_id AND st.dimension = 'source_status' "
        "LEFT JOIN (SELECT c.recording_server_device_id AS rsid, COUNT(*) AS total, "
        "                  SUM(CASE WHEN stx.value = 'up' THEN 1 ELSE 0 END) AS recording "
        "           FROM cameras c "
        "           LEFT JOIN device_state stx ON stx.device_id = c.device_id "
        "                AND stx.dimension = 'recording' "
        "           WHERE c.recording_server_device_id IS NOT NULL "
        "           GROUP BY c.recording_server_device_id) cnt "
        "  ON cnt.rsid = rs.device_id "
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
