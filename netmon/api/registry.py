"""Registry administration — site CRUD + XIQ device import (admin only).

Writes to NetMon's OWN registry (`sites`, `devices`) — not a source platform,
so this is in-charter (§2 forbids writes to *sources*, not to NetMon's DB).
The XIQ import is read-only against XIQ (GET /devices) and reuses the seed's
pure reconciliation functions. All routes require the admin role and are
gated by the same `[security] allow_web_edit` flag as the settings engine —
one switch disables every web write path.
"""

from __future__ import annotations

import json
import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.engine import Engine

from netmon import db, enums
from netmon.api.deps import get_config, get_engine, require_role
from netmon.config import Config
from netmon.models.schemas import DeviceType, Role, SiteTier, UserSession
from netmon.seed import UNASSIGNED_SITE

log = logging.getLogger("netmon.api.registry")

router = APIRouter(prefix="/api/registry", tags=["registry"])


def _require_edit(cfg: Config) -> None:
    if not cfg.security.allow_web_edit:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="web editing is disabled ([security] allow_web_edit=false)",
        )


LABEL_POSITIONS = ("top", "bottom", "left", "right")


class SiteIn(BaseModel):
    name: str
    # Network site/group this map location represents (a devices.site value).
    # Empty/None → the roll-up joins by name, the historical behaviour.
    group_key: str | None = None
    display_name: str | None = None
    tier: SiteTier = SiteTier.other
    label_pos: str | None = None   # top|bottom|left|right; None → top
    lat: float | None = None
    lon: float | None = None
    enabled: bool = True


@router.get("/sites")
def list_sites(
    engine: Engine = Depends(get_engine),
    _user: UserSession = Depends(require_role(Role.admin)),
) -> list[dict]:
    """Raw site rows for the admin editor + the effective device-group join key
    and its device count. The join key is ``group_key`` when linked, else the
    site name."""
    rows = db.fetch_all(
        engine,
        "SELECT s.id, s.name, s.group_key, s.display_name, s.tier, s.label_pos, "
        " s.lat, s.lon, s.enabled, "
        " (SELECT COUNT(*) FROM devices d WHERE d.site = COALESCE(s.group_key, s.name)) AS device_count "
        "FROM sites s ORDER BY s.name",
    )
    out = []
    for r in rows:
        d = dict(r)
        d["join_key"] = d.get("group_key") or d["name"]
        out.append(d)
    return out


def _norm_group(value: str | None) -> str | None:
    v = (value or "").strip()
    return v or None


def _norm_label_pos(value: str | None) -> str | None:
    v = (value or "").strip().lower()
    if not v:
        return None
    if v not in LABEL_POSITIONS:
        raise HTTPException(status_code=422, detail=f"label_pos must be one of {LABEL_POSITIONS}")
    return v


@router.post("/sites")
def create_site(
    body: SiteIn,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    _require_edit(cfg)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="site name is required")
    if db.fetch_one(engine, "SELECT 1 FROM sites WHERE name = :n", {"n": name}):
        raise HTTPException(status_code=409, detail=f"site {name!r} already exists")
    # lat/lon are NOT NULL in the schema; default to 0 (off-map) when unset —
    # the site map skips 0/0 markers, so a site can exist before it's placed.
    db.execute(
        engine,
        "INSERT INTO sites (name, group_key, display_name, tier, label_pos, lat, lon, enabled) "
        "VALUES (:n, :g, :d, :t, :lp, :lat, :lon, :e)",
        {"n": name, "g": _norm_group(body.group_key), "d": (body.display_name or None),
         "t": body.tier.value, "lp": _norm_label_pos(body.label_pos),
         "lat": body.lat if body.lat is not None else 0,
         "lon": body.lon if body.lon is not None else 0,
         "e": 1 if body.enabled else 0},
    )
    log.info("site %r created by %s", name, user.username)
    return {"status": "created", "name": name}


