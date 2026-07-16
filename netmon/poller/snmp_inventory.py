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

from sqlalchemy.engine import Engine

from netmon import db, health
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
    # LLDP-MIB lldpRemTable (index: timemark.localPort.remIndex):
    "lldp_sysname": "1.0.8802.1.1.2.1.4.1.1.9",
    "lldp_portid": "1.0.8802.1.1.2.1.4.1.1.7",
    "lldp_portdesc": "1.0.8802.1.1.2.1.4.1.1.8",
    "lldp_sysdesc": "1.0.8802.1.1.2.1.4.1.1.10",
    "lldp_chassis": "1.0.8802.1.1.2.1.4.1.1.5",
    # Extreme extremeVlanIfTable:
    "vlan_name": "1.3.6.1.4.1.1916.1.2.1.2.1.2",
    "vlan_vid": "1.3.6.1.4.1.1916.1.2.1.2.1.10",
    "vlan_admin": "1.3.6.1.4.1.1916.1.2.1.2.1.12",
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

def build_ports(walks: dict[str, dict[str, str]]) -> list[dict]:
    """Combine the per-column IF-MIB walks into one row per ifIndex."""
    ifindexes: set[str] = set()
    for key in ("if_oper", "if_name", "if_descr", "if_type"):
        ifindexes.update(walks.get(key, {}))
    rows: list[dict] = []
    for idx in sorted(ifindexes, key=lambda s: _to_int(s) or 0):
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


