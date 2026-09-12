"""Remember which access port a device is on, *while it is still healthy*.

Spec 22 §2b. This module exists because the obvious implementation of "cycle
the camera's PoE port" is impossible.

`uplink.uplink_for_mac()` finds a device's access port by looking it up in the
switch forwarding tables. Measured on this fleet on 2026-09-11:

    healthy cameras (300 sampled)   93% resolve to a PoE-cycle-safe port
                                     0% have no FDB entry
    cameras actually down (all 82)  18% resolve to a PoE-cycle-safe port
                                    79% have no FDB entry at all

A camera that has lost power stops transmitting, so the switch ages its MAC out
of the forwarding table within minutes. By the time remediation wants the port,
the evidence for it is gone — for four out of five of exactly the devices
remediation exists for.

So the lookup is moved earlier. This sampler walks devices that are **up**,
resolves each one's access port from a live FDB, and records the answer with
the `poe_cycle_safe` verdict *as it stood while the device was visible*. When
the device later dies, guard G5 reads the remembered row.

What it deliberately does not do:

* it never records a port for a device that is currently down — that is the
  reading that is wrong or missing, and overwriting a good memory with it would
  destroy the only evidence remediation has;
* it never upgrades `poe_cycle_safe`. The flag is copied from `uplink_for_mac`
  at confirmation time and stands or falls on that resolution;
* it stores `confirmed_at`, not just `updated_at`, because the question G5 asks
  is "how old is this evidence?" and a row refreshed with an unchanged answer
  must not look newer than the observation behind it.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db, health
from netmon.state import REACHABILITY_FLAGS_SQL, device_reachable, device_down
from netmon.uplink import uplink_for_mac

log = logging.getLogger("netmon.automation.portmemory")

#: Device types worth remembering a port for: the ones a PoE cycle can recover.
#: A switch is not in this list — nothing here power-cycles a switch.
POWERED_TYPES = ("camera", "ap")

# Candidate MACs come from whichever table knows the device's own address:
# `cameras.mac` (Milestone's hardwareDriverSettings) and `ap_details.mgmt_mac`
# (XIQ). Both are joined optionally so a fleet missing one still samples the
# other.
_CANDIDATES_SQL = f"""
SELECT d.id AS device_id, d.device_type AS device_type, d.name AS name,
       COALESCE(c.mac, a.mgmt_mac) AS mac,
{REACHABILITY_FLAGS_SQL}
FROM devices d
LEFT JOIN cameras c ON c.device_id = d.id
LEFT JOIN ap_details a ON a.device_id = d.id
LEFT JOIN device_state s ON s.device_id = d.id
WHERE d.enabled = 1 AND d.device_type IN ({', '.join(f"'{t}'" for t in POWERED_TYPES)})
GROUP BY d.id
HAVING mac IS NOT NULL AND mac <> ''
"""


class PortMemory:
    """Supervised task: refresh `device_port_memory` for healthy devices."""

    name = "port_memory"

    def __init__(self, engine: Engine, interval_s: float = 3600.0) -> None:
        self.engine = engine
        self.interval_s = interval_s
        # The FDB join is per-device and the fleet is ~3.4k rows, so give it
        # room; it is a read-only pass over tables the sweeps already filled.
        self.timeout_s = max(600.0, interval_s)

    async def run_once(self) -> int:
        return self.refresh()

    def refresh(self) -> int:
        rows = db.fetch_all(self.engine, _CANDIDATES_SQL)
        written = skipped_down = unresolved = 0
        for row in rows:
            flags = dict(row)
            # Only sample devices we can positively see. `device_reachable`
            # false means we have no definitive reading at all — an unknown
            # device's FDB answer is no more trustworthy than a dead one's.
            if not device_reachable(flags) or device_down(flags):
                skipped_down += 1
                continue
            best = uplink_for_mac(self.engine, row["mac"])
            if not best:
                unresolved += 1
                continue
            self._remember(int(row["device_id"]), str(row["mac"]), best)
            written += 1
        log.info("port_memory: %d remembered, %d skipped (down or unknown), "
                 "%d healthy but unresolved", written, skipped_down, unresolved)
        return written

    def _remember(self, device_id: int, mac: str, best: dict[str, Any]) -> None:
        # `confirmed_at` is stamped on every successful resolution: this row
        # *was* observed now, whether or not the answer changed. G5 measures
        # its age, so a refresh that confirms an unchanged port must still move
        # it forward. Written through the portable upsert helper rather than
        # MariaDB's ON DUPLICATE KEY so the tests can run on SQLite.
        db.upsert(
            self.engine, "device_port_memory",
            {"device_id": device_id},
            {
                "switch_device_id": int(best["switch_device_id"]),
                "ifindex": best.get("ifindex"),
                "port": best.get("port"),
                "poe_cycle_safe": 1 if best.get("poe_cycle_safe") else 0,
                "why": (best.get("why") or "")[:255],
                "macs_on_port": best.get("macs_on_port"),
                "mac": mac[:32],
                "confirmed_at": datetime.now(timezone.utc),
            },
        )

    def recall(self, device_id: int) -> dict[str, Any] | None:
        row = db.fetch_one(
            self.engine,
            "SELECT m.*, sw.name AS switch_name, sw.site AS switch_site "
            "FROM device_port_memory m "
            "LEFT JOIN devices sw ON sw.id = m.switch_device_id "
            "WHERE m.device_id = :d",
            {"d": device_id},
        )
        return dict(row) if row else None

    async def run_guarded(self) -> None:
        health.record_start(self.engine, self.name)
        started = time.monotonic()
        try:
            n = await self.run_once()
        except Exception as exc:
            health.record_error(self.engine, self.name, message=repr(exc),
                                duration_ms=int((time.monotonic() - started) * 1000))
            log.exception("port memory sampler failed")
            return
        health.record_success(self.engine, self.name, records=n,
                              duration_ms=int((time.monotonic() - started) * 1000))


def recall(engine: Engine, device_id: int) -> dict[str, Any] | None:
    """Module-level convenience for the guards, which hold no sampler."""
    return PortMemory(engine).recall(device_id)
