"""DDI (Micetro) API — DNS/DHCP/IPAM facts served from NetMon's DB.

docs/spec/21-micetro-ddi.md. ``ddi_addresses`` + ``ddi_scopes`` are written by
the `micetro` collector (replace-on-refresh, 15 min cadence); zero source calls
at render time (CLAUDE.md §6). Every response carries freshness so the UI
badges staleness honestly (§4.5).
"""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import get_engine, require_role
from netmon.macmatch import mac_expr, mac_norm
from netmon.models.schemas import Role
from netmon.snapshots import read_snapshot

log = logging.getLogger("netmon.api.ddi")

router = APIRouter(tags=["ddi"])

#: One deep MAC scan at a time, process-wide. The scan is ~261 requests over
#: ~9s; letting three impatient clicks run concurrently would put ~800
#: in-flight requests on the appliance for one answer. Queued, not rejected —
#: the second caller usually wants the same MAC and gets the cached result.
_SCAN_LOCK = asyncio.Lock()

#: Tiny result cache, keyed by ("ip"|"mac", value). A search box re-fires on
#: navigation and the answer does not change second to second; this keeps a
#: double-click from costing a second 9s scan. Not a mirror — it holds only
#: what someone actually asked for, and forgets it.
_CACHE: dict[tuple[str, str], tuple[float, dict]] = {}
_CACHE_MAX = 512

_ADDR_COLS = ("ip, mac, mac_origin, dns_name, dns_extra, state, discovery_type, "
              "last_seen, lease_state, lease_expires, reservation, device_name, "
              "interface_name, range_cidr, updated_at")

_SCOPE_COLS = ("scope_ref, name, range_cidr, from_addr, to_addr, server, "
               "superscope, enabled, available, utilization_pct, severity, updated_at")

# Worst first: an exhausting pool is the row an operator opened this page for.
# 'unknown' sorts above 'ok' deliberately — a scope Micetro reports no
# utilization for is an open question, not a healthy scope.
_SEV_ORDER = ("crit", "warn", "unknown", "ok")


def _freshness(engine: Engine, table: str) -> tuple[object, int]:
    row = db.fetch_one(engine, f"SELECT MAX(updated_at) AS t, COUNT(*) AS n FROM {table}")
    return (row or {}).get("t"), (row or {}).get("n") or 0


def _enabled(request: Request) -> bool:
    return bool(request.app.state.config.source_enabled("micetro"))


