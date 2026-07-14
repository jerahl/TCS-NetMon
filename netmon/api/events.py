"""Events API (spec 10 §6): the state-transition feed behind the Events
Console, the Problems view, and the Phase 9 map's live feed.

Everything here is read-only over ``state_events ⋈ devices``. The console's
ack/suppress/assign *actions* are alert-lifecycle operations and live on
``/api/alerts/*`` (netmon.api.alerts); this router only reads history.

``GET /api/events`` keeps its original flat-list contract (the map calls it with
just ``?limit=``); the console/problems filters are all optional query params so
adding them breaks no existing caller. ``GET /api/events/stats`` computes the
24 h severity histogram from timestamps — a query, not a stored series (§1/§6).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy.engine import Engine

from netmon import db
from netmon.models.schemas import (
    EventBucket,
    EventStats,
    MapEvent,
    Role,
    Severity,
)
from netmon.api.deps import get_engine, require_role

router = APIRouter(tags=["events"])

_BASE_SELECT = """
SELECT e.id, e.dimension, e.old_value, e.new_value, e.severity, e.source,
       e.occurred_at, e.device_id AS device_id,
       d.name AS device, d.site AS site, d.device_type AS device_type
FROM state_events e
JOIN devices d ON d.id = e.device_id
"""


def _filters(
    severity: str | None,
    source: str | None,
    site: str | None,
    device_type: str | None,
    dimension: str | None,
    q: str | None,
    since: datetime | None,
    until: datetime | None,
) -> tuple[str, dict]:
    """Build a shared WHERE clause + params for the feed and the stats query.

    All filters are optional and ANDed; an absent filter is simply omitted so
    the default (no params) selects everything.
    """
    clauses: list[str] = []
    params: dict = {}
    if severity:
        clauses.append("e.severity = :severity")
        params["severity"] = severity
    if source:
        clauses.append("e.source = :source")
        params["source"] = source
    if site:
        clauses.append("d.site = :site")
        params["site"] = site
    if device_type:
        clauses.append("d.device_type = :device_type")
        params["device_type"] = device_type
    if dimension:
        clauses.append("e.dimension = :dimension")
        params["dimension"] = dimension
    if q:
        clauses.append("(d.name LIKE :q OR e.new_value LIKE :q)")
        params["q"] = f"%{q}%"
    if since is not None:
        clauses.append("e.occurred_at >= :since")
        params["since"] = since
    if until is not None:
        clauses.append("e.occurred_at <= :until")
        params["until"] = until
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


@router.get("/api/events", response_model=list[MapEvent])
def events_json(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    severity: str | None = None,
    source: str | None = None,
    site: str | None = None,
    device_type: str | None = None,
    dimension: str | None = None,
    q: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> list[MapEvent]:
    where, params = _filters(
        severity, source, site, device_type, dimension, q, since, until
    )
    params["limit"] = limit
    params["offset"] = offset
    sql = _BASE_SELECT + where + " ORDER BY e.id DESC LIMIT :limit OFFSET :offset"
    return [
        MapEvent(
            id=r["id"],
            device=r["device"],
            device_id=r["device_id"],
            device_type=r.get("device_type") or "other",
            site=r.get("site"),
            dimension=r["dimension"],
            old_value=r.get("old_value"),
            new_value=r.get("new_value"),
            severity=r.get("severity") or "unknown",
            source=r["source"],
            occurred_at=r.get("occurred_at"),
        )
        for r in db.fetch_all(engine, sql, params)
    ]


_KNOWN_SEV = {s.value for s in Severity}


@router.get("/api/events/stats", response_model=EventStats)
def events_stats(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
    window_hours: int = Query(default=24, ge=1, le=168),
    source: str | None = None,
    site: str | None = None,
    device_type: str | None = None,
    dimension: str | None = None,
    q: str | None = None,
) -> EventStats:
    """KPI totals + an hourly severity histogram over the trailing window.

    Buckets are computed in Python from ``occurred_at`` so the query stays
    portable across MariaDB/SQLite (no engine-specific date functions). Empty
    hours are emitted so the histogram has a stable x-axis.
    """
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=window_hours)
    where, params = _filters(
        None, source, site, device_type, dimension, q, start, now
    )
    rows = db.fetch_all(
        engine,
        "SELECT e.severity AS severity, e.occurred_at AS occurred_at "
        "FROM state_events e JOIN devices d ON d.id = e.device_id" + where,
        params,
    )

    hour0 = start.replace(minute=0, second=0, microsecond=0)
    buckets = [
        EventBucket(hour=hour0 + timedelta(hours=i)) for i in range(window_hours + 1)
    ]
    by_severity: dict[str, int] = {s: 0 for s in _KNOWN_SEV}
    total = 0
    for r in rows:
        sev = r.get("severity") or "unknown"
        if sev not in _KNOWN_SEV:
            sev = "unknown"
        occurred = _as_dt(r.get("occurred_at"))
        if occurred is None:
            continue
        total += 1
        by_severity[sev] += 1
        idx = int((occurred - hour0).total_seconds() // 3600)
        if 0 <= idx < len(buckets):
            b = buckets[idx]
            setattr(b, sev, getattr(b, sev) + 1)
            b.total += 1

    return EventStats(
        total=total,
        by_severity=by_severity,
        window_hours=window_hours,
        buckets=buckets,
    )


def _as_dt(value) -> datetime | None:
    """Normalise a DB timestamp (datetime on MariaDB, ISO/space string on
    SQLite) to an aware UTC datetime for bucketing."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip().replace(" ", "T")
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)
