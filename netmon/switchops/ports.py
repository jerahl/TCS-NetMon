"""Port resolution and the refusal rules for direct switch writes.

The target is always resolved server-side from NetMon's own inventory: a
caller names a switch (registry id) and a port that must exist in
``switch_ports`` for it. Never an IP, never an OID.

**Index math.** EXOS names front-panel ports ``slot:port`` over SNMP — a
standalone switch as ``1:N`` — and numbers them ``ifIndex = slot*1000 + port``
(``snmp_inventory.is_physical_port``). The PoE tables (POWER-ETHERNET-MIB and
EXTREME-POE-MIB ``extremePethPsePortEntry``) are indexed
``{pethPsePortGroupIndex, pethPsePortIndex}`` = ``slot.port``. Verified by a
read-only walk of a 5-slot X465 stack on 32.5.1.5 (2026-11-16): groups 1–5 ×
48 ports for both tables, and ``extremePethPortResetPower`` present on every
PoE port reading clear(2). A switch that lacks the instance is refused at the
pre-read, never guessed at.

**Refusals** (owner decisions 2026-11-16):

* every action: the port must be a front-panel port NetMon has inventoried —
  that alone excludes the management port (``slot*1000``), stacking ports
  (``slot*1000 + 2xx``) and VLAN interfaces;
* PoE cycle: no other refusal. "A switch won't use PoE" — an uplink or
  inter-switch port draws no power, so cutting PoE on it changes nothing;
* port bounce: refuse ports that look like uplinks — an EDP neighbor (EDP is
  switch-to-switch on this all-Extreme fleet), an LLDP neighbor that is a
  registered switch, an end of a mapped fiber link, or an SFP/fiber port.
  Cameras, APs and phones send LLDP too, so an LLDP neighbor that is *not* a
  switch does not block. An admin may override by typing the port name;
  the override is recorded in the audit row.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy.engine import Engine

from netmon import db
from netmon.actions import ActionRefused
from netmon.poller.snmp_inventory import is_physical_port


class Unavailable(ActionRefused):
    """Refused because the capability is missing — not because of a policy.

    Distinct so the automation path may fall back to rConfig for *this* kind
    of refusal (no credentials, switch lacks the object) but never for a
    policy one (cooldown, uplink): falling back past a cooldown would defeat it.
    """


@dataclass
class Port:
    device_id: int
    switch_name: str
    mgmt_ip: str
    ifindex: int
    name: str
    slot: int
    port: int
    is_sfp: bool | None
    poe_capable: bool
    admin_up: bool | None

    @property
    def target(self) -> str:
        # Same spelling as the rConfig poe_cycle audit rows, so the cooldown
        # sees both paths.
        return f"port {self.name}"

    @property
    def poe_index(self) -> str:
        return f"{self.slot}.{self.port}"


@dataclass
class Verdict:
    allowed: bool
    reasons: list[str] = field(default_factory=list)
    overridable: bool = False


def parse_port_name(name: str) -> tuple[int, int]:
    """``"3:17"`` → (3, 17); a bare ``"17"`` is slot 1."""
    s = str(name).strip()
    if ":" in s:
        a, b = s.split(":", 1)
    else:
        a, b = "1", s
    try:
        slot, port = int(a), int(b)
    except ValueError:
        raise ActionRefused(f"{name!r} is not a slot:port front-panel port name") from None
    if not (1 <= slot <= 8 and 1 <= port <= 199):
        raise ActionRefused(f"{name!r} is outside the front-panel port range")
    return slot, port


def resolve(engine: Engine, device_id: int, port: str | int) -> Port:
    dev = db.fetch_one(
        engine,
        "SELECT id, name, device_type, mgmt_ip, enabled FROM devices WHERE id = :id",
        {"id": device_id},
    )
    if dev is None:
        raise ActionRefused(f"device {device_id} is not in the registry")
    if dev["device_type"] != "switch":
        raise ActionRefused(f"{dev['name']} is a {dev['device_type']}, not a switch")
    if not dev["enabled"]:
        raise ActionRefused(f"{dev['name']} is disabled in the registry")
    if not str(dev.get("mgmt_ip") or "").strip():
        raise ActionRefused(f"{dev['name']} has no management IP")
    as_int = None
    try:
        as_int = int(str(port).strip())
    except ValueError:
        pass
    row = db.fetch_one(
        engine,
        "SELECT ifindex, name, is_sfp, poe_admin, admin_up FROM switch_ports "
        "WHERE device_id = :d AND (name = :p OR ifindex = :i) ORDER BY ifindex LIMIT 1",
        {"d": device_id, "p": str(port).strip(), "i": as_int if as_int is not None else -1},
    )
    if row is None:
        raise ActionRefused(f"port {port!r} is not a known port on {dev['name']} "
                            "(run an SNMP inventory sweep first, or check the name)")
    ifindex = int(row["ifindex"])
    if not is_physical_port(ifindex):
        raise ActionRefused(f"ifIndex {ifindex} on {dev['name']} is not a front-panel port "
                            "(management, stacking and VLAN interfaces are never touched)")
    slot, pnum = parse_port_name(row["name"] or "")
    if ifindex != slot * 1000 + pnum:
        # The two numbering schemes disagree: refuse rather than pick one,
        # since a PoE SET is indexed by name and a bounce by ifIndex.
        raise ActionRefused(f"{dev['name']} port {row['name']} has ifIndex {ifindex}, "
                            f"expected {slot * 1000 + pnum}; refusing to guess which is right")
    return Port(
        device_id=int(dev["id"]), switch_name=str(dev["name"]),
        mgmt_ip=str(dev["mgmt_ip"]).strip(), ifindex=ifindex, name=str(row["name"]),
        slot=slot, port=pnum,
        is_sfp=None if row.get("is_sfp") is None else bool(row["is_sfp"]),
        poe_capable=row.get("poe_admin") is not None,
        admin_up=None if row.get("admin_up") is None else bool(row["admin_up"]),
    )


def uplink_reasons(engine: Engine, p: Port) -> list[str]:
    """Why this port looks like it carries other switches' traffic."""
    reasons: list[str] = []
    for n in db.fetch_all(
        engine,
        "SELECT n.remote_sysname, n.protocol, sw.id AS sw_id FROM neighbors n "
        "LEFT JOIN devices sw ON sw.name = n.remote_sysname AND sw.device_type = 'switch' "
        "WHERE n.device_id = :d AND n.local_ifindex = :i",
        {"d": p.device_id, "i": p.ifindex},
    ):
        proto = (n.get("protocol") or "edp").lower()
        if proto == "edp":
            reasons.append(f"EDP neighbor {n.get('remote_sysname') or '?'} (switch-to-switch link)")
        elif n.get("sw_id") is not None:
            reasons.append(f"LLDP neighbor {n['remote_sysname']} is a registered switch")
    if db.fetch_one(
        engine,
        "SELECT 1 AS x FROM fiber_links WHERE (a_device_id = :d AND a_ifindex = :i) "
        "OR (b_device_id = :d AND b_ifindex = :i) LIMIT 1",
        {"d": p.device_id, "i": p.ifindex},
    ):
        reasons.append("end of a mapped fiber link")
    if p.is_sfp:
        reasons.append("SFP/fiber port (uplinks on this fleet are fiber)")
    return reasons