@router.get("/api/ddi")
def ddi_summary(
    request: Request,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    """Overview: coverage of the address mirror + DHCP scope health.

    ``enabled: false`` with no rows is the honest answer for a district that
    has not configured Micetro — the same shape `/api/nac` uses — and is
    distinct from an enabled source that swept zero rows, which is a fault.
    """
    addr_updated, addr_total = _freshness(engine, "ddi_addresses")
    scope_updated, scope_total = _freshness(engine, "ddi_scopes")
    if addr_total == 0 and scope_total == 0 and not _enabled(request):
        return {"enabled": False}

    counts = db.fetch_one(
        engine,
        "SELECT COUNT(*) AS total, "
        " SUM(CASE WHEN mac IS NOT NULL THEN 1 ELSE 0 END) AS with_mac, "
        " SUM(CASE WHEN dns_name IS NOT NULL THEN 1 ELSE 0 END) AS with_dns "
        "FROM ddi_addresses",
    ) or {}
    by_origin = {(r["mac_origin"] or "none"): r["n"] for r in db.fetch_all(
        engine, "SELECT mac_origin, COUNT(*) AS n FROM ddi_addresses GROUP BY mac_origin")}
    by_scope_sev = {(r["severity"] or "unknown"): r["n"] for r in db.fetch_all(
        engine, "SELECT severity, COUNT(*) AS n FROM ddi_scopes GROUP BY severity")}

    # How much of the FDB the mirror can now name — the number that says
    # whether this collector is earning its place (spec 21 §1).
    #
    # Both halves count DISTINCT MACs. A MAC holding several addresses would
    # otherwise be counted once per address and "resolved" could exceed
    # "macs" — a coverage figure over 100%, which is worse than no figure.
    fdb = db.fetch_one(
        engine,
        "SELECT (SELECT COUNT(DISTINCT mac) FROM fdb_entries) AS macs, "
        " (SELECT COUNT(DISTINCT f.mac) FROM fdb_entries f "
        "  JOIN ddi_addresses d ON d.mac = f.mac) AS resolved",
    ) or {}

    return {
        "enabled": True,
        "addresses": {
            "total": int(counts.get("total") or 0),
            "with_mac": int(counts.get("with_mac") or 0),
            "with_dns": int(counts.get("with_dns") or 0),
            "by_mac_origin": by_origin,
            "updated_at": addr_updated,
        },
        "scopes": {
            "total": scope_total,
            "by_severity": by_scope_sev,
            "updated_at": scope_updated,
        },
        "fdb_coverage": {
            "macs": int(fdb.get("macs") or 0),
            "resolved": int(fdb.get("resolved") or 0),
        },
        "snapshots": {
            "addresses": read_snapshot(engine, "micetro.addresses"),
            "dhcp": read_snapshot(engine, "micetro.dhcp"),
        },
    }


@router.get("/api/ddi/addresses")
def ddi_addresses(
    q: str | None = Query(None, description="match IP prefix, DNS name, or MAC"),
    mac: str | None = Query(None, description="exact MAC, any separator style"),
    range_cidr: str | None = Query(None, alias="range"),
    state: str | None = None,
    limit: int = Query(200, ge=1, le=2000),
    offset: int = Query(0, ge=0),
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    """Paged address mirror.

    ``q`` is deliberately tri-modal: operators paste whatever they have — an
    IP, a hostname, or a MAC off a label in any separator style. A query that
    is hex-once-separators-are-stripped also matches MACs (`macmatch`), so
    `bcf310` finds the address that `bc:f3:10:…` holds.
    """
    where: list[str] = []
    params: dict[str, object] = {}
    if mac:
        normalised = mac_norm(mac)
        if not normalised:
            raise HTTPException(status_code=400, detail="mac is not a MAC address")
        where.append(f"{mac_expr('mac')} = :mac")
        params["mac"] = normalised
    if q:
        clauses = ["ip LIKE :qpfx", "dns_name LIKE :qlike"]
        params["qpfx"] = f"{q}%"
        params["qlike"] = f"%{q}%"
        normalised = mac_norm(q)
        if normalised:
            clauses.append(f"{mac_expr('mac')} LIKE :qmac")
            params["qmac"] = f"{normalised}%"
        where.append("(" + " OR ".join(clauses) + ")")
    if range_cidr:
        where.append("range_cidr = :range_cidr")
        params["range_cidr"] = range_cidr
    if state:
        where.append("state = :state")
        params["state"] = state.strip().lower()
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    total = (db.fetch_one(
        engine, f"SELECT COUNT(*) AS n FROM ddi_addresses{clause}", params) or {}).get("n") or 0
    rows = [dict(r) for r in db.fetch_all(
        engine,
        f"SELECT {_ADDR_COLS} FROM ddi_addresses{clause} "
        "ORDER BY ip LIMIT :limit OFFSET :offset",
        {**params, "limit": limit, "offset": offset},
    )]
    updated_at, _ = _freshness(engine, "ddi_addresses")
    return {"addresses": rows, "total": total, "limit": limit, "offset": offset,
            "updated_at": updated_at}


@router.get("/api/ddi/lookup/{mac}")
def ddi_lookup(
    mac: str,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    """Every address one MAC holds — the endpoint the port-detail pane calls.

    A list, not a single row: one MAC legitimately holds several addresses
    (dual-stack, multi-homed, a re-lease before the old one expired), and
    collapsing them would hide the very ambiguity an operator is diagnosing.
    Strongest origin first, so the lease-backed address leads.
    """
    normalised = mac_norm(mac)
    if not normalised or len(normalised) != 12:
        raise HTTPException(status_code=400, detail="not a full MAC address")
    rows = [dict(r) for r in db.fetch_all(
        engine,
        f"SELECT {_ADDR_COLS} FROM ddi_addresses WHERE {mac_expr('mac')} = :mac "
        "ORDER BY CASE mac_origin WHEN 'lease' THEN 0 WHEN 'reservation' THEN 1 "
        "ELSE 2 END, ip",
        {"mac": normalised},
    )]
    updated_at, _ = _freshness(engine, "ddi_addresses")
    return {"mac": ":".join(normalised[i:i + 2] for i in range(0, 12, 2)),
            "addresses": rows, "updated_at": updated_at}


def _micetro_settings(request: Request) -> dict:
    src = request.app.state.config.sources.get("micetro")
    return dict(src.settings) if src else {}


def _cache_get(key: tuple[str, str], ttl: float) -> dict | None:
    hit = _CACHE.get(key)
    if hit and (time.monotonic() - hit[0]) < ttl:
        return hit[1]
    _CACHE.pop(key, None)
    return None


def _cache_put(key: tuple[str, str], value: dict) -> None:
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.clear()          # crude, bounded, and never wrong
    _CACHE[key] = (time.monotonic(), value)


def _local_ips_for_mac(engine: Engine, mac: str) -> list[tuple[str, str]]:
    """Addresses NetMon already knows for a MAC, best-sourced first.

    Micetro has no global MAC query (spec 21 §7b), so the cheap path is to get
    an IP from data already on hand and then ask Micetro about *that*. PF is
    preferred over the `ddi_addresses` cache because PF is refreshed every 5
    minutes by a live collector, whereas the cache is only whatever a manual
    `--once` last left behind.
    """
    out: list[tuple[str, str]] = []
    for src, sql in (
        ("pf_nodes", f"SELECT ip AS a FROM pf_nodes WHERE {mac_expr('mac')} = :m "
                     "AND ip IS NOT NULL AND ip <> ''"),
        ("ddi_cache", f"SELECT ip AS a FROM ddi_addresses WHERE {mac_expr('mac')} = :m"),
    ):
        for r in db.fetch_all(engine, sql, {"m": mac}):
            if r["a"] and (src, r["a"]) not in out:
                out.append((src, r["a"]))
    return out


@router.get("/api/ddi/resolve")
async def ddi_resolve(
    request: Request,
    ip: str | None = Query(None, description="IP address to resolve"),
    mac: str | None = Query(None, description="MAC, any separator style"),
    deep: bool | None = Query(None, description="allow the slow range scan for a MAC"),
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    """Ask Micetro about one address or MAC, live, right now.

    This is the on-demand replacement for mirroring the whole address space
    (spec 21 §7b). It is **user-initiated** — a search, not a render loop — so
    it does not breach the "zero source-platform calls at page render"
    invariant (CLAUDE.md §6) any more than the rConfig diff pane (spec 10 Q5)
    or the camera snapshot proxy (D7) do. It writes nothing to the DB.

    Cost, and why the MAC path has two speeds:

      * ``?ip=`` — one request, ~0.2s. ``GET /ipamRecords/<ip>`` takes a
        literal IP.
      * ``?mac=`` — Micetro has no global MAC query. If NetMon already knows an
        IP for that MAC (PacketFence covers ~84% of FDB MACs) it is one request
        too. Otherwise it falls back to fanning ``filter=<mac>`` across all 261
        subnet ranges: ~5s on a hit, ~9s to prove absence. ``deep=false``
        declines that and says so instead.

    ``found: false`` is a 200, not a 404 — "Micetro does not know this" is an
    answer. Only an unreachable or refusing source is an error (502), so a
    blind source can never be mistaken for an empty one (§4.5).
    """
    from netmon.collectors.micetro import build_address_rows
    from netmon.collectors.micetro_client import (
        MicetroClient, MicetroError, MicetroForbidden, MicetroNotFound,
    )

    if bool(ip) == bool(mac):
        raise HTTPException(status_code=400, detail="pass exactly one of ip= or mac=")

    settings = _micetro_settings(request)
    if not request.app.state.config.source_enabled("micetro"):
        # `enabled` no longer means "poll on a schedule" — nothing is
        # scheduled. It now means "NetMon may talk to Micetro at all".
        raise HTTPException(status_code=503,
                            detail="micetro is not enabled ([micetro] enabled = false)")
    ttl = float(settings.get("cache_ttl_s") or 60)
    allow_deep = str(settings.get("deep_scan", "true")).strip().lower() in ("1", "true", "yes", "on")
    if deep is not None:
        allow_deep = allow_deep and deep
    concurrency = int(settings.get("lookup_concurrency") or 8)

    norm_mac = None
    if mac:
        norm_mac = mac_norm(mac)
        if not norm_mac or len(norm_mac) != 12:
            raise HTTPException(status_code=400, detail="not a full MAC address")
        canon = ":".join(norm_mac[i:i + 2] for i in range(0, 12, 2))
        key = ("mac", canon)
    else:
        target = (ip or "").strip()
        if not target or not all(ch.isalnum() or ch in ".:" for ch in target):
            raise HTTPException(status_code=400, detail="not an IP address")
        canon = target
        key = ("ip", target)

    cached = _cache_get(key, ttl)
    if cached is not None:
        return {**cached, "cached": True}

    try:
        client = MicetroClient(
            url=(settings.get("url") or "").strip(),
            username=(settings.get("username") or "").strip(),
            password=settings.get("password") or "",
            verify_ssl=str(settings.get("verify_ssl", "true")).strip().lower()
            in ("1", "true", "yes", "on"),
        )
    except MicetroError as exc:
        raise HTTPException(status_code=503, detail=f"micetro not configured: {exc}") from exc

    started = time.monotonic()
    method = "ip" if ip else None
    record = None
    note = None

    async def one(addr: str):
        try:
            return await client.ipam_record(addr)
        except MicetroNotFound:
            return None

    try:
        if ip:
            record = await one(canon)
        else:
            for src, addr in _local_ips_for_mac(engine, norm_mac):
                rec = await one(addr)
                # Trust it only if Micetro agrees this address holds that MAC —
                # a stale local IP may have been re-leased to something else,
                # and reporting the new tenant as this MAC would be a fabrication.
                if rec and _record_holds_mac(rec, norm_mac):
                    record, method = rec, f"mac-via-local-ip:{src}"
                    break
            if record is None:
                if not allow_deep:
                    method, note = "declined", (
                        "no locally-known IP for this MAC, and the range scan was "
                        "declined (deep=false)")
                else:
                    async with _SCAN_LOCK:
                        cached = _cache_get(key, ttl)      # someone may have just done it
                        if cached is not None:
                            return {**cached, "cached": True}
                        record = await client.find_by_client_identifier(
                            canon, concurrency=concurrency)
                    method = "mac-scan"
    except MicetroForbidden as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except MicetroError as exc:
        # Blind, not empty.
        raise HTTPException(status_code=502, detail=f"micetro unreachable: {exc}") from exc

    rows = build_address_rows([record], None) if record else []
    result = {
        "query": {"ip": canon if ip else None, "mac": canon if mac else None},
        "found": bool(rows),
        "method": method,
        "note": note,
        "record": rows[0] if rows else None,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
        "source": "micetro",
        "live": True,
        "cached": False,
    }
    _cache_put(key, result)
    return result


def _record_holds_mac(record: dict, norm_mac: str) -> bool:
    """Does this IPAM record actually carry the MAC we asked about?"""
    from netmon.collectors.micetro import _pick_mac
    got, _ = _pick_mac(record)
    return bool(got) and got.replace(":", "") == norm_mac


@router.get("/api/ddi/scopes")
def ddi_scopes(
    severity: str | None = None,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> dict:
    """DHCP scopes, worst utilization first.

    Utilization is classified to `severity` by the collector at write time, so
    this is a sort, not arithmetic. Note that no alert fires for an exhausting
    scope: a DHCP scope is not a device and cannot ride `device_state`
    (spec 21 §6 / Q3), so utilization is visible here but silent.
    """
    where, params = "", {}
    if severity:
        where = " WHERE severity = :severity"
        params = {"severity": severity.strip().lower()}
    order = " ".join(
        f"WHEN '{s}' THEN {i}" for i, s in enumerate(_SEV_ORDER))
    rows = [dict(r) for r in db.fetch_all(
        engine,
        f"SELECT {_SCOPE_COLS} FROM ddi_scopes{where} "
        f"ORDER BY CASE severity {order} ELSE 9 END, "
        "utilization_pct DESC, name",
        params,
    )]
    updated_at, total = _freshness(engine, "ddi_scopes")
    return {"scopes": rows, "total": total, "updated_at": updated_at}
