"""Map API (spec 09): site roll-up + fiber links. Viewer role.

The roll-up and link-derivation functions are pure so the semantics are
unit-tested without a DB. Everything here is read-only. The recent-events feed
these pages consume moved to ``netmon.api.events`` (spec 10 §6) — same
``/api/events`` path, richer filters.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import get_engine, require_role
from netmon.models.schemas import (
    FiberLink,
    Role,
    SiteRollup,
    SiteStatus,
    SiteTier,
)

router = APIRouter(tags=["map"])

# One row per enabled device: did any of its state rows trip each flag?
_DEVICE_FLAGS_SQL = """
SELECT d.site AS site,
       MAX(CASE WHEN s.dimension = 'ping' THEN 1 ELSE 0 END) AS pinged,
       MAX(CASE WHEN s.dimension = 'ping' AND s.value = 'down' THEN 1 ELSE 0 END) AS ping_down,
       MAX(CASE WHEN s.severity IN ('warn','crit') THEN 1 ELSE 0 END) AS impaired,
       MAX(CASE WHEN s.device_id IS NULL THEN 0 ELSE 1 END) AS has_state
FROM devices d
LEFT JOIN device_state s ON s.device_id = d.id
WHERE d.enabled = 1 AND d.site IS NOT NULL
GROUP BY d.id, d.site
"""

_SITES_SQL = """
SELECT name, display_name, tier, lat, lon
FROM sites
WHERE enabled = 1
ORDER BY name
"""

_LINKS_SQL = """
SELECT l.id, l.capacity_gbps, l.path,
       sa.name AS site_a, sb.name AS site_b,
       st.status AS raw_status, st.utilization_pct, st.updated_at AS util_at,
       st.source AS util_source
FROM fiber_links l
JOIN sites sa ON sa.id = l.site_a_id
JOIN sites sb ON sb.id = l.site_b_id
LEFT JOIN fiber_link_state st ON st.link_id = l.id
WHERE l.enabled = 1 AND sa.enabled = 1 AND sb.enabled = 1
ORDER BY l.id
"""

def rollup_site(device_flags: list[dict[str, Any]]) -> tuple[SiteStatus, int, int, int]:
    """Roll one site's device flag rows up to (status, total, down, degraded).

    Semantics (spec 09): down = every ping-monitored device is down (and there
    is at least one); degraded = any device down or impaired; unknown = no
    state data at all; else up. Unknown never renders as up.
    """
    total = len(device_flags)
    pinged = sum(1 for d in device_flags if d["pinged"])
    down = sum(1 for d in device_flags if d["ping_down"])
    degraded = sum(1 for d in device_flags if not d["ping_down"] and d["impaired"])

    if total == 0 or not any(d["has_state"] for d in device_flags):
        return SiteStatus.unknown, total, down, degraded
    if pinged > 0 and down == pinged:
        return SiteStatus.down, total, down, degraded
    if down or degraded:
        return SiteStatus.degraded, total, down, degraded
    return SiteStatus.up, total, down, degraded


_RANK = {SiteStatus.up: 1, SiteStatus.degraded: 2, SiteStatus.down: 3}


def effective_link_status(
    a: SiteStatus, b: SiteStatus, stored: str | None
) -> SiteStatus:
    """Effective fiber-link status = worst(stored telemetry, endpoint-derived).

    Derived: down if either endpoint site is down (the far side is
    unreachable); unknown only when BOTH endpoints are unknown; else up — a
    reachable endpoint means its uplink path is passing traffic. A degraded
    site does not degrade the link. Stored 'unknown' (or garbage) is ignored.
    """
    if a is SiteStatus.down or b is SiteStatus.down:
        derived = SiteStatus.down
    elif a is SiteStatus.unknown and b is SiteStatus.unknown:
        derived = SiteStatus.unknown
    else:
        derived = SiteStatus.up

    try:
        stored_status = SiteStatus(stored) if stored else SiteStatus.unknown
    except ValueError:
        stored_status = SiteStatus.unknown

    candidates = [s for s in (derived, stored_status) if s in _RANK]
    if not candidates:
        return SiteStatus.unknown
    return max(candidates, key=lambda s: _RANK[s])


def _tier(value: Any) -> SiteTier:
    try:
        return SiteTier(value) if value else SiteTier.other
    except ValueError:
        return SiteTier.other


def _site_rollups(engine: Engine) -> list[SiteRollup]:
    flags_by_site: dict[str, list[dict[str, Any]]] = {}
    for row in db.fetch_all(engine, _DEVICE_FLAGS_SQL):
        flags_by_site.setdefault(row["site"], []).append(row)

    out: list[SiteRollup] = []
    for site in db.fetch_all(engine, _SITES_SQL):
        status, total, down, degraded = rollup_site(flags_by_site.get(site["name"], []))
        out.append(
            SiteRollup(
                name=site["name"],
                display_name=site.get("display_name"),
                tier=_tier(site.get("tier")),
                lat=float(site["lat"]),
                lon=float(site["lon"]),
                status=status,
                devices_total=total,
                devices_down=down,
                devices_degraded=degraded,
            )
        )
    return out


@router.get("/api/sites", response_model=list[SiteRollup])
def sites_json(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[SiteRollup]:
    return _site_rollups(engine)


@router.get("/api/links", response_model=list[FiberLink])
def links_json(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[FiberLink]:
    status_by_site = {s.name: s.status for s in _site_rollups(engine)}
    out: list[FiberLink] = []
    for r in db.fetch_all(engine, _LINKS_SQL):
        status = effective_link_status(
            status_by_site.get(r["site_a"], SiteStatus.unknown),
            status_by_site.get(r["site_b"], SiteStatus.unknown),
            r.get("raw_status"),
        )
        path = None
        if r.get("path"):
            try:
                path = json.loads(r["path"])
            except (TypeError, ValueError):
                path = None  # curated data bug — fall back to a straight line
        util = r.get("utilization_pct")
        out.append(
            FiberLink(
                id=r["id"],
                site_a=r["site_a"],
                site_b=r["site_b"],
                capacity_gbps=float(r["capacity_gbps"]),
                path=path,
                status=status,
                utilization_pct=float(util) if util is not None else None,
                utilization_at=r.get("util_at"),
                utilization_source=r.get("util_source"),
            )
        )
    return out
