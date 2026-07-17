"""snapshot_cache helpers (spec 10 §3).

One row per page-level singleton/aggregate blob (PF cluster health, 3CX
system status, Milestone environment totals, …). Collectors are the only
writers; ``ok`` + ``updated_at`` let the API render staleness honestly —
a failed refresh flips ``ok`` to 0 and leaves the previous payload visible
(fail loud, stay stale — §4.5), it never blanks or fabricates.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db


def write_snapshot(engine: Engine, key: str, payload: Any, source: str, ok: bool = True) -> None:
    # `key` is a MariaDB reserved word — explicit SQL (db.upsert can't bind a
    # backticked identifier). ok=False keeps the previous payload visible
    # (stale, flagged); only a successful refresh replaces it.
    now = datetime.now(timezone.utc)
    params: dict[str, Any] = {"k": key, "source": source, "ok": 1 if ok else 0, "now": now}
    exists = db.fetch_one(
        engine, "SELECT 1 FROM snapshot_cache WHERE `key` = :k", {"k": key})
    if ok:
        params["payload"] = json.dumps(payload)
        if exists:
            db.execute(engine, "UPDATE snapshot_cache SET payload = :payload, "
                               "source = :source, ok = :ok, updated_at = :now "
                               "WHERE `key` = :k", params)
        else:
            db.execute(engine, "INSERT INTO snapshot_cache (`key`, payload, source, ok, updated_at) "
                               "VALUES (:k, :payload, :source, :ok, :now)", params)
    elif exists:
        db.execute(engine, "UPDATE snapshot_cache SET source = :source, ok = :ok, "
                           "updated_at = :now WHERE `key` = :k", params)
    else:
        db.execute(engine, "INSERT INTO snapshot_cache (`key`, payload, source, ok, updated_at) "
                           "VALUES (:k, NULL, :source, :ok, :now)", params)


def read_snapshot(engine: Engine, key: str) -> dict[str, Any] | None:
    """Return {payload, source, ok, updated_at} or None if never written."""
    row = db.fetch_one(
        engine,
        "SELECT payload, source, ok, updated_at FROM snapshot_cache WHERE `key` = :k",
        {"k": key},
    )
    if row is None:
        return None
    try:
        payload = json.loads(row["payload"]) if row.get("payload") else None
    except (TypeError, ValueError):
        payload = None
    return {"payload": payload, "source": row["source"], "ok": bool(row["ok"]),
            "updated_at": row["updated_at"]}
