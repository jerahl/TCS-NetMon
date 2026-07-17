"""⌘K search palette API (spec 10 §6 / phase 10.5): read-only, viewer role,
DB-only.

``GET /api/search?q=`` unifies three indexed lookups behind the command
palette, exactly the three sources ZCD's search spanned:

  * **devices** — by name or management IP (the registry),
  * **endpoints** — `pf_nodes` by MAC, hostname, owner/username, or IP (NAC
    identity), and
  * **macs** — `fdb_entries` by MAC (which switch/port a MAC is learned on).

Every hit carries an ``href`` into the SPA so the palette can navigate. No
source-platform calls — all three tables are NetMon's own snapshot/registry
data (spec 10 §1).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import get_engine, require_role
from netmon.models.schemas import Role, SearchHit, SearchResults

router = APIRouter(tags=["search"])

# Per-group cap so a broad query can't return thousands of rows to the palette.
_LIMIT = 12


def _device_href(device_id: int, device_type: str | None) -> str:
    return f"#/switches/{device_id}" if device_type == "switch" else f"#/ap/{device_id}"


def _search_devices(engine: Engine, like: str) -> list[SearchHit]:
    rows = db.fetch_all(
        engine,
        "SELECT id, name, site, device_type, mgmt_ip FROM devices "
        "WHERE name LIKE :q OR mgmt_ip LIKE :q "
        "ORDER BY name LIMIT :lim",
        {"q": like, "lim": _LIMIT},
    )
    out: list[SearchHit] = []
    for r in rows:
        sub = " · ".join(x for x in (r.get("site"), r.get("mgmt_ip")) if x)
        out.append(SearchHit(
            kind="device",
            title=r["name"],
            subtitle=sub or None,
            href=_device_href(r["id"], r.get("device_type")),
            badge=(r.get("device_type") or "other"),
        ))
    return out


def _search_endpoints(engine: Engine, like: str) -> list[SearchHit]:
    rows = db.fetch_all(
        engine,
        "SELECT mac, computername, ip, owner, dot1x_user, role, reg_status, "
        "last_switch, last_port FROM pf_nodes "
        "WHERE mac LIKE :q OR computername LIKE :q OR ip LIKE :q "
        "OR owner LIKE :q OR dot1x_user LIKE :q "
        "ORDER BY updated_at DESC LIMIT :lim",
        {"q": like, "lim": _LIMIT},
    )
    out: list[SearchHit] = []
    for r in rows:
        title = r.get("computername") or r.get("dot1x_user") or r.get("owner") or r["mac"]
        bits = [b for b in (r.get("ip"), r.get("role"), r.get("reg_status")) if b]
        loc = " · ".join(x for x in (r.get("last_switch"), r.get("last_port")) if x)
        if loc:
            bits.append(f"@ {loc}")
        out.append(SearchHit(
            kind="endpoint",
            title=str(title),
            subtitle=(" · ".join([r["mac"]] + bits)),
            href="#/nac",
            badge="PF",
        ))
    return out


def _search_macs(engine: Engine, like: str) -> list[SearchHit]:
    rows = db.fetch_all(
        engine,
        "SELECT f.device_id, f.mac, f.vlan_id, f.ifindex, d.name AS switch "
        "FROM fdb_entries f JOIN devices d ON d.id = f.device_id "
        "WHERE f.mac LIKE :q "
        "ORDER BY f.updated_at DESC LIMIT :lim",
        {"q": like, "lim": _LIMIT},
    )
    out: list[SearchHit] = []
    for r in rows:
        bits = [f"on {r['switch']}"]
        if r.get("vlan_id") is not None:
            bits.append(f"vlan {r['vlan_id']}")
        if r.get("ifindex") is not None:
            bits.append(f"if {r['ifindex']}")
        out.append(SearchHit(
            kind="mac",
            title=r["mac"],
            subtitle=" · ".join(bits),
            href=f"#/switches/{r['device_id']}",
            badge="FDB",
        ))
    return out


@router.get("/api/search", response_model=SearchResults)
def search(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
    q: str = Query(default="", max_length=128),
) -> SearchResults:
    query = (q or "").strip()
    # Require ≥2 chars: a single character matches almost everything and the
    # palette would just be noise. Return an empty (but well-formed) result.
    if len(query) < 2:
        return SearchResults(query=query)

    like = f"%{query}%"
    devices = _search_devices(engine, like)
    endpoints = _search_endpoints(engine, like)
    macs = _search_macs(engine, like)
    return SearchResults(
        query=query,
        devices=devices,
        endpoints=endpoints,
        macs=macs,
        total=len(devices) + len(endpoints) + len(macs),
    )
