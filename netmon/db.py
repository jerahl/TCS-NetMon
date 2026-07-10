"""Database layer — SQLAlchemy Core only, no ORM (CLAUDE.md §3).

Queries elsewhere are written as explicit, SQL-shaped statements against the
engine built here. This module owns engine construction and a couple of thin
helpers so call sites stay boring.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine


def make_engine(url: str) -> Engine:
    """Build a SQLAlchemy engine from a config URL.

    ``pool_pre_ping`` guards against MariaDB dropping idle connections between
    poll cycles. SQLite (dev/test) ignores pooling but the kwarg is harmless.
    """
    connect_args: dict[str, Any] = {}
    if url.startswith("sqlite"):
        # Allow the engine to be shared across the app's async tasks/threads.
        connect_args["check_same_thread"] = False
    return create_engine(url, pool_pre_ping=True, future=True, connect_args=connect_args)


def fetch_all(engine: Engine, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    """Run a SELECT and return rows as plain dicts."""
    with engine.connect() as conn:
        result = conn.execute(text(sql), params or {})
        return [dict(row) for row in result.mappings()]


def fetch_one(engine: Engine, sql: str, params: Mapping[str, Any] | None = None) -> dict[str, Any] | None:
    with engine.connect() as conn:
        row = conn.execute(text(sql), params or {}).mappings().first()
        return dict(row) if row is not None else None


def execute(engine: Engine, sql: str, params: Mapping[str, Any] | Iterable[Mapping[str, Any]] | None = None) -> int:
    """Run a write statement inside a transaction; return affected rowcount."""
    with engine.begin() as conn:
        result = conn.execute(text(sql), params or {})
        return result.rowcount


def healthcheck(engine: Engine) -> bool:
    """Cheap connectivity probe used by /healthz."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
