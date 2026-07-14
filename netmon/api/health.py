"""Liveness / readiness endpoint. Unauthenticated by design."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.engine import Engine

from netmon import __version__, db
from netmon.api.deps import get_engine
from netmon.models.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/healthz", response_model=HealthResponse)
def healthz(engine: Engine = Depends(get_engine)) -> HealthResponse:
    db_ok = db.healthcheck(engine)
    # Liveness stays "ok" even when the DB is down — the process is up and can
    # report the degraded dependency (fail loud, not silent: §4.5).
    return HealthResponse(status="ok", version=__version__, db_ok=db_ok)
