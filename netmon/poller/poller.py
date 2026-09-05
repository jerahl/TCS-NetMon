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


class SweepBlindError(RuntimeError):
    """A prober returned no verdicts at all for a non-empty target list.

    Distinct from "every target is down": a down target still produces a
    verdict. Zero verdicts means the probe never ran — a missing capability
    (fping needs CAP_NET_RAW; a sandboxed unit with an empty
    CapabilityBoundingSet silently strips it), a blocked binary, or a
    misbuilt command line. That is a blind sweep, and CLAUDE.md §4.5 says
    blind must never record as healthy.
    """


def _require_verdicts(dimension: str, targets: list[str], results: dict[str, bool]) -> None:
    """Raise if a non-empty sweep produced nothing. No targets is legitimate."""
    if targets and not results:
        raise SweepBlindError(
            f"{dimension} sweep returned 0 verdicts for {len(targets)} target(s) — "
            f"the probe did not run (check the binary and, for fping, CAP_NET_RAW)"
        )


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
        # `hardware_id` identifies the physical device behind a camera row.
        # Milestone models a camera as a channel of a hardware record, so one
        # device can present several camera rows on a single address — see
        # _ambiguous_ips.
        sql = (
            "SELECT d.id AS id, d.mgmt_ip AS mgmt_ip, c.hardware_id AS hardware_id "
            "FROM devices d LEFT JOIN cameras c ON c.device_id = d.id "
            "WHERE d.enabled = 1 AND d.mgmt_ip IS NOT NULL AND d.mgmt_ip <> ''"
        )
        if dimension == SNMP:
            sql += " AND d.snmp_capable = 1"
        params: dict[str, Any] = {}
        # Device types this sweep must skip. ICMP is not a liveness signal for
        # every class of device: 193 of 2,649 addressed cameras never answer it
        # while Milestone reports them recording, spread across every site — so
        # a non-answer there means the model does not do ICMP, and writing
        # `down` would raise crits that are provably wrong. SNMP is unaffected;
        # it is gated on snmp_capable, which no camera carries.
        excluded = tuple(getattr(self.cfg, "ping_exclude_device_types", ()) or ())
        if dimension == PING and excluded:
            keys = [f":x{i}" for i in range(len(excluded))]
            sql += f" AND d.device_type NOT IN ({', '.join(keys)})"
            params = {f"x{i}": t for i, t in enumerate(excluded)}
        return db.fetch_all(self.engine, sql, params)

    # --- sweeps --------------------------------------------------------------

    async def sweep_ping(self) -> int:
        self._load_initial_state()
        devices = self._devices(PING)
        ips = [d["mgmt_ip"] for d in devices]
        results = await self._ping_sweep(ips, self.cfg)
        _require_verdicts(PING, ips, results)
        return self._apply(devices, PING, results)

    async def sweep_snmp(self) -> int:
        self._load_initial_state()
        if not self.cfg.snmp_community:
            log.warning("poller: [poller] snmp_community is unset; skipping SNMP sweep")
            return 0
        devices = self._devices(SNMP)
        ips = [d["mgmt_ip"] for d in devices]
        results = await self._snmp_sweep(ips, self.cfg)
        _require_verdicts(SNMP, ips, results)
        return self._apply(devices, SNMP, results)

    def _apply(self, devices: list[dict[str, Any]], dimension: str, results: dict[str, bool]) -> int:
        now = datetime.now(timezone.utc)
        written = 0
        ambiguous = self._ambiguous_ips(devices)
        for d in devices:
            ip = d["mgmt_ip"]
            if ip not in results:
                # No verdict this sweep (e.g. fping didn't report it) — leave
                # prior state untouched rather than fabricate one.
                continue
            if ip in ambiguous:
                # More than one enabled device claims this address, so a single
                # probe cannot say which one answered. Writing the verdict to
                # all of them fabricates state: a decommissioned switch reads
                # `up` because its replacement answers at the same IP. Refuse
                # the verdict and leave prior state untouched (CLAUDE.md §4.5).
                continue
            self._write(int(d["id"]), dimension, results[ip], now)
            written += 1
        if ambiguous:
            log.warning(
                "poller: %d mgmt_ip(s) claimed by more than one physical device — "
                "no %s verdict written for %d device row(s); fix the registry "
                "(duplicate/stale entries): %s",
                len(ambiguous), dimension,
                sum(1 for d in devices if d["mgmt_ip"] in ambiguous),
                ", ".join(sorted(ambiguous)[:10]) + (" …" if len(ambiguous) > 10 else ""),
            )
        return written

    @staticmethod
    def _ambiguous_ips(devices: list[dict[str, Any]]) -> set[str]:
        """mgmt_ips claimed by more than one **physical device** in this sweep.

        Counting rows was wrong for cameras. Milestone models a camera as a
        channel of a hardware record, and 61 devices on this estate carry more
        than one — an AXIS M3007 panoramic carries eleven, all on one address
        and one network interface. Those eleven are up or down together, so
        treating them as eleven rivals refused a verdict that was never in
        doubt and left 239 cameras permanently unknown.

        Two *different* devices on one address are still ambiguous, which is
        the case the guard was built for (the 2026-07-28 oak-DEAD / DEAD_AP
        incident) and the case that still exists at 10.132.18.209, where a
        Bosch FLEXIDOME 5000i and 5100i are both registered.
        """
        claimants: dict[str, set[Any]] = {}
        for d in devices:
            # A camera's physical identity is its hardware; anything else is
            # its own device row.
            key = d.get("hardware_id") or ("dev", d["id"])
            claimants.setdefault(d["mgmt_ip"], set()).add(key)
        return {ip for ip, ks in claimants.items() if len(ks) > 1}

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
