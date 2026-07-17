"""Registry administration — site CRUD + XIQ device import (admin only).

Writes to NetMon's OWN registry (`sites`, `devices`) — not a source platform,
so this is in-charter (§2 forbids writes to *sources*, not to NetMon's DB).
The XIQ import is read-only against XIQ (GET /devices) and reuses the seed's
pure reconciliation functions. All routes require the admin role and are
gated by the same `[security] allow_web_edit` flag as the settings engine —
one switch disables every web write path.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.engine import Engine

from netmon import db, enums
from netmon.api.deps import get_config, get_engine, require_role
from netmon.config import Config
from netmon.models.schemas import Role, SiteTier, UserSession

log = logging.getLogger("netmon.api.registry")

router = APIRouter(prefix="/api/registry", tags=["registry"])


def _require_edit(cfg: Config) -> None:
    if not cfg.security.allow_web_edit:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="web editing is disabled ([security] allow_web_edit=false)",
        )


class SiteIn(BaseModel):
    name: str
    display_name: str | None = None
    tier: SiteTier = SiteTier.other
    lat: float | None = None
    lon: float | None = None
    enabled: bool = True


@router.get("/sites")
def list_sites(
    engine: Engine = Depends(get_engine),
    _user: UserSession = Depends(require_role(Role.admin)),
) -> list[dict]:
    """Raw site rows for the admin editor + a device count per site (the
    devices.site join key)."""
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT s.id, s.name, s.display_name, s.tier, s.lat, s.lon, s.enabled, "
        " (SELECT COUNT(*) FROM devices d WHERE d.site = s.name) AS device_count "
        "FROM sites s ORDER BY s.name",
    )]


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
        "INSERT INTO sites (name, display_name, tier, lat, lon, enabled) "
        "VALUES (:n, :d, :t, :lat, :lon, :e)",
        {"n": name, "d": (body.display_name or None), "t": body.tier.value,
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
    db.execute(
        engine,
        "UPDATE sites SET name = :n, display_name = :d, tier = :t, lat = :lat, "
        "lon = :lon, enabled = :e WHERE id = :id",
        {"n": new_name, "d": (body.display_name or None), "t": body.tier.value,
         "lat": body.lat if body.lat is not None else 0,
         "lon": body.lon if body.lon is not None else 0,
         "e": 1 if body.enabled else 0, "id": site_id},
    )
    # Rename cascades to the devices.site join key so the roll-up stays intact.
    if new_name != old_name:
        db.execute(engine, "UPDATE devices SET site = :new WHERE site = :old",
                   {"new": new_name, "old": old_name})
        log.info("site %r renamed to %r by %s (devices re-pointed)", old_name, new_name, user.username)
    return {"status": "updated", "name": new_name, "renamed_from": old_name if new_name != old_name else None}


@router.delete("/sites/{site_id}")
def delete_site(
    site_id: int,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    _require_edit(cfg)
    row = db.fetch_one(engine, "SELECT name FROM sites WHERE id = :id", {"id": site_id})
    if row is None:
        raise HTTPException(status_code=404, detail="site not found")
    n = db.fetch_one(engine, "SELECT COUNT(*) AS n FROM devices WHERE site = :s",
                     {"s": row["name"]})["n"]
    if n > 0:
        # Refuse to orphan devices silently — the admin must reassign first.
        raise HTTPException(
            status_code=409,
            detail=f"{n} device(s) still assigned to site {row['name']!r}; reassign them first",
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
    """Registry devices for the site editor. Filter by ``site`` (exact
    ``devices.site`` join key, or the literal ``__none__`` for unassigned)."""
    sql = ("SELECT id, name, device_type, site, mgmt_ip, enabled "
           "FROM devices")
    params: dict = {}
    if site == "__none__":
        sql += " WHERE site IS NULL OR site = ''"
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
    # so we never point a device at a site with no card on the map.
    if target is not None and not db.fetch_one(
        engine, "SELECT 1 FROM sites WHERE name = :n", {"n": target}
    ):
        raise HTTPException(status_code=404, detail=f"site {target!r} does not exist")
    placeholders = ",".join(f":id{i}" for i in range(len(ids)))
    params: dict = {f"id{i}": v for i, v in enumerate(ids)}
    params["site"] = target
    n = db.execute(
        engine,
        f"UPDATE devices SET site = :site WHERE id IN ({placeholders})",
        params,
    )
    log.info("assign %d device(s) to site %r by %s", len(ids), target, user.username)
    return {"status": "assigned", "count": n if n is not None and n >= 0 else len(ids),
            "site": target}


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