def check(engine: Engine, p: Port, action: str, *, role: str,
          override_confirm: str | None = None) -> Verdict:
    """Policy refusals for one port. Cooldown/in-flight are checked separately."""
    if action == "snmp_poe_cycle":
        if not p.poe_capable:
            return Verdict(False, [f"{p.name} has no PoE (no POWER-ETHERNET-MIB row in inventory)"])
        return Verdict(True)
    if action == "snmp_port_bounce":
        reasons = uplink_reasons(engine, p)
        if p.admin_up is False:
            # Bouncing an admin-down port would *enable* it.
            return Verdict(False, [f"{p.name} is administratively down; a bounce would bring it up"])
        if not reasons:
            return Verdict(True)
        if override_confirm is not None and override_confirm.strip() == p.name:
            if role == "admin":
                return Verdict(True, [f"admin override of: {'; '.join(reasons)}"],
                               overridable=True)
            return Verdict(False, reasons + ["only an admin may override"], overridable=True)
        return Verdict(False, reasons, overridable=True)
    raise ActionRefused(f"unknown switch action {action!r}")


def cooldown_refusal(engine: Engine, p: Port, cooldown_s: int, *,
                     exclude_audit_id: int | None = None) -> str | None:
    """Any write to this port inside the cooldown — through either PoE path."""
    if cooldown_s <= 0:
        return None
    since = datetime.now(timezone.utc) - timedelta(seconds=cooldown_s)
    row = db.fetch_one(
        engine,
        "SELECT id, action, actor, requested_at FROM action_audit "
        "WHERE device_id = :d AND target = :t AND requested_at >= :since "
        "AND action IN ('snmp_poe_cycle','snmp_port_bounce','poe_cycle') "
        "AND outcome <> 'refused' AND id <> :me ORDER BY id DESC LIMIT 1",
        {"d": p.device_id, "t": p.target, "since": since, "me": exclude_audit_id or -1},
    )
    if row is None:
        return None
    return (f"{p.name} was last acted on by {row['actor']} ({row['action']}, "
            f"audit #{row['id']}) within the {cooldown_s}s cooldown")


def in_flight_refusal(engine: Engine, device_id: int, *, exclude_audit_id: int | None,
                      window_s: int = 300) -> str | None:
    """Another switch write still pending on this switch (any process)."""
    since = datetime.now(timezone.utc) - timedelta(seconds=window_s)
    row = db.fetch_one(
        engine,
        "SELECT id, actor, target FROM action_audit WHERE device_id = :d "
        "AND source = 'switch' AND outcome = 'pending' AND requested_at >= :since "
        "AND id <> :me ORDER BY id DESC LIMIT 1",
        {"d": device_id, "since": since, "me": exclude_audit_id or -1},
    )
    if row is None:
        return None
    return (f"another write is in flight on this switch ({row['target']}, by {row['actor']}, "
            f"audit #{row['id']}); one at a time per switch")
