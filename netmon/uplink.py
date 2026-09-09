"""Access-port resolution — which switch port a device is actually plugged into.

Shared by the AP and camera detail pages, because the hard part is identical and
getting it wrong is destructive in the same way.

A MAC is learned on *every* port in its path, not just the access port. On this
fleet a device's MAC appears on a median of 5 ports and up to 14, and all but
one are uplink trunks — so the naive "first FDB row" answer points a PoE cycle
at a 10G uplink carrying 168 MACs and takes out a wiring closet.
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db


# MAC spellings differ per source: ap_details.mgmt_mac arrives from XIQ
# unpunctuated ("bcf310163600"), while fdb_entries and pf_nodes store the
# colon form. Joining raw matched 0 of 783 APs; normalising matches 741.
_MACN = "LOWER(REPLACE(REPLACE(REPLACE({}, ':', ''), '-', ''), '.', ''))"

_AP_UPLINK_SQL = f"""
SELECT f.device_id AS switch_device_id, sw.name AS switch_name, sw.site AS switch_site,
       f.ifindex AS ifindex, sp.name AS port, sp.poe_delivering AS poe_delivering,
       sp.poe_watts AS poe_watts, sp.is_sfp AS is_sfp, sp.speed_mbps AS speed_mbps,
       sp.oper_state AS oper_state, f.vlan_id AS vlan_id, f.updated_at AS updated_at,
       (SELECT COUNT(*) FROM fdb_entries f2
         WHERE f2.device_id = f.device_id AND f2.ifindex = f.ifindex) AS macs_on_port
FROM fdb_entries f
JOIN devices sw ON sw.id = f.device_id
LEFT JOIN switch_ports sp ON sp.device_id = f.device_id AND sp.ifindex = f.ifindex
WHERE {_MACN.format('f.mac')} = :mac
ORDER BY macs_on_port ASC
"""


def _pf_port_form(port: Any) -> str | None:
    """PacketFence spells an Extreme stacked port "5035"; SNMP spells it "5:35"."""
    p = str(port or "").strip()
    if not p:
        return None
    if ":" in p:
        return p
    if p.isdigit() and len(p) >= 4:
        return f"{int(p[:-3])}:{int(p[-3:])}"
    return p


def uplink_for_mac(engine: Engine, mac: str | None, pf: dict | None = None) -> dict | None:
    """Which switch port a device is plugged into, from the FDB.

    A MAC is learned on *every* port in its path, not just the access port:
    on this fleet a device's MAC appears on a median of 5 ports and up to 14, and
    all but one of them are uplink trunks. Taking any FDB row would therefore
    point Cycle PoE at a 10G uplink carrying 168 MACs — bouncing a whole
    switch's worth of devices instead of one AP.

    The access port is the one carrying the fewest MACs, and two independent
    signals corroborate it: it should be copper (``is_sfp = 0``) and actually
    delivering PoE. Fleet-wide the fewest-MACs pick is PoE-delivering for 91%
    of devices and copper for 94%.

    ``poe_cycle_safe`` is that corroboration, and it gates the destructive
    action rather than the display: an uplink that cannot be confirmed is still
    shown (with its candidates) but must not be power-cycled on a guess.
    """
    norm = re.sub(r"[^0-9a-f]", "", str(mac or "").lower())
    if len(norm) != 12:
        return None
    rows = [dict(r) for r in db.fetch_all(engine, _AP_UPLINK_SQL, {"mac": norm})]
    if not rows:
        return None
    best = rows[0]
    corroborated = best.get("poe_delivering") == 1 and best.get("is_sfp") == 0
    # A tie on MAC count means the fewest-MACs rule did not actually pick a
    # winner, so it is not evidence of anything.
    tied = len(rows) > 1 and rows[1].get("macs_on_port") == best.get("macs_on_port")
    # Second, independent source. PacketFence records the switch and port it
    # last saw the endpoint on, derived from RADIUS/SNMP traps rather than from
    # the FDB — so agreement is genuine corroboration, not the same evidence
    # counted twice. Across the fleet the two agree on 485 APs and disagree on
    # 32; every one of those 32 already failed the PoE/copper test, so this
    # check has never been the only thing standing between an operator and the
    # wrong port. It is here so that stays true when the fleet changes.
    pf_port = _pf_port_form((pf or {}).get("last_port"))
    own_port = _pf_port_form(best.get("port"))
    pf_agrees = None if not pf_port or not own_port else (pf_port == own_port)

    best["candidates"] = len(rows)
    best["pf_agrees"] = pf_agrees
    best["pf_port"] = pf_port
    best["poe_cycle_safe"] = bool(corroborated and not tied and pf_agrees is not False)
    best["why"] = (
        "PacketFence last saw this endpoint on a different port"
        if pf_agrees is False
        else "ambiguous — two ports tie on MAC count" if tied
        else "port is not confirmed as PoE-delivering copper, so it may be an uplink"
        if not corroborated
        else "fewest MACs on port, PoE-delivering copper"
        + (", confirmed by PacketFence" if pf_agrees else "")
    )
    return best