def build_lldp(walks: dict[str, dict[str, str]]) -> list[dict]:
    """lldpRemTable index is timemark.localPortNum.remIndex — the middle field
    is the local ifIndex. Last-writer-wins if several neighbours share a port."""
    by_local: dict[int, dict] = {}
    keys = set()
    for k in ("lldp_sysname", "lldp_portid", "lldp_portdesc", "lldp_sysdesc", "lldp_chassis"):
        keys.update(walks.get(k, {}))
    for idx in keys:
        parts = idx.split(".")
        if len(parts) < 3:
            continue
        local = _to_int(parts[1])
        if local is None:
            continue
        g = walks.get
        by_local[local] = {
            "local_ifindex": local,
            "remote_sysname": g("lldp_sysname", {}).get(idx),
            "remote_port": g("lldp_portdesc", {}).get(idx) or g("lldp_portid", {}).get(idx),
            "remote_sysdesc": g("lldp_sysdesc", {}).get(idx),
            "remote_chassis": g("lldp_chassis", {}).get(idx),
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


def build_stack(walks: dict[str, dict[str, str]]) -> list[dict]:
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
        rows.append({
            "slot": slot,
            "status": walks.get("stack_status", {}).get(idx),
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
    "fdb": ("sweep_fdb", "fdb_interval_s", ["fdb_port", "base_port_ifindex"]),
    "lldp": ("sweep_lldp", "lldp_interval_s",
             ["lldp_sysname", "lldp_portid", "lldp_portdesc", "lldp_sysdesc", "lldp_chassis"]),
    "vlans": ("sweep_vlans", "vlans_interval_s", ["vlan_name", "vlan_vid", "vlan_admin"]),
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
            cfg.ports_interval_s, cfg.fdb_interval_s, cfg.lldp_interval_s,
            cfg.vlans_interval_s, cfg.stack_interval_s,
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
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            out, _ = await proc.communicate()
            results[root] = out.decode(errors="replace")
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
    _SWEEP_ORDER = ("ports", "stack", "fdb", "lldp", "vlans")

    async def run_once(self) -> int:
        now = time.monotonic()
        due = [s for s in self._SWEEP_ORDER if self._due(s, now)]
        if not due:
            return 0
        switches = db.fetch_all(self.engine, _SWITCHES_SQL)
        total = 0
        # One fleet pass per due sweep, marking _last_run as each pass
        # completes — a run cancelled mid-way (supervisor budget) keeps the
        # finished sweeps' timestamps instead of re-queuing everything, so a
        # slow fleet converges sweep by sweep rather than looping on timeout.
        for sweep in due:
            sem = asyncio.Semaphore(max(1, self.cfg.concurrency))
            errors: list[str] = []

            async def one(sw, _sweep=sweep) -> int:
                async with sem:
                    try:
                        return await self._sweep_switch(sw, [_sweep])
                    except Exception as exc:  # isolate — one dead switch never fails the fleet
                        log.warning("snmp_inventory: %s %s (%s) failed: %r",
                                    _sweep, sw["name"], sw["mgmt_ip"], exc)
                        errors.append(f"{_sweep} {sw['name']}: {exc!r}")
                        return 0

            counts = await asyncio.gather(*(one(sw) for sw in switches))
            self._last_run[sweep] = now
            total += sum(counts)
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
        if "fdb" in due:
            walks = await self._walk_keys(host, _SWEEP_OIDS["fdb"][2])
            rows = build_fdb(walks["fdb_port"], walks["base_port_ifindex"])
            written += self._replace(dev_id, "fdb_entries", "mac", rows)
        if "lldp" in due:
            walks = await self._walk_keys(host, _SWEEP_OIDS["lldp"][2])
            written += self._replace(dev_id, "lldp_neighbors", "local_ifindex", build_lldp(walks))
        if "vlans" in due:
            walks = await self._walk_keys(host, _SWEEP_OIDS["vlans"][2])
            written += self._replace(dev_id, "switch_vlans", "vlan_id", build_vlans(walks))
        if "stack" in due:
            walks = await self._walk_keys(host, _SWEEP_OIDS["stack"][2])
            written += self._replace(dev_id, "stack_members", "slot", build_stack(walks))
        return written

    # -- persistence: upsert seen rows, prune rows not seen this sweep --
    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    def _write_ports(self, dev_id: int, rows: list[dict]) -> int:
        now, now_ts = self._now(), time.time()
        seen: list[int] = []
        for r in rows:
            prev_row = db.fetch_one(
                self.engine,
                "SELECT prev_counters FROM switch_ports WHERE device_id=:d AND ifindex=:i",
                {"d": dev_id, "i": r["ifindex"]},
            )
            prev = None
            if prev_row and prev_row.get("prev_counters"):
                try:
                    prev = json.loads(prev_row["prev_counters"])
                except (TypeError, ValueError):
                    prev = None
            rates = compute_rates(r, prev, now_ts)
            db.upsert(
                self.engine, "switch_ports",
                {"device_id": dev_id, "ifindex": r["ifindex"]},
                {"name": r["name"], "member": r["member"], "oper_state": r["oper_state"],
                 "admin_up": r["admin_up"], "speed_mbps": r["speed_mbps"], "duplex": r["duplex"],
                 "updated_at": now, **rates},
            )
            seen.append(r["ifindex"])
        self._prune(dev_id, "switch_ports", "ifindex", seen)
        return len(rows)

    def _replace(self, dev_id: int, table: str, key_col: str, rows: list[dict]) -> int:
        now = self._now()
        seen = []
        for r in rows:
            key_val = r[key_col]
            values = {k: v for k, v in r.items() if k != key_col}
            values["updated_at"] = now
            db.upsert(self.engine, table, {"device_id": dev_id, key_col: key_val}, values)
            seen.append(key_val)
        self._prune(dev_id, table, key_col, seen)
        return len(rows)

    def _prune(self, dev_id: int, table: str, key_col: str, seen: list) -> None:
        """Delete this device's rows not seen in this sweep. Prunes only after a
        successful sweep populated `seen` — a failed sweep raised earlier and
        left the rows stale (fail loud, don't blank them)."""
        if not seen:
            db.execute(self.engine, f"DELETE FROM {table} WHERE device_id = :d", {"d": dev_id})
            return
        placeholders = ", ".join(f":k{i}" for i in range(len(seen)))
        params = {"d": dev_id, **{f"k{i}": v for i, v in enumerate(seen)}}
        db.execute(
            self.engine,
            f"DELETE FROM {table} WHERE device_id = :d AND {key_col} NOT IN ({placeholders})",
            params,
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
        health.record_success(self.engine, self.name, records=written,
                              duration_ms=int((time.monotonic() - started) * 1000))


def main(argv: list[str] | None = None) -> int:
    import argparse
    from netmon.config import load_config

    parser = argparse.ArgumentParser(description="Read-only SNMP inventory sweeps.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="run every enabled sweep once")
    mode.add_argument("--loop", action="store_true", help="run forever on the interval")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
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
