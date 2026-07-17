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


def upsert(
    engine: Engine,
    table: str,
    keys: Mapping[str, Any],
    values: Mapping[str, Any],
) -> None:
    """Portable insert-or-update on ``keys``.

    Uses SELECT-then-UPDATE/INSERT rather than MariaDB's
    ``ON DUPLICATE KEY UPDATE`` so the same code runs under SQLite (tests) and
    MariaDB (prod). ``table`` and column names are code-controlled identifiers,
    never user input. Single-writer callers (the poller) don't race here.
    """
    where = " AND ".join(f"{k} = :{k}" for k in keys)
    params = {**keys, **values}
    with engine.begin() as conn:
        exists = conn.execute(
            text(f"SELECT 1 FROM {table} WHERE {where}"), dict(keys)
        ).first()
        if exists is not None:
            if values:
                set_clause = ", ".join(f"{c} = :{c}" for c in values)
                conn.execute(text(f"UPDATE {table} SET {set_clause} WHERE {where}"), params)
        else:
            cols = list(keys) + list(values)
            collist = ", ".join(cols)
            vallist = ", ".join(f":{c}" for c in cols)
            conn.execute(text(f"INSERT INTO {table} ({collist}) VALUES ({vallist})"), params)


def replace_rows(
    engine: Engine,
    table: str,
    key_cols: list[str],
    rows: list[Mapping[str, Any]],
    scope: Mapping[str, Any] | None = None,
) -> int:
    """Batched, portable replace-on-refresh (spec 10 §1) in one transaction:
    one existing-keys SELECT, one executemany UPDATE, one executemany INSERT,
    and a prune of rows not seen this refresh. ``scope`` restricts the whole
    operation (e.g. ``{"device_id": 7}``); with no scope the refresh is
    table-wide (fleet sweeps). Identifiers are code-controlled, never user
    input. All ``rows`` must share one key set. Callers must only invoke this
    after a *successful* fetch — a failed fetch should raise first so stale
    rows stay visible (§4.5).
    """
    scope = dict(scope or {})
    scope_where = " AND ".join(f"{c} = :__scope_{c}" for c in scope)
    scope_params = {f"__scope_{c}": v for c, v in scope.items()}
    with engine.begin() as conn:
        sel = f"SELECT {', '.join(key_cols)} FROM {table}"
        if scope_where:
            sel += f" WHERE {scope_where}"
        existing = {tuple(r) for r in conn.execute(text(sel), scope_params)}

        if rows:
            cols = [c for c in rows[0] if c not in key_cols and c not in scope]
            params = [{**scope, **r} for r in rows]
            key_of = lambda r: tuple(r[c] for c in key_cols)  # noqa: E731
            updates = [p for p in params if key_of(p) in existing]
            inserts = [p for p in params if key_of(p) not in existing]
            key_where = " AND ".join(f"{c} = :{c}" for c in (*scope, *key_cols))
            if updates:
                set_clause = ", ".join(f"{c} = :{c}" for c in cols)
                conn.execute(
                    text(f"UPDATE {table} SET {set_clause} WHERE {key_where}"), updates
                )
            if inserts:
                all_cols = [*scope, *key_cols, *cols]
                conn.execute(
                    text(f"INSERT INTO {table} ({', '.join(all_cols)}) "
                         f"VALUES ({', '.join(f':{c}' for c in all_cols)})"),
                    inserts,
                )

        # Prune unseen rows within the scope.
        seen = [tuple(r[c] for c in key_cols) for r in rows]
        base_delete = f"DELETE FROM {table}"
        conds = [scope_where] if scope_where else []
        if not seen:
            where = f" WHERE {' AND '.join(conds)}" if conds else ""
            conn.execute(text(base_delete + where), scope_params)
        elif len(key_cols) == 1:
            placeholders = ", ".join(f":k{i}" for i in range(len(seen)))
            conds.append(f"{key_cols[0]} NOT IN ({placeholders})")
            conn.execute(
                text(base_delete + f" WHERE {' AND '.join(conds)}"),
                {**scope_params, **{f"k{i}": v[0] for i, v in enumerate(seen)}},
            )
        else:
            # Composite key: prune by comparing concatenated key tuples in
            # Python — fetch keys once (already have `existing`) and delete
            # the difference row by row (small sets: radios per device).
            stale = existing - set(seen)
            if stale:
                key_where = " AND ".join(f"{c} = :{c}" for c in key_cols)
                where = f" WHERE {' AND '.join([scope_where, key_where] if scope_where else [key_where])}"
                conn.execute(
                    text(base_delete + where),
                    [{**scope_params, **dict(zip(key_cols, k))} for k in stale],
                )
    return len(rows)


def healthcheck(engine: Engine) -> bool:
    """Cheap connectivity probe used by /healthz."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
