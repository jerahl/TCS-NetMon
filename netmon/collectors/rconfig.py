"""rConfig collector — config-backup freshness (dimension `config_backup`).

Writes `fresh` / `stale` / `unknown` for devices matched by `rconfig_device_id`,
based on the last-backup age vs `stale_after_s`. Blind on unreachable.

    python -m netmon.collectors.rconfig --once|--loop
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.collectors.base import Collector, run_standalone
from netmon.collectors.rconfig_client import RConfigClient, RConfigError
from netmon.config import Config
from netmon.state import write_state

log = logging.getLogger("netmon.collectors.rconfig")

# last-backup timestamp field aliases (exact name validated at deploy).
_TS_KEYS = ("last_backup", "lastBackup", "last_success", "last_run", "last_change",
            "updated_at", "last_backup_date", "lastSuccessfulBackup")


def _parse_ts(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _last_backup(device: dict) -> datetime | None:
    for k in _TS_KEYS:
        if k in device:
            dt = _parse_ts(device[k])
            if dt is not None:
                return dt
    return None


class RConfigCollector(Collector):
    name = "rconfig"

    def __init__(self, engine: Engine, client: RConfigClient, interval_s: float = 600.0,
                 stale_after_s: int = 604800) -> None:
        super().__init__(engine)
        self.client = client
        self.interval_s = interval_s
        self.timeout_s = max(60.0, interval_s)
        self.stale_after_s = stale_after_s

    @classmethod
    def from_config(cls, engine: Engine, cfg: Config) -> "RConfigCollector":
        s = (cfg.sources.get("rconfig").settings if cfg.sources.get("rconfig") else {})
        client = RConfigClient(
            url=(s.get("url") or "").strip(),
            token=s.get("api_token") or "",
            verify_ssl=str(s.get("verify_ssl", "true")).strip().lower() in ("1", "true", "yes", "on"),
        )
        return cls(engine, client, interval_s=int(s.get("interval_s") or 600),
                   stale_after_s=int(s.get("stale_after_s") or 604800))

    def _registry(self) -> list[dict[str, Any]]:
        return db.fetch_all(
            self.engine,
            "SELECT id, rconfig_device_id FROM devices "
            "WHERE enabled = 1 AND rconfig_device_id IS NOT NULL AND rconfig_device_id <> ''",
        )

    async def run_once(self) -> int:
        registry = self._registry()
        try:
            devices = await self.client.devices()
        except RConfigError:
            for r in registry:
                write_state(self.engine, int(r["id"]), "config_backup", "blind", "warn", "rconfig")
            raise

        by_id = {str(d.get("id")): d for d in devices if d.get("id") is not None}
        now = datetime.now(timezone.utc)
        written = 0
        for r in registry:
            d = by_id.get(str(r["rconfig_device_id"]))
            if d is None:
                continue
            ts = _last_backup(d)
            if ts is None:
                value, sev = "unknown", "unknown"   # never fresh-when-unsure
            elif (now - ts).total_seconds() > self.stale_after_s:
                value, sev = "stale", "warn"
            else:
                value, sev = "fresh", "ok"
            write_state(self.engine, int(r["id"]), "config_backup", value, sev, "rconfig")
            written += 1
        return written


def main(argv: list[str] | None = None) -> int:
    try:
        return run_standalone(lambda engine, cfg: RConfigCollector.from_config(engine, cfg), argv)
    except RConfigError as exc:
        print(f"error: {exc} — set [rconfig] url (https)/api_token.", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
