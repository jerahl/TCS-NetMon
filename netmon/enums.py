"""Owner-editable SNMP enum-decode maps.

A few SNMP status columns are integer enums whose vendor labels the owner may
need to correct without a code change — the Extreme stack member oper-status is
the motivating case (its meaning was clarified twice in the field). ``DEFAULTS``
is the code baseline; an admin may override the labels from the web and the
override lives in ``snapshot_cache`` under key ``enum.<name>``.

Effective map = ``{**default, **override}`` so an override only carries the
codes it changes and an unrecognised code always falls through to the baseline
(and, past that, to the raw value at the decode site — never blanked, §4.5).

The maps are read straight from the DB by the sweep at run time — no Config
overlay, no restart. A saved edit is picked up by the next sweep.
"""

from __future__ import annotations

import logging

from sqlalchemy.engine import Engine

from netmon import db
from netmon.snapshots import read_snapshot, write_snapshot

log = logging.getLogger("netmon.enums")

# name -> {code(str): label(str)}
DEFAULTS: dict[str, dict[str, str]] = {
    "stack_status": {"0": "unknown", "1": "up", "2": "down", "3": "mismatch"},
}

# name -> presentation/help metadata for the editor
META: dict[str, dict[str, str]] = {
    "stack_status": {
        "label": "Stack member status",
        "oid": "1.3.6.1.4.1.1916.1.33.2.1.3",
        "description": "extremeStackMemberOperStatus code → label, shown on the "
                       "Switches → Stack tab. The tab treats \"up\" as healthy; "
                       "every other label reads as a warning.",
    },
}

NAMES = tuple(DEFAULTS)


def _key(name: str) -> str:
    return f"enum.{name}"


def get_override(engine: Engine, name: str) -> dict[str, str]:
    """The admin's stored override for ``name`` ({} if none/unusable)."""
    snap = read_snapshot(engine, _key(name))
    payload = snap.get("payload") if snap else None
    if not isinstance(payload, dict):
        return {}
    return {str(k): str(v) for k, v in payload.items()}


def effective_map(engine: Engine, name: str) -> dict[str, str]:
    """Baseline overlaid with the stored override. Never raises — a missing
    ``snapshot_cache`` table or bad row degrades to the code default."""
    out = dict(DEFAULTS.get(name, {}))
    try:
        out.update(get_override(engine, name))
    except Exception as exc:  # DB/table trouble must not break a sweep
        log.warning("enum override for %s unavailable (%s); using defaults", name, exc)
    return out


def set_override(engine: Engine, name: str, mapping: dict[str, str]) -> None:
    write_snapshot(engine, _key(name),
                   {str(k): str(v) for k, v in mapping.items()}, source="config")


def clear_override(engine: Engine, name: str) -> None:
    """Revert to the code default by dropping the override row."""
    db.execute(engine, "DELETE FROM snapshot_cache WHERE `key` = :k", {"k": _key(name)})
