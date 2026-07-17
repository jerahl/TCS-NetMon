"""History API (spec 10.6): read-only, viewer role, DB-only.

``GET /api/history?series=a,b,c&hours=24`` returns the requested series' points
from the bounded ``state_samples`` ring buffer — the data behind the design's
sparklines. Nothing here writes; the sampler (``netmon.history``) is the only
writer and it prunes to the ≤24 h window.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.engine import Engine

from netmon import history
from netmon.api.deps import get_engine, require_role
from netmon.models.schemas import Role

router = APIRouter(tags=["history"])

# Cap the number of distinct series one request can pull so a crafted query
# can't fan out arbitrarily; the palette/pages ask for a handful.
_MAX_SERIES = 32


@router.get("/api/history")
def get_history(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
    series: str = Query(default="", description="comma-separated series keys"),
    hours: int = Query(default=24, ge=1, le=24),
) -> dict:
    keys = [s.strip() for s in series.split(",") if s.strip()][:_MAX_SERIES]
    return {
        "hours": hours,
        "series": history.read_series(engine, keys, hours=hours),
    }
