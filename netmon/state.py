"""Shared device_state writer with transition logging.

Used by collectors (the poller keeps its own hysteresis-aware path). Upserts the
current value into ``device_state`` (refreshing ``updated_at`` for liveness) and,
when the settled value changes, appends one row to the append-only
``state_events``. A previously-absent state is treated as coming from
``unknown`` so the first observation is itself a recorded transition.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.engine import Engine

from netmon import db


def write_state(
    engine: Engine,
    device_id: int,
    dimension: str,
    value: str,
    severity: str,
    source: str,
) -> bool:
    """Write current state; log an event iff the value changed. Returns changed."""
    now = datetime.now(timezone.utc)
    current = db.fetch_one(
        engine,
        "SELECT value FROM device_state WHERE device_id = :d AND dimension = :dim",
        {"d": device_id, "dim": dimension},
    )
    old = current["value"] if current else "unknown"

    db.upsert(
        engine,
        "device_state",
        {"device_id": device_id, "dimension": dimension},
        {"value": value, "severity": severity, "source": source, "updated_at": now},
    )

    if old != value:
        db.execute(
            engine,
            "INSERT INTO state_events "
            "(device_id, dimension, old_value, new_value, severity, source, occurred_at) "
            "VALUES (:d, :dim, :old, :new, :sev, :src, :at)",
            {"d": device_id, "dim": dimension, "old": old, "new": value,
             "sev": severity, "src": source, "at": now},
        )
        return True
    return False
