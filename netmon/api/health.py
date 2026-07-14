"""Liveness/readiness (unauthenticated) + collector-health (viewer role)."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.engine import Engine

from netmon import __version__, db
from netmon.api.deps import get_engine, require_role
from netmon.models.schemas import CollectorHealth, HealthResponse, Role

router = APIRouter(tags=["health"])


@router.get("/healthz", response_model=HealthResponse)
def healthz(engine: Engine = Depends(get_engine)) -> HealthResponse:
    db_ok = db.healthcheck(engine)
    # Liveness stays "ok" even when the DB is down — the process is up and can
    # report the degraded dependency (fail loud, not silent: §4.5).
    return HealthResponse(status="ok", version=__version__, db_ok=db_ok)


_COLLECTOR_HEALTH_SQL = """
SELECT name, last_start, last_success, last_error, duration_ms,
       records_written, consecutive_failures, updated_at
FROM collector_health
ORDER BY name
"""


def _derive_status(consecutive_failures: int, last_success) -> str:
    """Honest roll-up for the source-health pills (§4.5 fail-loud).

    A collector with failures reads ``error`` even if it once succeeded; one
    that has never succeeded reads ``unknown`` (never ``ok``); otherwise ``ok``.
    Staleness (last_success too old for the collector's interval) is judged in
    the UI, which knows each pill's cadence.
    """
    if consecutive_failures and consecutive_failures > 0:
        return "error"
    if last_success is None:
        return "unknown"
    return "ok"


@router.get("/api/collector-health", response_model=list[CollectorHealth])
def collector_health(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[CollectorHealth]:
    out: list[CollectorHealth] = []
    for r in db.fetch_all(engine, _COLLECTOR_HEALTH_SQL):
        failures = r.get("consecutive_failures") or 0
        out.append(
            CollectorHealth(
                name=r["name"],
                status=_derive_status(failures, r.get("last_success")),
                last_start=r.get("last_start"),
                last_success=r.get("last_success"),
                last_error=r.get("last_error"),
                duration_ms=r.get("duration_ms"),
                records_written=r.get("records_written"),
                consecutive_failures=failures,
                updated_at=r.get("updated_at"),
            )
        )
    return out
