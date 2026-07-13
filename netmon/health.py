"""Portable collector_health writers (fail-loud heartbeat, CLAUDE.md §4.5).

Shared by the poller now and the collectors later. Uses the portable upsert +
plain UPDATE so it runs under both SQLite (tests) and MariaDB (prod). A failing
task records the error and bumps consecutive_failures; it never overwrites prior
state with fabricated success.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.engine import Engine

from netmon import db


def _now() -> datetime:
    return datetime.now(timezone.utc)


def record_start(engine: Engine, name: str) -> None:
    now = _now()
    db.upsert(engine, "collector_health", {"name": name}, {"last_start": now, "updated_at": now})


def record_success(engine: Engine, name: str, *, records: int, duration_ms: int) -> None:
    now = _now()
    db.upsert(
        engine,
        "collector_health",
        {"name": name},
        {
            "last_success": now,
            "duration_ms": duration_ms,
            "records_written": records,
            "consecutive_failures": 0,
            "last_error": None,
            "updated_at": now,
        },
    )


def record_error(engine: Engine, name: str, *, message: str, duration_ms: int) -> None:
    # Increment in SQL (portable) so concurrent counters stay correct; the row
    # exists because record_start ran first.
    now = _now()
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE collector_health SET last_error = :e, duration_ms = :d, "
                "consecutive_failures = consecutive_failures + 1, updated_at = :now "
                "WHERE name = :n"
            ),
            {"e": message[:2000], "d": duration_ms, "now": now, "n": name},
        )
