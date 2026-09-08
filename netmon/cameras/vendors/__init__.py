"""Vendor profiles for camera operations (spec 20 S8 / D11).

A closed registry, like `netmon.actions.ACTIONS` and for the same reason: a
request names a vendor NetMon already knows how to talk to, never a mechanism it
supplies. Adding a vendor is a deliberate edit here plus a fixture-tested module
plus a spec update.

Matching is on the lowercase prefix of Milestone's *driver* name, exactly as
`netmon.snapshot.vendor_profile` does — this estate reports `Bosch1ch` (2,019),
`Bosch` (509), `ONVIF` (91) and four Axis variants (32), and new variants appear
with firmware.
"""

from __future__ import annotations

from typing import Any

from netmon.cameras.vendors import bosch

#: prefix → profile module. Bosch only, deliberately: 2,528 of 2,651 cameras
#: here are Bosch, it is the pilot vendor S8 names, and a profile that has never
#: been exercised against its own hardware is worse than an honest refusal.
PROFILES = {
    "bosch": bosch,
}


def profile_for(vendor: Any) -> Any | None:
    """The profile for a Milestone driver name, or None when there is none."""
    v = str(vendor or "").strip().lower()
    for prefix, module in PROFILES.items():
        if v.startswith(prefix):
            return module
    return None
