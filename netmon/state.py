"""Shared device_state writer with transition logging, plus the shared
read-side semantics of "is this device up?".

Used by collectors (the poller keeps its own hysteresis-aware path). Upserts the
current value into ``device_state`` (refreshing ``updated_at`` for liveness) and,
when the settled value changes, appends one row to the append-only
``state_events``. A previously-absent state is treated as coming from
``unknown`` so the first observation is itself a recorded transition.

``device_reachable``/``device_down`` live here because more than one API needs
to answer the same question the same way (the site roll-up and the switch
navigator). Duplicating the rules invited them to drift — the
snmp-is-positive-evidence-only subtlety in particular.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db

# Flag columns every caller must select for the helpers below. Keeping the
# projection next to the predicates stops a caller from omitting a dimension
# and silently getting a wrong verdict (the 2026-07-27 false-down bug: the
# flags SQL didn't select `snmp` at all, so the tiebreaker could never fire).
REACHABILITY_FLAGS_SQL = """\
       MAX(CASE WHEN s.dimension = 'ping' AND s.value = 'up' THEN 1 ELSE 0 END) AS ping_up,
       MAX(CASE WHEN s.dimension = 'ping' AND s.value = 'down' THEN 1 ELSE 0 END) AS ping_down,
       MAX(CASE WHEN s.dimension = 'source_status' AND s.value = 'up' THEN 1 ELSE 0 END) AS source_up,
       MAX(CASE WHEN s.dimension = 'source_status' AND s.value = 'down' THEN 1 ELSE 0 END) AS source_down,
       MAX(CASE WHEN s.dimension = 'snmp' AND s.value = 'up' THEN 1 ELSE 0 END) AS snmp_up,
       MAX(CASE WHEN s.device_id IS NULL THEN 0 ELSE 1 END) AS has_state"""


def device_reachable(d: dict[str, Any]) -> bool:
    """True if the device has a definitive reading in a reachability dimension.

    ``snmp_up`` counts — answering SNMP proves the device is alive. A bare
    ``snmp`` down does not: not answering proves nothing.
    """
    return bool(d.get("ping_up") or d.get("ping_down")
                or d.get("source_up") or d.get("source_down")
                or d.get("snmp_up"))


def device_down(d: dict[str, Any]) -> bool:
    """True if the device is down: native ``ping`` says so, or its source says
    so and no native probe contradicts it.

    The native poller is the tiebreaker (spec 00 / CLAUDE.md §1) — a device
    answering ICMP **or SNMP** is up even when its source reports it
    disconnected. ``ping = down`` stays authoritative over ``snmp = up``: that
    contradiction is one to surface, not to resolve here.
    """
    native_up = d.get("ping_up") or d.get("snmp_up")
    return bool(d.get("ping_down") or (d.get("source_down") and not native_up))


def write_state(
    engine: Engine,
    device_id: int,
    dimension: str,
    value: str,
    severity: str,
    source: str,
) -> bool:
    """Write current state; log an event iff the value changed. Returns changed."""
    now = datetime.now(timezone.utc)
    current = db.fetch_one(
        engine,
        "SELECT value FROM device_state WHERE device_id = :d AND dimension = :dim",
        {"d": device_id, "dim": dimension},
    )
    old = current["value"] if current else "unknown"

    db.upsert(
        engine,
        "device_state",
        {"device_id": device_id, "dimension": dimension},
        {"value": value, "severity": severity, "source": source, "updated_at": now},
    )

    if old != value:
        db.execute(
            engine,
            "INSERT INTO state_events "
            "(device_id, dimension, old_value, new_value, severity, source, occurred_at) "
            "VALUES (:d, :dim, :old, :new, :sev, :src, :at)",
            {"d": device_id, "dim": dimension, "old": old, "new": value,
             "sev": severity, "src": source, "at": now},
        )
        return True
    return False
