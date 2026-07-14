"""The native poller: probe → hysteresis → device_state/state_events.

Runs as two supervised tasks (ping, snmp) and standalone. Probers are
injectable so the write/hysteresis path is testable without fping/snmp binaries.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db, health
from netmon.config import PollerConfig
from netmon.poller import probes
from netmon.poller.hysteresis import HysteresisTracker

log = logging.getLogger("netmon.poller")

Prober = Callable[[list[str], PollerConfig], Awaitable[dict[str, bool]]]

PING = "ping"
SNMP = "snmp"


def _severity(dimension: str, settled: str) -> str:
    if settled == "up":
        return "ok"
    if settled == "down":
        # An unreachable device is critical; a silent SNMP agent is a warning.
        return "crit" if dimension == PING else "warn"
    return "unknown"


class Poller:
    def __init__(
        self,
        engine: Engine,
        cfg: PollerConfig,
        *,
        ping_sweep: Prober | None = None,
        snmp_sweep: Prober | None = None,
    ) -> None:
        self.engine = engine
        self.cfg = cfg
        self.tracker = HysteresisTracker(cfg.fail_threshold, cfg.ok_threshold)
        self._ping_sweep = ping_sweep or probes.fping_sweep
        self._snmp_sweep = snmp_sweep or probes.snmp_sweep
        self._loaded = False

    # --- state seeding -------------------------------------------------------

    def _load_initial_state(self) -> None:
        if self._loaded:
            return
        rows = db.fetch_all(
            self.engine,
            "SELECT device_id, dimension, value FROM device_state "
            "WHERE dimension IN ('ping','snmp')",
        )
        for r in rows:
            self.tracker.seed(int(r["device_id"]), str(r["dimension"]), str(r["value"] or "unknown"))
        self._loaded = True

    # --- device selection ----------------------------------------------------

    def _devices(self, dimension: str) -> list[dict[str, Any]]:
        sql = (
            "SELECT id, mgmt_ip FROM devices "
            "WHERE enabled = 1 AND mgmt_ip IS NOT NULL AND mgmt_ip <> ''"
        )
        if dimension == SNMP:
            sql += " AND snmp_capable = 1"
        return db.fetch_all(self.engine, sql)

    # --- sweeps --------------------------------------------------------------

    async def sweep_ping(self) -> int:
        self._load_initial_state()
        devices = self._devices(PING)
        ips = [d["mgmt_ip"] for d in devices]
        results = await self._ping_sweep(ips, self.cfg)
        return self._apply(devices, PING, results)

    async def sweep_snmp(self) -> int:
        self._load_initial_state()
        if not self.cfg.snmp_community:
            log.warning("poller: [poller] snmp_community is unset; skipping SNMP sweep")
            return 0
        devices = self._devices(SNMP)
        ips = [d["mgmt_ip"] for d in devices]
        results = await self._snmp_sweep(ips, self.cfg)
        return self._apply(devices, SNMP, results)

    def _apply(self, devices: list[dict[str, Any]], dimension: str, results: dict[str, bool]) -> int:
        now = datetime.now(timezone.utc)
        written = 0
        for d in devices:
            ip = d["mgmt_ip"]
            if ip not in results:
                # No verdict this sweep (e.g. fping didn't report it) — leave
                # prior state untouched rather than fabricate one.
                continue
            self._write(int(d["id"]), dimension, results[ip], now)
            written += 1
        return written

    def _write(self, device_id: int, dimension: str, ok: bool, now: datetime) -> None:
        transition = self.tracker.observe(device_id, dimension, ok)
        settled = self.tracker.settled(device_id, dimension)
        db.upsert(
            self.engine,
            "device_state",
            {"device_id": device_id, "dimension": dimension},
            {
                "value": settled,
                "severity": _severity(dimension, settled),
                "source": "poller",
                "updated_at": now,
            },
        )
        if transition is not None:
            db.execute(
                self.engine,
                "INSERT INTO state_events "
                "(device_id, dimension, old_value, new_value, severity, source, occurred_at) "
                "VALUES (:device_id, :dimension, :old, :new, :sev, 'poller', :at)",
                {
                    "device_id": device_id,
                    "dimension": dimension,
                    "old": transition.old,
                    "new": transition.new,
                    "sev": _severity(dimension, transition.new),
                    "at": now,
                },
            )
            log.info("poller: device %s %s %s→%s", device_id, dimension, transition.old, transition.new)

    # --- supervised task entry points (heartbeat + error boundary) -----------

    async def run_ping(self) -> None:
        await self._guarded("poller_ping", self.sweep_ping)

    async def run_snmp(self) -> None:
        await self._guarded("poller_snmp", self.sweep_snmp)

    async def _guarded(self, name: str, sweep: Callable[[], Awaitable[int]]) -> None:
        health.record_start(self.engine, name)
        started = time.monotonic()
        try:
            written = await sweep()
        except Exception as exc:  # fail loud into collector_health; keep prior state
            health.record_error(
                self.engine, name, message=repr(exc),
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            log.exception("poller task %s failed", name)
            return
        health.record_success(
            self.engine, name, records=written,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