@router.put("/sites/{site_id}")
def update_site(
    site_id: int,
    body: SiteIn,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    _require_edit(cfg)
    existing = db.fetch_one(engine, "SELECT name FROM sites WHERE id = :id", {"id": site_id})
    if existing is None:
        raise HTTPException(status_code=404, detail="site not found")
    old_name = existing["name"]
    new_name = body.name.strip()
    if not new_name:
        raise HTTPException(status_code=422, detail="site name is required")
    clash = db.fetch_one(engine, "SELECT 1 FROM sites WHERE name = :n AND id <> :id",
                         {"n": new_name, "id": site_id})
    if clash:
        raise HTTPException(status_code=409, detail=f"site {new_name!r} already exists")
    group_key = _norm_group(body.group_key)
    db.execute(
        engine,
        "UPDATE sites SET name = :n, group_key = :g, display_name = :d, tier = :t, "
        "label_pos = :lp, lat = :lat, lon = :lon, enabled = :e WHERE id = :id",
        {"n": new_name, "g": group_key, "d": (body.display_name or None), "t": body.tier.value,
         "lp": _norm_label_pos(body.label_pos),
         "lat": body.lat if body.lat is not None else 0,
         "lon": body.lon if body.lon is not None else 0,
         "e": 1 if body.enabled else 0, "id": site_id},
    )
    # Rename cascades to devices.site ONLY when the site joins by name (no
    # group link) — with a group_key set the name is just a map label and must
    # not re-point devices.
    renamed = new_name != old_name
    if renamed and group_key is None:
        db.execute(engine, "UPDATE devices SET site = :new WHERE site = :old",
                   {"new": new_name, "old": old_name})
        log.info("site %r renamed to %r by %s (devices re-pointed)", old_name, new_name, user.username)
    return {"status": "updated", "name": new_name,
            "renamed_from": old_name if renamed else None}


@router.get("/groups")
def list_groups(
    engine: Engine = Depends(get_engine),
    _user: UserSession = Depends(require_role(Role.admin)),
) -> list[dict]:
    """Distinct network site/groups (``devices.site`` values) with device counts
    and whether a map site already links to each — the picklist for linking a
    map location to a group."""
    counts = db.fetch_all(
        engine,
        "SELECT site AS name, COUNT(*) AS device_count FROM devices "
        "WHERE site IS NOT NULL AND site <> '' GROUP BY site ORDER BY site",
    )
    linked = {r["k"] for r in db.fetch_all(
        engine, "SELECT COALESCE(group_key, name) AS k FROM sites")}
    return [{"name": r["name"], "device_count": r["device_count"],
             "linked": r["name"] in linked} for r in counts]


@router.delete("/sites/{site_id}")
def delete_site(
    site_id: int,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    _require_edit(cfg)
    row = db.fetch_one(engine, "SELECT name, group_key FROM sites WHERE id = :id", {"id": site_id})
    if row is None:
        raise HTTPException(status_code=404, detail="site not found")
    join_key = row.get("group_key") or row["name"]
    n = db.fetch_one(engine, "SELECT COUNT(*) AS n FROM devices WHERE site = :s",
                     {"s": join_key})["n"]
    if n > 0:
        # Refuse to orphan devices silently — the admin must reassign first.
        raise HTTPException(
            status_code=409,
            detail=f"{n} device(s) still assigned to {join_key!r}; reassign them first",
        )
    db.execute(engine, "DELETE FROM sites WHERE id = :id", {"id": site_id})
    log.info("site %r deleted by %s", row["name"], user.username)
    return {"status": "deleted", "name": row["name"]}


@router.get("/devices")
def list_devices(
    site: str | None = None,
    engine: Engine = Depends(get_engine),
    _user: UserSession = Depends(require_role(Role.admin)),
) -> list[dict]:
    """Registry devices for the site/device editor. Filter by ``site`` (exact
    ``devices.site`` join key, or the literal ``__none__`` for unassigned).
    ``xiq_device_id`` is surfaced so the editor can flag source-managed rows."""
    sql = ("SELECT id, name, device_type, site, mgmt_ip, snmp_capable, enabled, "
           "xiq_device_id "
           "FROM devices")
    params: dict = {}
    if site == "__none__":
        # "Unassigned" has two on-disk forms: NULL/'' (web unassign) and the
        # literal seed/import sentinel; both must count as unassigned.
        sql += " WHERE site IS NULL OR site = '' OR site = :unassigned"
        params["unassigned"] = UNASSIGNED_SITE
    elif site is not None:
        sql += " WHERE site = :s"
        params["s"] = site
    sql += " ORDER BY device_type, name"
    return [dict(r) for r in db.fetch_all(engine, sql, params)]


class AssignSite(BaseModel):
    device_ids: list[int]
    site: str | None = None  # None/"" → unassign


@router.post("/devices/assign")
def assign_devices(
    body: AssignSite,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Reassign a batch of devices to a site (or unassign with a null/empty
    site). Writes only ``devices.site`` — NetMon's own registry."""
    _require_edit(cfg)
    ids = [int(i) for i in body.device_ids]
    if not ids:
        raise HTTPException(status_code=422, detail="no device ids given")
    target = (body.site or "").strip() or None
    # The target site must exist in the registry (or be an explicit unassign),
    # so we never point a device at a site with no card on the map. Devices are
    # written with the site's EFFECTIVE join key (group_key when linked) so
    # they roll up under it.
    join_key = None
    if target is not None:
        row = db.fetch_one(engine, "SELECT name, group_key FROM sites WHERE name = :n", {"n": target})
        if row is None:
            raise HTTPException(status_code=404, detail=f"site {target!r} does not exist")
        join_key = row.get("group_key") or row["name"]
    placeholders = ",".join(f":id{i}" for i in range(len(ids)))
    params: dict = {f"id{i}": v for i, v in enumerate(ids)}
    params["site"] = join_key
    n = db.execute(
        engine,
        f"UPDATE devices SET site = :site WHERE id IN ({placeholders})",
        params,
    )
    log.info("assign %d device(s) to %r by %s", len(ids), join_key, user.username)
    return {"status": "assigned", "count": n if n is not None and n >= 0 else len(ids),
            "site": join_key}


class BulkTypeIn(BaseModel):
    device_ids: list[int]
    device_type: DeviceType | None = None   # None → leave type unchanged
    snmp_capable: bool | None = None        # None → leave SNMP flag unchanged


@router.post("/devices/bulk-type")
def bulk_set_type(
    body: BulkTypeIn,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Set ``device_type`` and/or ``snmp_capable`` on a batch of devices at
    once (e.g. re-type a whole closet of switches mis-imported as APs).
    Only the fields provided are changed; each is independent so the SNMP flag
    is never silently derived. Writes NetMon's own registry only."""
    _require_edit(cfg)
    ids = [int(i) for i in body.device_ids]
    if not ids:
        raise HTTPException(status_code=422, detail="no device ids given")
    sets, params = [], {}
    if body.device_type is not None:
        sets.append("device_type = :t"); params["t"] = body.device_type.value
    if body.snmp_capable is not None:
        sets.append("snmp_capable = :snmp"); params["snmp"] = 1 if body.snmp_capable else 0
    if not sets:
        raise HTTPException(status_code=422, detail="nothing to change (set device_type and/or snmp_capable)")
    placeholders = ",".join(f":id{i}" for i in range(len(ids)))
    params.update({f"id{i}": v for i, v in enumerate(ids)})
    n = db.execute(
        engine,
        f"UPDATE devices SET {', '.join(sets)} WHERE id IN ({placeholders})",
        params,
    )
    log.info("bulk-type %d device(s) → %s by %s", len(ids), ", ".join(sets), user.username)
    return {"status": "updated", "count": n if n is not None and n >= 0 else len(ids),
            "device_type": body.device_type.value if body.device_type is not None else None,
            "snmp_capable": body.snmp_capable}


# ── manual device add / edit / delete ───────────────────────────────────────

def _resolve_site(engine: Engine, site: str | None) -> str | None:
    """A site the device may point at must exist in the registry (mirrors
    ``assign_devices``); returns its effective join key (``group_key`` when
    linked), or None for an explicit unassign."""
    target = (site or "").strip() or None
    if target is None:
        return None
    row = db.fetch_one(engine, "SELECT name, group_key FROM sites WHERE name = :n", {"n": target})
    if row is None:
        raise HTTPException(status_code=404, detail=f"site {target!r} does not exist")
    return row.get("group_key") or row["name"]


def _norm_ip(value: str | None) -> str | None:
    return (value or "").strip() or None


def _snmp_default(device_type: DeviceType, snmp_capable: bool | None) -> int:
    """Explicit flag wins; when unset, only switches default to SNMP-capable
    (matches the seed importer)."""
    if snmp_capable is not None:
        return 1 if snmp_capable else 0
    return 1 if device_type == DeviceType.switch else 0


class DeviceIn(BaseModel):
    name: str
    device_type: DeviceType = DeviceType.other
    site: str | None = None            # None/"" → unassigned
    mgmt_ip: str | None = None
    snmp_capable: bool | None = None   # None → derive from type (switch→on)
    enabled: bool = True


class DeviceEdit(BaseModel):
    """Edit payload — no ``site`` field: site is managed by the batch-assign
    tool so an edit can never inadvertently re-point a device off its site."""

    name: str
    device_type: DeviceType = DeviceType.other
    mgmt_ip: str | None = None
    snmp_capable: bool | None = None
    enabled: bool = True


@router.post("/devices")
def create_device(
    body: DeviceIn,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Manually register a device in NetMon's own registry (not from a source
    export). Useful for gear no federated source knows about, or before a
    collector has discovered it. Writes only NetMon's ``devices`` table."""
    _require_edit(cfg)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="device name is required")
    if db.fetch_one(engine, "SELECT 1 FROM devices WHERE name = :n", {"n": name}):
        raise HTTPException(status_code=409, detail=f"device {name!r} already exists")
    join_key = _resolve_site(engine, body.site)
    db.execute(
        engine,
        "INSERT INTO devices (name, site, device_type, mgmt_ip, snmp_capable, enabled) "
        "VALUES (:n, :s, :t, :ip, :snmp, :e)",
        {"n": name, "s": join_key, "t": body.device_type.value, "ip": _norm_ip(body.mgmt_ip),
         "snmp": _snmp_default(body.device_type, body.snmp_capable), "e": 1 if body.enabled else 0},
    )
    log.info("device %r (%s) created by %s", name, body.device_type.value, user.username)
    return {"status": "created", "name": name}


@router.put("/devices/{device_id}")
def update_device(
    device_id: int,
    body: DeviceEdit,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Edit a registry device — rename, change ``device_type``, mgmt IP, SNMP
    flag, or enabled state. Changing the type reroutes the device between
    dashboards (e.g. an AP mis-imported as a switch, or vice-versa) and, for
    switches, into the SNMP inventory sweep and out of the XIQ AP-detail path.
    Site (use the assign tool) and per-source keys are left untouched."""
    _require_edit(cfg)
    existing = db.fetch_one(
        engine, "SELECT name, device_type FROM devices WHERE id = :id", {"id": device_id})
    if existing is None:
        raise HTTPException(status_code=404, detail="device not found")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="device name is required")
    clash = db.fetch_one(engine, "SELECT 1 FROM devices WHERE name = :n AND id <> :id",
                         {"n": name, "id": device_id})
    if clash:
        raise HTTPException(status_code=409, detail=f"device {name!r} already exists")
    db.execute(
        engine,
        "UPDATE devices SET name = :n, device_type = :t, mgmt_ip = :ip, "
        "snmp_capable = :snmp, enabled = :e WHERE id = :id",
        {"n": name, "t": body.device_type.value, "ip": _norm_ip(body.mgmt_ip),
         "snmp": _snmp_default(body.device_type, body.snmp_capable),
         "e": 1 if body.enabled else 0, "id": device_id},
    )
    log.info("device %d (%s → %s) updated by %s",
             device_id, existing["device_type"], body.device_type.value, user.username)
    return {"status": "updated", "id": device_id, "name": name,
            "type_changed_from": existing["device_type"] if existing["device_type"] != body.device_type.value else None}


@router.delete("/devices/{device_id}")
def delete_device(
    device_id: int,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Remove a device from the registry. Its current state and transition
    history cascade away (FK ON DELETE CASCADE) — intended for decommissioned
    or mistakenly-added gear. A device a source collector still sees will be
    re-created on the next import/seed."""
    _require_edit(cfg)
    row = db.fetch_one(engine, "SELECT name FROM devices WHERE id = :id", {"id": device_id})
    if row is None:
        raise HTTPException(status_code=404, detail="device not found")
    db.execute(engine, "DELETE FROM devices WHERE id = :id", {"id": device_id})
    log.info("device %r deleted by %s", row["name"], user.username)
    return {"status": "deleted", "name": row["name"]}


# ── site map: move sites, edit fiber links ──────────────────────────────────

class SiteLocation(BaseModel):
    lat: float
    lon: float


def _check_latlon(lat: float, lon: float) -> None:
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(status_code=422, detail="lat/lon out of range")


@router.post("/sites/{site_id}/location")
def move_site(
    site_id: int,
    body: SiteLocation,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Reposition a site marker on the map (writes sites.lat/lon only)."""
    _require_edit(cfg)
    _check_latlon(body.lat, body.lon)
    row = db.fetch_one(engine, "SELECT name FROM sites WHERE id = :id", {"id": site_id})
    if row is None:
        raise HTTPException(status_code=404, detail="site not found")
    db.execute(engine, "UPDATE sites SET lat = :lat, lon = :lon WHERE id = :id",
               {"lat": body.lat, "lon": body.lon, "id": site_id})
    log.info("site %r moved to (%.6f, %.6f) by %s", row["name"], body.lat, body.lon, user.username)
    return {"status": "moved", "name": row["name"], "lat": body.lat, "lon": body.lon}


def _validate_path(path) -> list[list[float]] | None:
    """A fiber path is a JSON list of >=2 [lat, lon] points, or null (straight
    line between the endpoint sites, which then tracks site moves)."""
    if path is None:
        return None
    if not isinstance(path, list) or len(path) < 2:
        raise HTTPException(status_code=422,
                            detail="path must be a list of at least two [lat, lon] points, or null")
    out: list[list[float]] = []
    for pt in path:
        if not isinstance(pt, (list, tuple)) or len(pt) != 2:
            raise HTTPException(status_code=422, detail="each path point must be [lat, lon]")
        try:
            lat, lon = float(pt[0]), float(pt[1])
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail="path coordinates must be numbers") from None
        _check_latlon(lat, lon)
        out.append([lat, lon])
    return out


def _site_id(engine: Engine, name: str) -> int:
    row = db.fetch_one(engine, "SELECT id FROM sites WHERE name = :n", {"n": name})
    if row is None:
        raise HTTPException(status_code=404, detail=f"site {name!r} does not exist")
    return int(row["id"])


@router.get("/links")
def list_links(
    engine: Engine = Depends(get_engine),
    _user: UserSession = Depends(require_role(Role.admin)),
) -> list[dict]:
    """Fiber links for the map editor (raw rows incl. id, parsed path, kind,
    provider, and the switch ports each end is patched into)."""
    rows = db.fetch_all(engine,
        "SELECT l.id, l.capacity_gbps, l.path, l.enabled, l.link_kind, l.provider, "
        " l.a_device_id, l.a_ifindex, l.b_device_id, l.b_ifindex, "
        " sa.name AS site_a, sb.name AS site_b "
        "FROM fiber_links l JOIN sites sa ON sa.id = l.site_a_id "
        "JOIN sites sb ON sb.id = l.site_b_id ORDER BY l.id")
    out = []
    for r in rows:
        try:
            path = json.loads(r["path"]) if r.get("path") else None
        except (TypeError, ValueError):
            path = None
        out.append({"id": r["id"], "site_a": r["site_a"], "site_b": r["site_b"],
                    "capacity_gbps": float(r["capacity_gbps"]), "path": path,
                    "link_kind": (r.get("link_kind") or "owned"), "provider": r.get("provider"),
                    "a_device_id": r.get("a_device_id"), "a_ifindex": r.get("a_ifindex"),
                    "b_device_id": r.get("b_device_id"), "b_ifindex": r.get("b_ifindex"),
                    "enabled": bool(r["enabled"])})
    return out


LINK_KINDS = ("owned", "leased")


def _norm_kind(value: str | None) -> str:
    v = (value or "owned").strip().lower()
    if v not in LINK_KINDS:
        raise HTTPException(status_code=422, detail=f"link_kind must be one of {LINK_KINDS}")
    return v


def _check_port(engine: Engine, device_id, ifindex) -> None:
    """A port end is either fully unset or a (device_id, ifindex) pair naming a
    switch in the registry — we don't require the sweep to have seen the port
    yet, but the device must exist and be a switch."""
    if device_id is None and ifindex is None:
        return
    if device_id is None or ifindex is None:
        raise HTTPException(status_code=422, detail="a port end needs both a device and an ifindex")
    row = db.fetch_one(engine, "SELECT device_type FROM devices WHERE id = :id", {"id": int(device_id)})
    if row is None:
        raise HTTPException(status_code=404, detail=f"device {device_id} does not exist")
    if row["device_type"] != "switch":
        raise HTTPException(status_code=422, detail=f"device {device_id} is not a switch")


class LinkIn(BaseModel):
    site_a: str
    site_b: str
    capacity_gbps: float = 1.0
    path: list | None = None
    link_kind: str = "owned"
    provider: str | None = None


@router.post("/links")
def create_link(
    body: LinkIn,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Register a fiber link between two sites. Endpoints stored in sorted-name
    order (A↔B == B↔A). A pair may have several links — redundant fiber paths
    are allowed, so no duplicate-pair check; distinguish them by path/capacity."""
    _require_edit(cfg)
    a, b = body.site_a.strip(), body.site_b.strip()
    if a == b:
        raise HTTPException(status_code=422, detail="a link needs two distinct sites")
    a, b = (a, b) if a <= b else (b, a)   # _norm_pair, mirroring topology.py
    aid, bid = _site_id(engine, a), _site_id(engine, b)
    path = _validate_path(body.path)
    kind = _norm_kind(body.link_kind)
    provider = (body.provider or "").strip() or None
    db.execute(engine,
        "INSERT INTO fiber_links (site_a_id, site_b_id, capacity_gbps, path, link_kind, provider, enabled) "
        "VALUES (:a, :b, :cap, :path, :kind, :prov, 1)",
        {"a": aid, "b": bid, "cap": body.capacity_gbps,
         "path": json.dumps(path) if path is not None else None,
         "kind": kind, "prov": provider})
    log.info("fiber link %s—%s (%s) created by %s", a, b, kind, user.username)
    return {"status": "created", "site_a": a, "site_b": b}


class LinkUpdate(BaseModel):
    capacity_gbps: float | None = None
    path: list | None = None
    clear_path: bool = False   # explicit: revert to a straight, site-tracking line
    enabled: bool | None = None
    link_kind: str | None = None
    provider: str | None = None
    # Port attachments. Present a key to change that end; use clear_ports to
    # detach both. device+ifindex None means "leave as is" unless clear_ports.
    a_device_id: int | None = None
    a_ifindex: int | None = None
    b_device_id: int | None = None
    b_ifindex: int | None = None
    set_ports: bool = False     # apply the a_/b_ port fields (allows setting NULL)
    clear_ports: bool = False   # detach both ends


@router.put("/links/{link_id}")
def update_link(
    link_id: int,
    body: LinkUpdate,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Edit a link's capacity, path, ownership, or the switch ports it's
    patched into."""
    _require_edit(cfg)
    if db.fetch_one(engine, "SELECT 1 FROM fiber_links WHERE id = :id", {"id": link_id}) is None:
        raise HTTPException(status_code=404, detail="link not found")
    sets, params = [], {"id": link_id}
    if body.capacity_gbps is not None:
        if body.capacity_gbps <= 0:
            raise HTTPException(status_code=422, detail="capacity_gbps must be > 0")
        sets.append("capacity_gbps = :cap"); params["cap"] = body.capacity_gbps
    if body.clear_path:
        sets.append("path = NULL")
    elif body.path is not None:
        path = _validate_path(body.path)
        sets.append("path = :path"); params["path"] = json.dumps(path)
    if body.enabled is not None:
        sets.append("enabled = :en"); params["en"] = 1 if body.enabled else 0
    if body.link_kind is not None:
        sets.append("link_kind = :kind"); params["kind"] = _norm_kind(body.link_kind)
    if body.provider is not None:
        sets.append("provider = :prov"); params["prov"] = (body.provider.strip() or None)
    if body.clear_ports:
        sets += ["a_device_id = NULL", "a_ifindex = NULL", "b_device_id = NULL", "b_ifindex = NULL"]
    elif body.set_ports:
        _check_port(engine, body.a_device_id, body.a_ifindex)
        _check_port(engine, body.b_device_id, body.b_ifindex)
        sets += ["a_device_id = :ad", "a_ifindex = :ai", "b_device_id = :bd", "b_ifindex = :bi"]
        params.update({"ad": body.a_device_id, "ai": body.a_ifindex,
                       "bd": body.b_device_id, "bi": body.b_ifindex})
    if not sets:
        raise HTTPException(status_code=422, detail="nothing to update")
    db.execute(engine, f"UPDATE fiber_links SET {', '.join(sets)} WHERE id = :id", params)
    log.info("fiber link %d updated by %s (%s)", link_id, user.username, ", ".join(sets))
    return {"status": "updated", "id": link_id}


@router.delete("/links/{link_id}")
def delete_link(
    link_id: int,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    _require_edit(cfg)
    if db.fetch_one(engine, "SELECT 1 FROM fiber_links WHERE id = :id", {"id": link_id}) is None:
        raise HTTPException(status_code=404, detail="link not found")
    db.execute(engine, "DELETE FROM fiber_links WHERE id = :id", {"id": link_id})
    log.info("fiber link %d deleted by %s", link_id, user.username)
    return {"status": "deleted", "id": link_id}


# ── editable SNMP enum-decode maps ──────────────────────────────────────────

def _enum_view(engine: Engine, name: str) -> dict:
    override = enums.get_override(engine, name)
    return {
        "name": name,
        **enums.META.get(name, {}),
        "default": enums.DEFAULTS[name],
        "effective": enums.effective_map(engine, name),
        "override": override,
        "overridden": bool(override),
    }


@router.get("/enums")
def list_enums(
    engine: Engine = Depends(get_engine),
    _user: UserSession = Depends(require_role(Role.admin)),
) -> list[dict]:
    """Owner-editable SNMP decode maps — default vs. effective vs. override."""
    return [_enum_view(engine, name) for name in enums.NAMES]


class EnumMapIn(BaseModel):
    entries: dict[str, str]


@router.put("/enums/{name}")
def set_enum(
    name: str,
    body: EnumMapIn,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Override an enum's labels. Codes must be integers (SNMP enum values);
    labels must be non-empty. Stored whole; the next sweep picks it up."""
    _require_edit(cfg)
    if name not in enums.DEFAULTS:
        raise HTTPException(status_code=404, detail=f"unknown enum map {name!r}")
    cleaned: dict[str, str] = {}
    for k, v in body.entries.items():
        code = str(k).strip()
        if not re.fullmatch(r"\d+", code):
            raise HTTPException(status_code=422, detail=f"code {k!r} must be a non-negative integer")
        label = str(v).strip()
        if not label:
            raise HTTPException(status_code=422, detail=f"label for code {code} must not be empty")
        cleaned[code] = label
    if not cleaned:
        raise HTTPException(status_code=422, detail="at least one code→label entry is required")
    enums.set_override(engine, name, cleaned)
    log.info("enum map %r overridden by %s (%d entries)", name, user.username, len(cleaned))
    return {"status": "saved", **_enum_view(engine, name)}


@router.delete("/enums/{name}")
def reset_enum(
    name: str,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Drop the override, reverting to the code default."""
    _require_edit(cfg)
    if name not in enums.DEFAULTS:
        raise HTTPException(status_code=404, detail=f"unknown enum map {name!r}")
    enums.clear_override(engine, name)
    log.info("enum map %r reset to default by %s", name, user.username)
    return {"status": "reset", **_enum_view(engine, name)}


class XiqImport(BaseModel):
    dry_run: bool = True


@router.post("/import-xiq")
async def import_xiq(
    body: XiqImport,
    request: Request,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Pull the XIQ fleet (read-only GET /devices) and reconcile switches/APs
    into the registry. Reuses the seed's pure functions; sites are preserved
    from the existing registry (D9 — no Zabbix). ``dry_run`` (default) reports
    what would change without writing."""
    _require_edit(cfg)
    if not cfg.source_enabled("xiq"):
        raise HTTPException(status_code=400, detail="the XIQ source is not enabled in config")

    from netmon.collectors.xiq_client import BASE_URL, XiqClient, XiqError
    from netmon.seed import assign_sites, normalize_xiq, reconcile, site_index_from_db, upsert_devices

    s = cfg.sources["xiq"].settings
    client = XiqClient((s.get("api_token") or "").strip(), (s.get("base_url") or BASE_URL).strip())
    try:
        raw = await client.get_devices("BASIC")
    except XiqError as exc:
        raise HTTPException(status_code=502, detail=f"XIQ fetch failed: {exc}")

    devices = reconcile(normalize_xiq(raw), [])
    assign_sites(devices, site_index_from_db(engine))

    existing = {r["xiq_device_id"]: r for r in db.fetch_all(
        engine, "SELECT xiq_device_id, name FROM devices WHERE xiq_device_id IS NOT NULL")}
    added = [d for d in devices if d.xiq_device_id not in existing]
    updated = [d for d in devices if d.xiq_device_id in existing]

    result = {
        "dry_run": body.dry_run,
        "fetched": len(raw),
        "reconciled": len(devices),
        "would_add" if body.dry_run else "added": len(added),
        "would_update" if body.dry_run else "updated": len(updated),
        "new_devices": [{"name": d.name, "type": d.device_type.value, "site": d.site} for d in added[:100]],
    }
    if not body.dry_run:
        upsert_devices(engine, devices)
        log.info("XIQ import by %s: %d added, %d updated", user.username, len(added), len(updated))
    return result


class MilestoneImport(BaseModel):
    dry_run: bool = True


@router.post("/import-milestone")
async def import_milestone(
    body: MilestoneImport,
    request: Request,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Pull Milestone recording servers + cameras (read-only) and reconcile them
    into the registry, linked by ``milestone_hardware_id``. This is the seeding
    step that lets the Milestone collector produce data at all — without it no
    device carries the id the collector matches on, so the Surveillance page
    stays empty even with the source configured. ``dry_run`` (default) reports
    what would change without writing; sites are preserved from the existing
    registry (D9)."""
    _require_edit(cfg)
    if not cfg.source_enabled("milestone"):
        raise HTTPException(status_code=400, detail="the Milestone source is not enabled in config")

    from netmon.collectors.milestone_client import MilestoneClient, MilestoneError
    from netmon.seed import assign_sites, normalize_milestone, site_index_from_db, upsert_devices

    s = cfg.sources["milestone"].settings
    client = MilestoneClient(
        host=(s.get("host") or "").strip(),
        user=(s.get("user") or "").strip(),
        password=s.get("pass") or "",
        scheme=(s.get("scheme") or "https").strip(),
        client_id=(s.get("client_id") or "GrantValidatorClient").strip(),
        verify_ssl=str(s.get("verify_ssl", "true")).strip().lower() in ("1", "true", "yes", "on"),
    )
    try:
        servers = await client.recording_servers()
        cameras = await client.cameras()
    except MilestoneError as exc:
        raise HTTPException(status_code=502, detail=f"Milestone fetch failed: {exc}")

    devices = normalize_milestone(servers, cameras)
    assign_sites(devices, site_index_from_db(engine))

    existing = {r["milestone_hardware_id"] for r in db.fetch_all(
        engine, "SELECT milestone_hardware_id FROM devices "
                "WHERE milestone_hardware_id IS NOT NULL AND milestone_hardware_id <> ''")}
    added = [d for d in devices if d.milestone_hardware_id not in existing]
    updated = [d for d in devices if d.milestone_hardware_id in existing]

    result = {
        "dry_run": body.dry_run,
        "fetched_servers": len(servers),
        "fetched_cameras": len(cameras),
        "reconciled": len(devices),
        "would_add" if body.dry_run else "added": len(added),
        "would_update" if body.dry_run else "updated": len(updated),
        "new_devices": [{"name": d.name, "type": d.device_type.value, "site": d.site} for d in added[:100]],
    }
    if not body.dry_run:
        upsert_devices(engine, devices)
        log.info("Milestone import by %s: %d added, %d updated", user.username, len(added), len(updated))
    return result
