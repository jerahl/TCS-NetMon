"""Alert engine: evaluate rules → dedupe into open alerts → notify (shadow).

Runs as a supervised task. Portable SQL (SQLite tests / MariaDB prod); dedupe
is done with explicit open-alert lookups, not the MariaDB-only generated
`open_key` index.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db, health
from netmon.config import EngineConfig
from netmon.engine import rules
from netmon.engine.notify import record_notification

log = logging.getLogger("netmon.engine")


def _to_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class AlertEngine:
    name = "engine"

    def __init__(self, engine: Engine, cfg: EngineConfig) -> None:
        self.engine = engine
        self.cfg = cfg
        self.interval_s = cfg.interval_s
        self.timeout_s = max(30.0, cfg.interval_s)

    # --- queries -------------------------------------------------------------

    def _rules(self) -> list[dict[str, Any]]:
        return db.fetch_all(
            self.engine,
            "SELECT id, name, dimension, `condition`, severity, min_duration_s, target "
            "FROM alert_rules WHERE enabled = 1",
        )

    def _states(self, dimension: str) -> list[dict[str, Any]]:
        return db.fetch_all(
            self.engine,
            "SELECT device_id, value, updated_at FROM device_state WHERE dimension = :d",
            {"d": dimension},
        )

    def _held_since(self, device_id: int, dimension: str, fallback: Any) -> datetime | None:
        row = db.fetch_one(
            self.engine,
            "SELECT MAX(occurred_at) AS t FROM state_events "
            "WHERE device_id = :d AND dimension = :dim",
            {"d": device_id, "dim": dimension},
        )
        return _to_dt(row["t"]) if row and row["t"] else _to_dt(fallback)

    def _maintenance_active(self, device_id: int, now: datetime) -> bool:
        dev = db.fetch_one(self.engine, "SELECT site, device_type FROM devices WHERE id = :id",
                           {"id": device_id})
        if not dev:
            return False
        rows = db.fetch_all(
            self.engine,
            "SELECT scope_type, scope_value FROM maintenance_windows "
            "WHERE starts_at <= :now AND ends_at >= :now",
            {"now": now},
        )
        for w in rows:
            if w["scope_type"] == "device" and w["scope_value"] == str(device_id):
                return True
            if w["scope_type"] == "site" and w["scope_value"] == (dev.get("site") or ""):
                return True
            if w["scope_type"] == "device_type" and w["scope_value"] == dev["device_type"]:
                return True
        return False

    def _open_alert_id(self, device_id: int, rule_id: int) -> int | None:
        row = db.fetch_one(
            self.engine,
            "SELECT id FROM alerts WHERE device_id = :d AND rule_id = :r AND closed_at IS NULL "
            "ORDER BY id DESC LIMIT 1",
            {"d": device_id, "r": rule_id},
        )
        return int(row["id"]) if row else None

    # --- cycle ---------------------------------------------------------------

    async def run_once(self) -> int:
        now = datetime.now(timezone.utc)
        notified = 0
        for rule in self._rules():
            matched: set[int] = set()
            for st in self._states(rule["dimension"]):
                if not rules.evaluate(rule["condition"], st.get("value")):
                    continue
                device_id = int(st["device_id"])
                since = self._held_since(device_id, rule["dimension"], st.get("updated_at"))
                if since is not None and (now - since).total_seconds() < int(rule["min_duration_s"] or 0):
                    continue  # not held long enough yet
                matched.add(device_id)
                if self._open_alert_id(device_id, rule["id"]) is not None:
                    db.execute(self.engine,
                               "UPDATE alerts SET last_seen_at = :now WHERE device_id = :d "
                               "AND rule_id = :r AND closed_at IS NULL",
                               {"now": now, "d": device_id, "r": rule["id"]})
                    continue
                # New alert.
                db.execute(self.engine,
                           "INSERT INTO alerts (device_id, rule_id, opened_at, last_seen_at) "
                           "VALUES (:d, :r, :now, :now)",
                           {"d": device_id, "r": rule["id"], "now": now})
                alert_id = self._open_alert_id(device_id, rule["id"])
                suppressed = self._maintenance_active(device_id, now)
                record_notification(
                    self.engine, self.cfg, alert_id=alert_id or 0,
                    target=rule.get("target") or self.cfg.default_target,
                    summary=f"{rule['name']}: device {device_id} {rule['dimension']}={st.get('value')} ({rule['severity']})",
                    suppressed=suppressed,
                )
                notified += 1
            self._close_resolved(rule["id"], matched, now)
        return notified

    def _close_resolved(self, rule_id: int, matched: set[int], now: datetime) -> None:
        for row in db.fetch_all(
            self.engine,
            "SELECT id, device_id FROM alerts WHERE rule_id = :r AND closed_at IS NULL",
            {"r": rule_id},
        ):
            if int(row["device_id"]) not in matched:
                db.execute(self.engine, "UPDATE alerts SET closed_at = :now WHERE id = :id",
                           {"now": now, "id": row["id"]})

    async def run_guarded(self) -> None:
        health.record_start(self.engine, self.name)
        started = time.monotonic()
        try:
            n = await self.run_once()
        except Exception as exc:
            health.record_error(self.engine, self.name, message=repr(exc),
                                duration_ms=int((time.monotonic() - started) * 1000))
            log.exception("alert engine failed")
            return
        health.record_success(self.engine, self.name, records=n,
                              duration_ms=int((time.monotonic() - started) * 1000))
