"""XIQ collector — federate ExtremeCloud IQ device status into device_state.

Fast cycle: fetch the fleet device list, write each matched device's
``source_status`` (up/down). If XIQ is unreachable (401/transport/5xx) mark all
XIQ devices ``blind``; a 429 is a throttle, not blind. Read-only.

    python -m netmon.collectors.xiq --once|--loop
"""

from __future__ import annotations

import logging
import sys
from typing import Any

from pydantic import ValidationError
from sqlalchemy.engine import Engine

from netmon import db
from netmon.collectors.base import Collector, run_standalone
from netmon.collectors.xiq_client import (
    BASE_URL,
    XiqAuthError,
    XiqClient,
    XiqError,
    XiqRateLimitError,
)
from netmon.config import Config
from netmon.models.xiq import XiqDevice
from netmon.state import write_state

log = logging.getLogger("netmon.collectors.xiq")

DIMENSION = "source_status"
RATE_LIMIT_WARN = 500


class XiqCollector(Collector):
    name = "xiq"

    def __init__(self, engine: Engine, client: XiqClient, interval_s: float = 180.0) -> None:
        super().__init__(engine)
        self.client = client
        self.interval_s = interval_s
        self.timeout_s = max(60.0, interval_s)

    @classmethod
    def from_config(cls, engine: Engine, cfg: Config) -> "XiqCollector":
        src = cfg.sources.get("xiq")
        settings = src.settings if src else {}
        token = (settings.get("api_token") or "").strip()
        base_url = (settings.get("base_url") or BASE_URL).strip()
        interval = int(settings.get("status_interval_s") or 180)
        return cls(engine, XiqClient(token, base_url), interval_s=interval)

    def _registry(self) -> list[dict[str, Any]]:
        return db.fetch_all(
            self.engine,
            "SELECT id, xiq_device_id, mgmt_ip FROM devices "
            "WHERE enabled = 1 AND xiq_device_id IS NOT NULL AND xiq_device_id <> ''",
        )

    async def run_once(self) -> int:
        registry = self._registry()
        try:
            raw = await self.client.get_devices()
        except XiqRateLimitError:
            # Reachable but throttled — do NOT blind healthy devices; leave state.
            log.warning("XIQ rate limited; leaving device_state unchanged this cycle")
            raise
        except XiqError:
            # Auth/transport/5xx → source unreachable. Blind, loud, no stale-as-fresh.
            self._mark_blind(registry)
            raise

        fleet: dict[str, XiqDevice] = {}
        for row in raw:
            try:
                dev = XiqDevice.model_validate(row)
            except ValidationError as exc:
                log.warning("XIQ device row failed validation, skipping: %s", exc)
                continue
            fleet[str(dev.id)] = dev

        written = 0
        for r in registry:
            dev = fleet.get(str(r["xiq_device_id"]))
            if dev is None:
                # In our registry but absent from a *successful* fleet fetch —
                # leave prior state rather than fabricate a down/blind.
                continue
            value = "up" if dev.connected else "down"
            severity = "ok" if dev.connected else "crit"
            write_state(self.engine, int(r["id"]), DIMENSION, value, severity, "xiq")
            if not r.get("mgmt_ip") and dev.ip_address:
                db.execute(
                    self.engine,
                    "UPDATE devices SET mgmt_ip = :ip "
                    "WHERE id = :id AND (mgmt_ip IS NULL OR mgmt_ip = '')",
                    {"ip": dev.ip_address, "id": int(r["id"])},
                )
            written += 1

        rem = self.client.rate_limit_remaining
        if rem is not None and rem < RATE_LIMIT_WARN:
            log.warning("XIQ quota low: %s requests remaining this window", rem)
        return written

    def _mark_blind(self, registry: list[dict[str, Any]]) -> None:
        for r in registry:
            write_state(self.engine, int(r["id"]), DIMENSION, "blind", "warn", "xiq")


def main(argv: list[str] | None = None) -> int:
    try:
        return run_standalone(lambda engine, cfg: XiqCollector.from_config(engine, cfg), argv)
    except XiqError as exc:
        print(f"error: {exc} — set [xiq] api_token in the config.", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
