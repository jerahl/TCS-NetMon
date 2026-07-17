"""Read-only SNMP inventory sweeps — the Phase 10.1 switching data layer.

Owner-approved charter amendment (CLAUDE.md §1, 2026-07-15): this extends the
poller's SNMP surface from `snmpget` sysUpTime to read-only `snmpbulkwalk`
subprocess sweeps — SAME net-snmp package, still GET-only, still NO Python SNMP
library. OIDs are taken verbatim from the owner's "Extreme EXOS by SNMP" Zabbix
template (spec 10 §4 appendix).

Design (spec 10 §4):
  * one supervised task + standalone `python -m netmon.poller.snmp_inventory
    --once|--loop`, like every collector;
  * concurrency-capped (default 8 switches in flight);
  * per-sweep enable flags + intervals, gated inside one task by elapsed time;
  * per-switch failure is isolated — its rows are left stale (never deleted),
    and the collector records loud into `collector_health` (§4.5);
  * replace-on-refresh: rows seen this sweep are upserted, rows not seen are
    pruned; `updated_at` on every row so the API renders staleness honestly.

The output parsers are PURE functions of `snmpbulkwalk -On` text so they are
unit-tested against captured fixtures without the binaries installed (§4.8).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.engine import Engine

from netmon import db, enums, health
from netmon.config import PollerConfig, SnmpInventoryConfig

log = logging.getLogger("netmon.snmp_inventory")

# --- OID roots (numeric), from the Extreme EXOS Zabbix template -------------
# IF-MIB / IF-MIB-ext (ifXTable) / EtherLike, indexed by ifIndex:
OID = {
    "if_oper": "1.3.6.1.2.1.2.2.1.8",
    "if_admin": "1.3.6.1.2.1.2.2.1.7",
    "if_descr": "1.3.6.1.2.1.2.2.1.2",
    "if_type": "1.3.6.1.2.1.2.2.1.3",
    "if_in_errors": "1.3.6.1.2.1.2.2.1.14",
    "if_out_errors": "1.3.6.1.2.1.2.2.1.20",
    "if_in_discards": "1.3.6.1.2.1.2.2.1.13",
    "if_out_discards": "1.3.6.1.2.1.2.2.1.19",
    "if_name": "1.3.6.1.2.1.31.1.1.1.1",
    "if_alias": "1.3.6.1.2.1.31.1.1.1.18",
    "if_highspeed": "1.3.6.1.2.1.31.1.1.1.15",
    "if_hc_in_octets": "1.3.6.1.2.1.31.1.1.1.6",
    "if_hc_out_octets": "1.3.6.1.2.1.31.1.1.1.10",
    "duplex": "1.3.6.1.2.1.10.7.2.1.19",  # dot3StatsDuplexStatus by ifIndex
    # BRIDGE-MIB FDB (not VLAN-scoped):
    "fdb_port": "1.3.6.1.2.1.17.4.3.1.2",      # dot1dTpFdbPort: MAC(suffix) -> bridge port
    "base_port_ifindex": "1.3.6.1.2.1.17.1.4.1.2",  # dot1dBasePortIfIndex: bport -> ifIndex
    # EXTREME-EDP-MIB extremeEdpTable (index: local slot.port; EDP is Extreme's
    # native neighbor protocol, on by default on EXOS — owner's authoritative
    # topology source). OIDs from the owner's Zabbix template (2026-07-16).
    "edp_name": "1.3.6.1.4.1.1916.1.13.2.1.3",     # neighbor system name
    "edp_version": "1.3.6.1.4.1.1916.1.13.2.1.4",  # neighbor EXOS version
    "edp_slot": "1.3.6.1.4.1.1916.1.13.2.1.5",     # neighbor slot
    "edp_port": "1.3.6.1.4.1.1916.1.13.2.1.6",     # neighbor port
    "edp_age": "1.3.6.1.4.1.1916.1.13.2.1.7",      # seconds since last refresh
    # Extreme extremeVlanIfTable:
    "vlan_name": "1.3.6.1.4.1.1916.1.2.1.2.1.2",
    "vlan_vid": "1.3.6.1.4.1.1916.1.2.1.2.1.10",
    "vlan_admin": "1.3.6.1.4.1.1916.1.2.1.2.1.12",
    # PoE per-port: standard pethPsePortTable (index slot.port) + Extreme
    # measured power (milliwatts). Fixture: tests/fixtures/snmp_exos_poe.txt.
    "poe_admin": "1.3.6.1.2.1.105.1.1.1.3",
    "poe_detect": "1.3.6.1.2.1.105.1.1.1.6",
    "poe_class": "1.3.6.1.2.1.105.1.1.1.10",
    "poe_power_mw": "1.3.6.1.4.1.1916.1.27.2.1.1.6",
    # PoE per-slot budgets: EXTREME-POE-MIB extremePethPseSlotTable (index =
    # slot; watts). OIDs/units per the owner's Zabbix template (2026-07-16).
    "poe_slot_budget": "1.3.6.1.4.1.1916.1.27.1.2.1.2",
    "poe_slot_alloc": "1.3.6.1.4.1.1916.1.27.1.2.1.3",
    "poe_slot_status": "1.3.6.1.4.1.1916.1.27.1.2.1.8",
    "poe_slot_avail": "1.3.6.1.4.1.1916.1.27.1.2.1.10",
    "poe_slot_capacity": "1.3.6.1.4.1.1916.1.27.1.2.1.11",
    "poe_slot_measured": "1.3.6.1.4.1.1916.1.27.1.2.1.14",
    # ENTITY-MIB physical inventory (fixture: snmp_exos_entity.txt). The
    # Slot-N container (class 5) holds the switch module (class 9) whose
    # descr is the human model and softwareRev the EXOS version; fans (7)
    # and PSUs (6) carry their slot in descr / container descr.
    "ent_descr": "1.3.6.1.2.1.47.1.1.1.1.2",
    "ent_contained": "1.3.6.1.2.1.47.1.1.1.1.4",
    "ent_class": "1.3.6.1.2.1.47.1.1.1.1.5",
    "ent_sw": "1.3.6.1.2.1.47.1.1.1.1.10",
    "ent_serial": "1.3.6.1.2.1.47.1.1.1.1.11",
    # Extreme stacking + per-slot sensors:
    "stack_status": "1.3.6.1.4.1.1916.1.33.2.1.3",
    "stack_temp": "1.3.6.1.4.1.1916.1.33.2.1.21",
    "cpu_5m": "1.3.6.1.4.1.1916.1.32.1.4.1.9",
    "mem_total": "1.3.6.1.4.1.1916.1.32.2.2.1.2",
    "mem_avail": "1.3.6.1.4.1.1916.1.32.2.2.1.3",
}

# net-snmp `-On` line: ".1.3.6... = TYPE: value"  or  ".1.3.6... = value"
_WALK_LINE = re.compile(r"^\s*(\.[0-9.]+)\s*=\s*(.*)$")
_TYPE_PREFIX = re.compile(
    r"^(INTEGER|STRING|Hex-STRING|Gauge32|Counter32|Counter64|IpAddress|"
    r"OID|Timeticks|OCTET STRING|BITS|Opaque|Network Address):\s*"
)

# IF-MIB ifOperStatus enum -> our oper_state vocabulary.
_OPER = {"1": "up", "2": "down", "3": "unknown", "4": "unknown", "5": "unknown",
         "6": "absent", "7": "down"}
_DUPLEX = {"1": "unknown", "2": "half", "3": "full"}
# extremePethSlotPoeStatus (per the owner's template description).
_POE_SLOT_STATUS = {
    "1": "initializing", "2": "operational", "3": "downloadFail",
    "4": "calibrationRequired", "5": "invalidFirmware", "6": "mismatchVersion",
    "7": "updating", "8": "invalidDevice", "9": "notOperational", "10": "other",
}

# extremeStackMemberOperStatus (1.3.6.1.4.1.1916.1.33.2.1.3): the raw integer
# is not human-readable — decode it here (owner-confirmed 2026-07-17).
_STACK_STATUS = {"0": "unknown", "1": "up", "2": "down", "3": "mismatch"}


def _clean_value(raw: str) -> str:
    v = _TYPE_PREFIX.sub("", raw.strip())
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        v = v[1:-1]
    return v.strip()


def parse_walk(output: str, root: str) -> dict[str, str]:
    """Parse `snmpbulkwalk -On <root>` text into {index_suffix: value}.

    ``index_suffix`` is the numeric OID with the ``root`` prefix removed (leading
    dot stripped) — e.g. root ``…2.2.1.8`` and OID ``….2.2.1.8.1015`` -> ``1015``.
    Type prefixes (``INTEGER:``) and surrounding quotes are stripped. Lines that
    don't match (SNMP errors, blanks) are skipped.
    """
    root_dot = "." + root.lstrip(".")
    out: dict[str, str] = {}
    for line in output.splitlines():
        m = _WALK_LINE.match(line)
        if not m:
            continue
        oid, raw = m.group(1), m.group(2)
        if oid == root_dot:
            suffix = ""
        elif oid.startswith(root_dot + "."):
            suffix = oid[len(root_dot) + 1:]
        else:
            continue
        out[suffix] = _clean_value(raw)
    return out


def _to_int(v: str | None):
    if v is None:
        return None
    try:
        return int(str(v).strip().split()[0])
    except (ValueError, IndexError):
        return None


def _enum_int(v: str | None) -> str | None:
    """Extract an enum's integer whether net-snmp rendered it numerically ("1")
    or MIB-translated ("up(1)", "full(3)") depending on installed MIBs."""
    if v is None:
        return None
    s = str(v).strip()
    m = re.search(r"\((\d+)\)", s) or re.match(r"(\d+)", s)
    return m.group(1) if m else None


def _oper_state(v: str | None) -> str:
    n = _enum_int(v)
    if n is not None:
        return _OPER.get(n, "unknown")
    s = (v or "").strip().lower()
    return {"up": "up", "down": "down"}.get(s, "unknown")


def _member_from_name(name: str | None):
    """EXOS port names are "slot:port" (e.g. "1:18"); the slot is the stack
    member. A bare port number has no member."""
    if name and ":" in name:
        head = name.split(":", 1)[0]
        return _to_int(head)
    return None


def mac_from_fdb_suffix(suffix: str) -> str | None:
    """dot1dTpFdbAddress is encoded as 6 dotted decimal octets in the OID
    suffix, e.g. ``0.11.130.1.2.3`` -> ``00:0b:82:01:02:03``."""
    parts = suffix.split(".")
    if len(parts) != 6:
        return None
    try:
        return ":".join(f"{int(p):02x}" for p in parts)
    except ValueError:
        return None


# --- pure sweep parsers: raw walk dicts -> list[row dict] -------------------

def is_physical_port(ifindex: int) -> bool:
    """EXOS ifIndex semantics (owner, 2026-07-16): the ifTable carries far
    more than front-panel ports. Excluded from the port inventory:

    - ``>= 1_000_000``  — VLAN/routing interfaces, one per VLAN;
    - ``slot*1000``     — the slot's management port (1000, 2000, …);
    - port part 2xx     — stacking ports (1257, 2258, …).

    Front-panel ports are ``slot*1000 + port`` with port 1–199.
    """
    if ifindex >= 1_000_000:
        return False
    port = ifindex % 1000
    if port == 0:
        return False
    if 200 <= port <= 299:
        return False
    return True


def build_ports(walks: dict[str, dict[str, str]]) -> list[dict]:
    """Combine the per-column IF-MIB walks into one row per *physical* ifIndex
    (VLAN/mgmt/stacking interfaces are dropped — ``is_physical_port``)."""
    ifindexes: set[str] = set()
    for key in ("if_oper", "if_name", "if_descr", "if_type"):
        ifindexes.update(walks.get(key, {}))
    rows: list[dict] = []
    for idx in sorted(ifindexes, key=lambda s: _to_int(s) or 0):
        n = _to_int(idx)
        if n is None or not is_physical_port(n):
            continue
        name = walks.get("if_name", {}).get(idx) or walks.get("if_descr", {}).get(idx)
        rows.append({
            "ifindex": _to_int(idx),
            "name": name,
            "member": _member_from_name(name),
            "oper_state": _oper_state(walks.get("if_oper", {}).get(idx)),
            "admin_up": 1 if _enum_int(walks.get("if_admin", {}).get(idx)) == "1" else 0,
            "speed_mbps": _to_int(walks.get("if_highspeed", {}).get(idx)),
            "duplex": _DUPLEX.get(_enum_int(walks.get("duplex", {}).get(idx)) or "", None),
            "in_octets": _to_int(walks.get("if_hc_in_octets", {}).get(idx)),
            "out_octets": _to_int(walks.get("if_hc_out_octets", {}).get(idx)),
            "err_in": _to_int(walks.get("if_in_errors", {}).get(idx)),
            "err_out": _to_int(walks.get("if_out_errors", {}).get(idx)),
            "disc_in": _to_int(walks.get("if_in_discards", {}).get(idx)),
            "disc_out": _to_int(walks.get("if_out_discards", {}).get(idx)),
        })
    return [r for r in rows if r["ifindex"] is not None]


def build_fdb(fdb_port: dict[str, str], base_port_ifindex: dict[str, str]) -> list[dict]:
    """MAC -> ifIndex, via bridge-port indirection."""
    port_to_if = {p: _to_int(v) for p, v in base_port_ifindex.items()}
    rows: list[dict] = []
    for suffix, bport in fdb_port.items():
        mac = mac_from_fdb_suffix(suffix)
        if mac is None:
            continue
        rows.append({"mac": mac, "ifindex": port_to_if.get(str(bport).strip())})
    return rows


def build_edp(walks: dict[str, dict[str, str]]) -> list[dict]:
    """extremeEdpTable → neighbor rows. The row index is the LOCAL slot.port
    (EXOS ifIndex = slot*1000 + port, the same scheme as ifName). EDP is
    point-to-point, so one neighbor per local port; last-writer-wins if a
    walk ever returns duplicates. remote_sysdesc carries the neighbor's EXOS
    version; remote_chassis stays NULL (EDP carries no chassis MAC)."""
    by_local: dict[int, dict] = {}
    keys: set[str] = set()
    for k in ("edp_name", "edp_version", "edp_slot", "edp_port", "edp_age"):
        keys.update(walks.get(k, {}))
    g = walks.get
    for idx in keys:
        parts = idx.split(".")
        slot, port = _to_int(parts[0]), (_to_int(parts[1]) if len(parts) > 1 else None)
        if slot is None:
            continue
        local = slot * 1000 + port if port is not None else slot
        r_slot = _to_int(g("edp_slot", {}).get(idx))
        r_port = _to_int(g("edp_port", {}).get(idx))
        remote_port = (f"{r_slot}:{r_port}" if r_slot is not None and r_port is not None
                       else (str(r_port) if r_port is not None else None))
        by_local[local] = {
            "local_ifindex": local,
            "remote_sysname": g("edp_name", {}).get(idx),
            "remote_port": remote_port,
            "remote_sysdesc": g("edp_version", {}).get(idx),
            "remote_chassis": None,
            "protocol": "edp",
            "age_s": _to_int(g("edp_age", {}).get(idx)),
        }
    return list(by_local.values())


def build_vlans(walks: dict[str, dict[str, str]]) -> list[dict]:
    names = walks.get("vlan_name", {})
    vids = walks.get("vlan_vid", {})
    admins = walks.get("vlan_admin", {})
    rows: list[dict] = []
    for idx in sorted(set(names) | set(vids)):
        vid = _to_int(vids.get(idx))
        if vid is None:
            continue
        rows.append({
            "vlan_id": vid,
            "name": names.get(idx),
            "admin_up": 1 if _enum_int(admins.get(idx)) == "1" else 0,
        })
    return rows


def build_poe_ports(walks: dict[str, dict[str, str]]) -> list[dict]:
    """pethPsePortTable (+ Extreme measured mW) → per-port PoE rows.

    Index is ``slot.port`` → ifIndex ``slot*1000 + port`` (same EXOS scheme
    as the port names). Ports whose detection status reads ``0`` are not
    PoE-capable on EXOS and are skipped — their columns stay NULL, never a
    fabricated "off". Class value is IEEE class + 1 (1 → class0).
    """
    detects = walks.get("poe_detect", {})
    rows: list[dict] = []
    for idx, detect_raw in detects.items():
        parts = idx.split(".")
        if len(parts) != 2:
            continue
        slot, port = _to_int(parts[0]), _to_int(parts[1])
        if slot is None or port is None:
            continue
        detect = _to_int(_enum_int(detect_raw) or detect_raw)
        if not detect:  # 0 -> not a PoE port
            continue
        cls = _to_int(_enum_int(walks.get("poe_class", {}).get(idx)))
        mw = _to_int(walks.get("poe_power_mw", {}).get(idx))
        rows.append({
            "ifindex": slot * 1000 + port,
            "poe_admin": 1 if _enum_int(walks.get("poe_admin", {}).get(idx)) == "1" else 0,
            "poe_delivering": 1 if detect == 3 else 0,
            "poe_class": f"class{cls - 1}" if cls and cls >= 1 else None,
            "poe_watts": round(mw / 1000.0, 1) if mw is not None else None,
        })
    return rows


def build_poe_slots(walks: dict[str, dict[str, str]]) -> list[dict]:
    """extremePethPseSlotTable → per-slot budget rows (watts)."""
    slots = set()
    for k in ("poe_slot_budget", "poe_slot_status", "poe_slot_avail"):
        slots.update(walks.get(k, {}))
    rows: list[dict] = []
    for idx in sorted(slots, key=lambda s: _to_int(s) or 0):
        slot = _to_int(idx)
        if slot is None:
            continue
        g = walks.get
        rows.append({
            "slot": slot,
            "poe_status": _POE_SLOT_STATUS.get(_enum_int(g("poe_slot_status", {}).get(idx)) or ""),
            "poe_budget_w": _to_int(g("poe_slot_budget", {}).get(idx)),
            "poe_alloc_w": _to_int(g("poe_slot_alloc", {}).get(idx)),
            "poe_avail_w": _to_int(g("poe_slot_avail", {}).get(idx)),
            "poe_capacity_w": _to_int(g("poe_slot_capacity", {}).get(idx)),
            "poe_measured_w": _to_int(g("poe_slot_measured", {}).get(idx)),
        })
    return rows


_SLOT_DESCR = re.compile(r"^Slot-(\d+)$")
_SLOT_PREFIX = re.compile(r"^Slot-(\d+)\b")


def build_entity_slots(walks: dict[str, dict[str, str]]) -> list[dict]:
    """ENTITY-MIB → per-slot inventory: model/serial/EXOS version + fan/PSU
    presence lists. Slot number comes from the ``Slot-N`` container descr
    (modules in ``Slot-N Option Slot-M`` VIM containers are naturally
    excluded because their container descr isn't exactly ``Slot-N``)."""
    descr = walks.get("ent_descr", {})
    cls = walks.get("ent_class", {})
    contained = walks.get("ent_contained", {})

    def _slot(slots: dict, n: int) -> dict:
        return slots.setdefault(n, {"slot": n, "model": None, "serial": None,
                                    "fw_version": None, "fans": [], "psus": []})

    # class-5 containers whose descr is exactly "Slot-N" -> slot number.
    container_slot: dict[str, int] = {}
    for idx, d in descr.items():
        m = _SLOT_DESCR.match((d or "").strip())
        if m and _enum_int(cls.get(idx)) == "5":
            container_slot[idx] = int(m.group(1))

    slots: dict[int, dict] = {}
    for idx, raw_cls in cls.items():
        c = _enum_int(raw_cls)
        if c == "9":  # module — the switch itself when directly in a Slot-N container
            parent = str(_to_int(contained.get(idx)) or "")
            if parent in container_slot:
                s = _slot(slots, container_slot[parent])
                s["model"] = (descr.get(idx) or "").strip() or None
                s["serial"] = (walks.get("ent_serial", {}).get(idx) or "").strip() or None
                s["fw_version"] = (walks.get("ent_sw", {}).get(idx) or "").strip() or None
        elif c == "7":  # fan — "Slot-N FanTray M"
            d = (descr.get(idx) or "").strip()
            m = _SLOT_PREFIX.match(d)
            if m:
                _slot(slots, int(m.group(1)))["fans"].append(
                    d[m.end():].strip() or d)
        elif c == "6":  # PSU — slot + bay from its container's descr
            parent = str(_to_int(contained.get(idx)) or "")
            pd = (descr.get(parent) or "").strip()
            m = _SLOT_PREFIX.match(pd)
            if m:
                bay = pd.rsplit(" ", 1)[-1]
                label = (descr.get(idx) or "").strip() or "PSU"
                _slot(slots, int(m.group(1)))["psus"].append(f"bay {bay}: {label}")
    for s in slots.values():
        s["fans"].sort()
        s["psus"].sort()
    return [slots[k] for k in sorted(slots)]


def build_stack(walks: dict[str, dict[str, str]],
                status_map: dict[str, str] | None = None) -> list[dict]:
    status_map = _STACK_STATUS if status_map is None else status_map
    slots = set()
    for k in ("stack_status", "stack_temp", "cpu_5m", "mem_total"):
        slots.update(walks.get(k, {}))
    rows: list[dict] = []
    for idx in sorted(slots, key=lambda s: _to_int(s) or 0):
        slot = _to_int(idx)
        if slot is None:
            continue
        total = _to_int(walks.get("mem_total", {}).get(idx))
        avail = _to_int(walks.get("mem_avail", {}).get(idx))
        mem_pct = round((total - avail) / total * 100, 2) if total and avail is not None and total > 0 else None
        temp_raw = _to_int(walks.get("stack_temp", {}).get(idx))
        status_raw = _enum_int(walks.get("stack_status", {}).get(idx))
        rows.append({
            "slot": slot,
            # Decode the Extreme oper-status enum (map is owner-editable via the
            # web); fall back to the raw value for a code we have no label for
            # (never blank).
            "status": status_map.get(status_raw or "", status_raw),
            "cpu_pct": _to_int(walks.get("cpu_5m", {}).get(idx)),
            "mem_pct": mem_pct,
            "temp_c": temp_raw,
        })
    return rows


# --- rate computation (spec §1: "rates without history") --------------------

def compute_rates(row: dict, prev: dict | None, now_ts: float) -> dict:
    """Turn raw counters into kbps/util/err-deltas using the previous sample
    stored on the row. Returns the fields to persist (incl. the new
    prev_counters). Counter resets / first samples yield NULL rates, not spikes.
    """
    out = {
        "in_kbps": None, "out_kbps": None, "util_pct": None,
        "err_in_delta": None, "err_out_delta": None,
        "disc_in_delta": None, "disc_out_delta": None,
    }
    cur = {
        "in_octets": row.get("in_octets"), "out_octets": row.get("out_octets"),
        "err_in": row.get("err_in"), "err_out": row.get("err_out"),
        "disc_in": row.get("disc_in"), "disc_out": row.get("disc_out"),
        "ts": now_ts,
    }
    if prev and prev.get("ts"):
        dt = now_ts - float(prev["ts"])
        if dt > 0:
            def rate_kbps(c, p):
                if c is None or p is None or c < p:  # reset/rollover -> skip
                    return None
                return int((c - p) * 8 / 1000 / dt)

            def delta(c, p):
                if c is None or p is None or c < p:
                    return None
                return c - p

            out["in_kbps"] = rate_kbps(cur["in_octets"], prev.get("in_octets"))
            out["out_kbps"] = rate_kbps(cur["out_octets"], prev.get("out_octets"))
            out["err_in_delta"] = delta(cur["err_in"], prev.get("err_in"))
            out["err_out_delta"] = delta(cur["err_out"], prev.get("err_out"))
            out["disc_in_delta"] = delta(cur["disc_in"], prev.get("disc_in"))
            out["disc_out_delta"] = delta(cur["disc_out"], prev.get("disc_out"))
            speed = row.get("speed_mbps")
            if speed and speed > 0 and out["in_kbps"] is not None and out["out_kbps"] is not None:
                busier = max(out["in_kbps"], out["out_kbps"])
                out["util_pct"] = round(min(100.0, busier / (speed * 1000) * 100), 2)
    out["prev_counters"] = json.dumps(cur)
    return out


# --- the collector ----------------------------------------------------------

WalkFn = Callable[[str, list[str]], Awaitable[dict[str, str]]]

_SWITCHES_SQL = """
SELECT id, name, mgmt_ip FROM devices
WHERE enabled = 1 AND device_type = 'switch' AND snmp_capable = 1 AND mgmt_ip IS NOT NULL
ORDER BY id
"""

# sweep name -> (config-enabled attr, interval attr, OID keys it needs)
_SWEEP_OIDS = {
    "ports": ("sweep_ports", "ports_interval_s",
              ["if_oper", "if_admin", "if_descr", "if_type", "if_name", "if_alias",
               "if_highspeed", "if_hc_in_octets", "if_hc_out_octets",
               "if_in_errors", "if_out_errors", "if_in_discards", "if_out_discards", "duplex"]),
    "poe": ("sweep_poe", "poe_interval_s",
            ["poe_admin", "poe_detect", "poe_class", "poe_power_mw",
             "poe_slot_budget", "poe_slot_alloc", "poe_slot_status",
             "poe_slot_avail", "poe_slot_capacity", "poe_slot_measured"]),
    "fdb": ("sweep_fdb", "fdb_interval_s", ["fdb_port", "base_port_ifindex"]),
    "edp": ("sweep_edp", "edp_interval_s",
            ["edp_name", "edp_version", "edp_slot", "edp_port", "edp_age"]),
    "vlans": ("sweep_vlans", "vlans_interval_s", ["vlan_name", "vlan_vid", "vlan_admin"]),
    "entity": ("sweep_entity", "entity_interval_s",
               ["ent_descr", "ent_contained", "ent_class", "ent_sw", "ent_serial"]),
    "stack": ("sweep_stack", "stack_interval_s",
              ["stack_status", "stack_temp", "cpu_5m", "mem_total", "mem_avail"]),
}


class SnmpInventory:
    """SNMP inventory sweep collector (poller sibling, spec 10 §4).

    Not a source ``Collector`` subclass — it reads the switch fleet and writes
    the 006 inventory tables — but it uses the same ``collector_health``
    heartbeat/error boundary and the same standalone contract.
    """

    name = "snmp_inventory"

    def __init__(self, engine: Engine, cfg: SnmpInventoryConfig,
                 poller: PollerConfig, walk_fn: WalkFn | None = None) -> None:
        self.engine = engine
        self.cfg = cfg
        self.poller = poller
        self._walk = walk_fn or self._snmpbulkwalk
        # fastest configured interval drives the supervised task; each sweep is
        # gated internally by its own interval.
        self.interval_s = float(min(
            cfg.ports_interval_s, cfg.poe_interval_s, cfg.fdb_interval_s,
            cfg.edp_interval_s, cfg.vlans_interval_s, cfg.stack_interval_s,
            cfg.entity_interval_s,
        ))
        # The run budget is deliberately NOT the fastest interval: the first
        # run has every sweep due at once (~29 bulkwalks/switch fleet-wide)
        # and legitimately outlives ports_interval_s. Overrunning the interval
        # just delays the next supervisor tick; only run_timeout_s cancels.
        self.timeout_s = float(max(cfg.run_timeout_s, self.interval_s))
        self._last_run: dict[str, float] = {}
        self._force_all = False

    @classmethod
    def from_config(cls, engine: Engine, cfg) -> "SnmpInventory":
        return cls(engine, cfg.snmp_inventory, cfg.poller)

    # -- subprocess walk (the only non-pure part) --
    async def _snmpbulkwalk(self, host: str, roots: list[str]) -> dict[str, str]:
        """Run one read-only snmpbulkwalk per root; return combined -On text
        keyed by root OID. GET-only; no writes ever issued."""
        results: dict[str, str] = {}
        for root in roots:
            cmd = [
                self.cfg.snmpbulkwalk_path,
                f"-v{self.poller.snmp_version}",
                "-c", self.poller.snmp_community,
                "-t", str(self.poller.snmp_timeout_s),
                "-r", str(self.poller.snmp_retries),
                "-On",  # numeric OIDs so the parser is MIB-independent
                host, root,
            ]
            t0 = time.monotonic()
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            out, err = await proc.communicate()
            text = out.decode(errors="replace")
            results[root] = text
            if log.isEnabledFor(logging.DEBUG):
                log.debug("walk %s %s: rc=%s, %d line(s), %.2fs%s",
                          host, root, proc.returncode, len(text.splitlines()),
                          time.monotonic() - t0,
                          f", stderr: {err.decode(errors='replace').strip()}" if err.strip() else "")
        return results

    def _due(self, sweep: str, now: float) -> bool:
        enabled_attr, interval_attr, _ = _SWEEP_OIDS[sweep]
        if not getattr(self.cfg, enabled_attr):
            return False
        if self._force_all:
            return True
        last = self._last_run.get(sweep)
        return last is None or (now - last) >= getattr(self.cfg, interval_attr)

    async def _walk_keys(self, host: str, keys: list[str]) -> dict[str, dict[str, str]]:
        roots = [OID[k] for k in keys]
        raw = await self._walk(host, roots)
        return {k: parse_walk(raw.get(OID[k], ""), OID[k]) for k in keys}

    # Fleet-pass order when several sweeps are due at once: cheap/high-cadence
    # first, so a cancelled run has already banked the data operators watch
    # most (ports, stack) before the heavy FDB walk starts.
    _SWEEP_ORDER = ("ports", "stack", "poe", "fdb", "edp", "vlans", "entity")

    def _check_credentials(self) -> None:
        """Fail loud on credentials that can only produce fleet-wide silent
        timeouts, instead of burning a full pass and reporting them as network
        problems. A wrong-but-plausible community still times out (v2c gives
        no error signal) — the DEBUG fingerprint below exists to compare the
        effective value against the one that works by hand, without ever
        logging the secret itself."""
        community = self.poller.snmp_community
        if not community:
            raise RuntimeError(
                "[poller] snmp_community is empty — the sweep reuses the "
                "poller's SNMP credentials; every switch would silently "
                "time out. Set it in netmon.conf (or the Settings page)."
            )
        if community != community.strip() or (
            len(community) >= 2 and community[0] == community[-1] and community[0] in "\"'"
        ):
            # configparser keeps quotes and inline comments literally; a shell
            # strips them — the classic "works in the CLI, times out from
            # Python" shape. Warn, don't guess: quotes are technically legal.
            log.warning(
                "snmp_community looks quoted or padded (len=%d) — INI values "
                "are taken literally; if manual snmpbulkwalk works but the "
                "sweep times out, remove the quotes/comment in netmon.conf",
                len(community),
            )
        if log.isEnabledFor(logging.DEBUG):
            import hashlib
            fp = hashlib.sha256(community.encode()).hexdigest()[:8]
            log.debug(
                "snmp credentials: -v%s, community len=%d sha256:%s "
                "(compare: printf '%%s' '<community>' | sha256sum | cut -c1-8)",
                self.poller.snmp_version, len(community), fp,
            )

    async def run_once(self) -> int:
        now = time.monotonic()
        due = [s for s in self._SWEEP_ORDER if self._due(s, now)]
        if not due:
            return 0
        self._check_credentials()
        # Owner-editable decode maps, read once per run (picked up on the next
        # sweep after an admin edits them — no restart).
        self._stack_status_map = enums.effective_map(self.engine, "stack_status")
        switches = db.fetch_all(self.engine, _SWITCHES_SQL)
        log.info("run: sweep(s) due: %s · %d switch(es), concurrency %d",
                 ", ".join(due), len(switches), self.cfg.concurrency)
        total = 0
        # One fleet pass per due sweep, marking _last_run as each pass
        # completes — a run cancelled mid-way (supervisor budget) keeps the
        # finished sweeps' timestamps instead of re-queuing everything, so a
        # slow fleet converges sweep by sweep rather than looping on timeout.
        for sweep in due:
            pass_started = time.monotonic()
            sem = asyncio.Semaphore(max(1, self.cfg.concurrency))
            errors: list[str] = []

            async def one(sw, _sweep=sweep) -> int:
                async with sem:
                    t0 = time.monotonic()
                    try:
                        n = await self._sweep_switch(sw, [_sweep])
                    except Exception as exc:  # isolate — one dead switch never fails the fleet
                        log.warning("snmp_inventory: %s %s (%s) failed: %r",
                                    _sweep, sw["name"], sw["mgmt_ip"], exc)
                        errors.append(f"{_sweep} {sw['name']}: {exc!r}")
                        return 0
                    log.debug("%s %s (%s): %d row(s) in %.1fs",
                              _sweep, sw["name"], sw["mgmt_ip"], n, time.monotonic() - t0)
                    return n

            counts = await asyncio.gather(*(one(sw) for sw in switches))
            self._last_run[sweep] = now
            total += sum(counts)
            log.info("sweep %s done: %d row(s), %d/%d switch(es) failed, %.1fs",
                     sweep, sum(counts), len(errors), len(switches),
                     time.monotonic() - pass_started)
            if errors and len(errors) == len(switches) and switches:
                # every switch failed → surface as a collector failure (fail loud).
                raise RuntimeError(f"all {len(switches)} switches failed: {errors[0]}")
        return total

    async def _sweep_switch(self, sw, due: list[str]) -> int:
        host, dev_id = sw["mgmt_ip"], sw["id"]
        written = 0
        if "ports" in due:
            walks = await self._walk_keys(host, _SWEEP_OIDS["ports"][2])
            written += self._write_ports(dev_id, build_ports(walks))
        if "poe" in due:
            walks = await self._walk_keys(host, _SWEEP_OIDS["poe"][2])
            written += self._write_poe(dev_id, build_poe_ports(walks), build_poe_slots(walks))
        if "fdb" in due:
            walks = await self._walk_keys(host, _SWEEP_OIDS["fdb"][2])
            rows = build_fdb(walks["fdb_port"], walks["base_port_ifindex"])
            written += self._replace(dev_id, "fdb_entries", "mac", rows)
        if "edp" in due:
            walks = await self._walk_keys(host, _SWEEP_OIDS["edp"][2])
            written += self._replace(dev_id, "neighbors", "local_ifindex", build_edp(walks))
        if "vlans" in due:
            walks = await self._walk_keys(host, _SWEEP_OIDS["vlans"][2])
            written += self._replace(dev_id, "switch_vlans", "vlan_id", build_vlans(walks))
        if "entity" in due:
            walks = await self._walk_keys(host, _SWEEP_OIDS["entity"][2])
            written += self._write_entity(dev_id, build_entity_slots(walks))
        if "stack" in due:
            walks = await self._walk_keys(host, _SWEEP_OIDS["stack"][2])
            status_map = getattr(self, "_stack_status_map", None)
            written += self._replace(dev_id, "stack_members", "slot",
                                     build_stack(walks, status_map))
        return written

    # -- persistence: upsert seen rows, prune rows not seen this sweep --
    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    def _upsert_many(self, table: str, dev_id: int, key_col: str, rows: list[dict]) -> int:
        """Batched, portable replace-on-refresh for one device's rows in one
        transaction: a single existing-keys SELECT, one executemany UPDATE,
        one executemany INSERT, and the not-seen prune — a handful of
        statements instead of ~3 per row. The per-row upsert dominated the
        ports pass at fleet scale (~16k rows × 3 round-trips every 120s).

        Runs only after a successful sweep parsed ``rows`` — a failed sweep
        raised earlier, so stale rows stay visible, never blanked (§4.5).
        All ``rows`` must share one key set (the build_* parsers guarantee it).
        """
        with self.engine.begin() as conn:
            existing = {r[0] for r in conn.execute(
                text(f"SELECT {key_col} FROM {table} WHERE device_id = :d"),
                {"d": dev_id},
            )}
            if rows:
                cols = [c for c in rows[0] if c != key_col]
                params = [{**r, "device_id": dev_id} for r in rows]
                updates = [p for p in params if p[key_col] in existing]
                inserts = [p for p in params if p[key_col] not in existing]
                if updates:
                    set_clause = ", ".join(f"{c} = :{c}" for c in cols)
                    conn.execute(
                        text(f"UPDATE {table} SET {set_clause} "
                             f"WHERE device_id = :device_id AND {key_col} = :{key_col}"),
                        updates,
                    )
                if inserts:
                    all_cols = ["device_id", key_col, *cols]
                    conn.execute(
                        text(f"INSERT INTO {table} ({', '.join(all_cols)}) "
                             f"VALUES ({', '.join(f':{c}' for c in all_cols)})"),
                        inserts,
                    )
            # Prune rows not seen this sweep (all of them when the sweep
            # legitimately parsed zero rows).
            seen = [r[key_col] for r in rows]
            if not seen:
                conn.execute(text(f"DELETE FROM {table} WHERE device_id = :d"), {"d": dev_id})
            else:
                placeholders = ", ".join(f":k{i}" for i in range(len(seen)))
                conn.execute(
                    text(f"DELETE FROM {table} WHERE device_id = :d "
                         f"AND {key_col} NOT IN ({placeholders})"),
                    {"d": dev_id, **{f"k{i}": v for i, v in enumerate(seen)}},
                )
        return len(rows)

    def _write_poe(self, dev_id: int, port_rows: list[dict], slot_rows: list[dict]) -> int:
        """Partial UPDATEs onto rows the ports/stack sweeps own. Deliberately:
        no INSERT (a port/slot unseen by its owning sweep doesn't exist yet —
        the next PoE pass catches it), no prune, and no ``updated_at`` bump
        (freshness must keep reflecting the owning sweep, or a stalled ports
        sweep would hide behind PoE-refreshed timestamps — §4.5)."""
        with self.engine.begin() as conn:
            if port_rows:
                conn.execute(
                    text("UPDATE switch_ports SET poe_admin = :poe_admin, "
                         "poe_delivering = :poe_delivering, poe_class = :poe_class, "
                         "poe_watts = :poe_watts "
                         "WHERE device_id = :device_id AND ifindex = :ifindex"),
                    [{**r, "device_id": dev_id} for r in port_rows],
                )
            if slot_rows:
                conn.execute(
                    text("UPDATE stack_members SET poe_status = :poe_status, "
                         "poe_budget_w = :poe_budget_w, poe_alloc_w = :poe_alloc_w, "
                         "poe_avail_w = :poe_avail_w, poe_capacity_w = :poe_capacity_w, "
                         "poe_measured_w = :poe_measured_w "
                         "WHERE device_id = :device_id AND slot = :slot"),
                    [{**r, "device_id": dev_id} for r in slot_rows],
                )
        return len(port_rows) + len(slot_rows)

    def _write_entity(self, dev_id: int, slot_rows: list[dict]) -> int:
        """Partial UPDATEs of stack_members inventory columns (same contract
        as _write_poe: no insert, no prune, no updated_at bump — the stack
        sweep owns the rows and their freshness)."""
        if not slot_rows:
            return 0
        params = [{
            "device_id": dev_id, "slot": r["slot"], "model": r["model"],
            "serial": r["serial"], "fw_version": r["fw_version"],
            "fans": json.dumps(r["fans"]), "psus": json.dumps(r["psus"]),
        } for r in slot_rows]
        with self.engine.begin() as conn:
            conn.execute(
                text("UPDATE stack_members SET model = :model, serial = :serial, "
                     "fw_version = :fw_version, fans = :fans, psus = :psus "
                     "WHERE device_id = :device_id AND slot = :slot"),
                params,
            )
        return len(slot_rows)

    def _write_ports(self, dev_id: int, rows: list[dict]) -> int:
        now, now_ts = self._now(), time.time()
        # Previous counter samples for the whole switch in ONE query (was one
        # SELECT per port — the other half of the ports-pass round-trips).
        prev_map: dict[int, dict] = {}
        for r in db.fetch_all(
            self.engine,
            "SELECT ifindex, prev_counters FROM switch_ports WHERE device_id = :d",
            {"d": dev_id},
        ):
            if r.get("prev_counters"):
                try:
                    prev_map[r["ifindex"]] = json.loads(r["prev_counters"])
                except (TypeError, ValueError):
                    pass
        out: list[dict] = []
        for r in rows:
            rates = compute_rates(r, prev_map.get(r["ifindex"]), now_ts)
            out.append({
                "ifindex": r["ifindex"], "name": r["name"], "member": r["member"],
                "oper_state": r["oper_state"], "admin_up": r["admin_up"],
                "speed_mbps": r["speed_mbps"], "duplex": r["duplex"],
                "updated_at": now, **rates,
            })
        return self._upsert_many("switch_ports", dev_id, "ifindex", out)

    def _replace(self, dev_id: int, table: str, key_col: str, rows: list[dict]) -> int:
        now = self._now()
        return self._upsert_many(
            table, dev_id, key_col, [{**r, "updated_at": now} for r in rows]
        )

    async def run_guarded(self) -> None:
        health.record_start(self.engine, self.name)
        started = time.monotonic()
        try:
            written = await self.run_once()
        except asyncio.CancelledError:
            # The supervisor's run budget (run_timeout_s) — or shutdown —
            # cancelled us mid-run. CancelledError is a BaseException, so
            # without this clause the timeout would land only in supervisor
            # stats while collector_health kept its stale last_success and the
            # source pill stayed green (§4.5 violation). Record, then re-raise:
            # cancellation must still propagate.
            elapsed = time.monotonic() - started
            health.record_error(
                self.engine, self.name,
                message=f"run cancelled after {elapsed:.0f}s "
                        f"(run_timeout_s={self.timeout_s:.0f} or shutdown); "
                        f"completed sweeps kept, rest retry next tick",
                duration_ms=int(elapsed * 1000),
            )
            raise
        except Exception as exc:
            health.record_error(self.engine, self.name, message=repr(exc),
                                duration_ms=int((time.monotonic() - started) * 1000))
            log.exception("snmp_inventory sweep failed")
            return
        elapsed = time.monotonic() - started
        if written:
            log.info("run complete: %d row(s) in %.1fs", written, elapsed)
        health.record_success(self.engine, self.name, records=written,
                              duration_ms=int(elapsed * 1000))


def main(argv: list[str] | None = None) -> int:
    import argparse
    from netmon.config import load_config

    parser = argparse.ArgumentParser(description="Read-only SNMP inventory sweeps.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="run every enabled sweep once")
    mode.add_argument("--loop", action="store_true", help="run forever on the interval")
    parser.add_argument("--config", default=None)
    parser.add_argument(
        "-v", "--verbose", action="store_true",
        help="per-switch and per-walk detail (rows, durations, snmpbulkwalk "
             "rc/stderr); default shows per-sweep pass progress only",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if args.verbose:
        # Keep third-party chatter out of the trace — verbose means OUR sweep
        # detail. SQLAlchemy notably treats logger level INFO as "echo every
        # statement", so it must sit at WARNING.
        logging.getLogger("sqlalchemy").setLevel(logging.WARNING)
        logging.getLogger("asyncio").setLevel(logging.INFO)
    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)
    # Web-managed overrides ride along in standalone runs too (spec 12 S9).
    from netmon import settings as settings_engine
    cfg = settings_engine.overlay_config(cfg, engine)
    collector = SnmpInventory.from_config(engine, cfg)

    async def _run() -> None:
        if args.once:
            collector._force_all = True  # standalone --once ignores per-sweep gating
            await collector.run_guarded()
            return
        while True:
            await collector.run_guarded()
            await asyncio.sleep(collector.interval_s)

    asyncio.run(_run())
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
