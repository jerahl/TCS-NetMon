"""Live port view: one port, polled every few seconds while someone watches.

The one deliberate exception to "zero source calls at page render"
(CLAUDE.md §6), approved with spec 26: an operator watching a port after a
PoE cycle needs seconds-fresh link/power/counters, which the 2–15 minute
inventory sweeps cannot give. It is bounded so it cannot become a poller:

* **Request-driven.** There is no background loop. Each GET renews the port's
  subscription; the switch is read only when the cached sample is older than
  ``live_interval_s``. Nobody watching → nothing polled. A subscription not
  renewed within ``live_ttl_s`` is dropped.
* **Shared.** Ten viewers on one port cause one poll.
* **Capped.** At most ``live_max_ports`` ports live at once (fleet-wide), and
  at most one SNMP request in flight per switch; a request that finds the
  switch busy gets the cached sample.
* **Nothing persisted.** Samples live in this process's memory only; no
  inventory table is written.

FDB for the port is refreshed on the slower ``live_fdb_interval_s`` and is
per switch (one walk serves every live port on it).
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from netmon.config import SwitchOpsConfig
from netmon.poller.snmp_inventory import mac_from_fdb_suffix
from netmon.switchops import snmp as S
from netmon.switchops.ports import Port


class LiveCapReached(Exception):
    pass


@dataclass
class _Sub:
    last_req: float = 0.0
    polled_at: float = 0.0
    sample: dict[str, Any] | None = None
    prev: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class _SwitchFdb:
    at: float = 0.0
    bport_of: dict[int, str] = field(default_factory=dict)   # ifindex -> bridge port
    macs_by_bport: dict[str, list[str]] = field(default_factory=dict)
    error: str | None = None


class LivePortHub:
    def __init__(self, cfg: SwitchOpsConfig, reader: S.SnmpReader,
                 clock=time.monotonic) -> None:
        self.cfg = cfg
        self.reader = reader
        self.clock = clock
        self._subs: dict[tuple[int, int], _Sub] = {}
        self._fdb: dict[int, _SwitchFdb] = {}
        self._locks: dict[int, asyncio.Lock] = {}

    def _expire(self, now: float) -> None:
        ttl = self.cfg.live_ttl_s
        for k in [k for k, s in self._subs.items() if now - s.last_req > ttl]:
            del self._subs[k]
        live_switches = {k[0] for k in self._subs}
        for d in [d for d in self._fdb if d not in live_switches]:
            del self._fdb[d]

    def active(self) -> int:
        self._expire(self.clock())
        return len(self._subs)

    async def read(self, p: Port) -> dict[str, Any]:
        now = self.clock()
        self._expire(now)
        key = (p.device_id, p.ifindex)
        sub = self._subs.get(key)
        if sub is None:
            if len(self._subs) >= self.cfg.live_max_ports:
                raise LiveCapReached(
                    f"{len(self._subs)} ports are already live (limit "
                    f"{self.cfg.live_max_ports}); try again when one closes")
            sub = self._subs[key] = _Sub()
        sub.last_req = now
        lock = self._locks.setdefault(p.device_id, asyncio.Lock())
        busy = lock.locked()
        if not busy and now - sub.polled_at >= self.cfg.live_interval_s:
            async with lock:
                await self._poll(p, sub)
                await self._maybe_fdb(p)
        f = self._fdb.get(p.device_id)
        bp = f.bport_of.get(p.ifindex) if f else None
        return {
            "sample": sub.sample,
            "error": sub.error,
            "age_s": round(self.clock() - sub.polled_at, 1) if sub.polled_at else None,
            "interval_s": self.cfg.live_interval_s,
            "ttl_s": self.cfg.live_ttl_s,
            "busy": busy,
            "fdb": {
                "macs": (f.macs_by_bport.get(bp, []) if (f and bp) else []),
                "age_s": round(self.clock() - f.at, 1) if f and f.at else None,
                "error": f.error if f else None,
            },
            "live_ports": len(self._subs),
        }

    async def _poll(self, p: Port, sub: _Sub) -> None:
        i, g = p.ifindex, p.poe_index
        oids = {
            "oper": f"{S.IF_OPER}.{i}", "admin": f"{S.IF_ADMIN}.{i}",
            "in_octets": f"{S.IF_HC_IN}.{i}", "out_octets": f"{S.IF_HC_OUT}.{i}",
            "in_errors": f"{S.IF_IN_ERR}.{i}", "out_errors": f"{S.IF_OUT_ERR}.{i}",
            "in_discards": f"{S.IF_IN_DISC}.{i}", "out_discards": f"{S.IF_OUT_DISC}.{i}",
            "speed_mbps": f"{S.IF_HIGHSPEED}.{i}",
        }
        if p.poe_capable:
            oids.update({"poe_detect": f"{S.PETH_DETECT}.{g}", "poe_mw": f"{S.EXT_POE_MW}.{g}",
                         "poe_admin": f"{S.PETH_ADMIN}.{g}"})
        try:
            raw = await self.reader.get(p.mgmt_ip, list(oids.values()))
        except S.SnmpReadError as exc:
            sub.error = str(exc)
            sub.polled_at = self.clock()   # back off for one interval
            return
        ts = self.clock()
        v = {k: S.enum_int(raw.get(o)) for k, o in oids.items()}
        sample: dict[str, Any] = {
            "oper": {1: "up", 2: "down"}.get(v["oper"], "unknown"),
            "admin_up": None if v["admin"] is None else v["admin"] == 1,
            "speed_mbps": v["speed_mbps"],
            "counters": {k: v[k] for k in ("in_octets", "out_octets", "in_errors",
                                           "out_errors", "in_discards", "out_discards")},
        }
        if p.poe_capable:
            sample["poe"] = {
                "admin_on": None if v["poe_admin"] is None else v["poe_admin"] == 1,
                "detect": S.PETH_DETECT_NAMES.get(str(v["poe_detect"]), None),
                "watts": None if v["poe_mw"] is None else round(v["poe_mw"] / 1000, 2),
            }
        sample["rates"] = rates(sub.prev, {"ts": ts, **sample["counters"]})
        sub.prev = {"ts": ts, **sample["counters"]}
        sub.sample = sample
        sub.error = None
        sub.polled_at = ts

    async def _maybe_fdb(self, p: Port) -> None:
        f = self._fdb.setdefault(p.device_id, _SwitchFdb())
        now = self.clock()
        if f.at and now - f.at < self.cfg.live_fdb_interval_s:
            return
        f.at = now
        try:
            base = await self.reader.walk(p.mgmt_ip, S.BASE_PORT_IFINDEX)
            fdb = await self.reader.walk(p.mgmt_ip, S.FDB_PORT)
        except S.SnmpReadError as exc:
            f.error = str(exc)
            return
        f.bport_of = {}
        for bport, ifx in base.items():
            n = S.enum_int(ifx)
            if n is not None:
                f.bport_of[n] = bport
        by: dict[str, list[str]] = {}
        for suffix, bport in fdb.items():
            mac = mac_from_fdb_suffix(suffix)
            if mac:
                by.setdefault(bport.split()[0], []).append(mac)
        f.macs_by_bport = {k: sorted(v) for k, v in by.items()}
        f.error = None


def rates(prev: dict[str, Any] | None, cur: dict[str, Any]) -> dict[str, Any] | None:
    """kbps and per-second error/discard rates from two counter samples.

    None on the first sample, after a counter went backwards (wrap or switch
    reboot) — a negative rate would be a fabrication.
    """
    if not prev:
        return None
    dt = cur["ts"] - prev["ts"]
    if dt <= 0:
        return None
    out: dict[str, Any] = {"interval_s": round(dt, 1)}
    for key, name, scale in (("in_octets", "in_kbps", 8 / 1000),
                             ("out_octets", "out_kbps", 8 / 1000),
                             ("in_errors", "in_errors_ps", 1), ("out_errors", "out_errors_ps", 1),
                             ("in_discards", "in_discards_ps", 1),
                             ("out_discards", "out_discards_ps", 1)):
        a, b = prev.get(key), cur.get(key)
        if a is None or b is None or b < a:
            out[name] = None
        else:
            out[name] = round((b - a) * scale / dt, 2)
    return out
