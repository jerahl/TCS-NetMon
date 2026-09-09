"""Micetro collector — DDI facts that close the FDB and PacketFence gaps.

docs/spec/21-micetro-ddi.md. Read-only (GET only; see `micetro_client`).

`fdb_entries` learns every MAC that forwards a frame; `pf_nodes` only knows the
endpoints PacketFence authenticated. So the port-detail identity pane shows a
card for the Chromebooks and a bare hex string for the printers, cameras, AV
gear and static servers — exactly the population an operator opened the pane to
identify. Micetro is the district's DDI system of record and already holds the
missing join, IP <-> MAC <-> DNS name, for all of them.

Two cycles, both replace-on-refresh into row-shaped snapshot tables:

  * ``ddi_addresses`` — IPAM records from every *subnet* range, filtered to
    addresses that actually carry something (§4). Fills the identity gap.
  * ``ddi_scopes``    — DHCP scopes, with utilization joined from the owning
    range and classified to a severity at write time.

Neither writes ``device_state``: a DHCP scope is not a device and the dimension
column is an ENUM (spec 21 §6 / Q3). Utilization is therefore *visible but
silent* — no email fires for an exhausting pool until the owner decides how
non-device entities should alert.

A failed fetch raises before anything is written, so prior rows stay visibly
stale rather than being half-replaced (§4.5).

    python -m netmon.collectors.micetro --once|--loop
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.collectors.base import Collector, run_standalone
from netmon.collectors.micetro_client import MicetroClient, MicetroError
from netmon.config import Config
from netmon.seed import canon_mac
from netmon.snapshots import write_snapshot

log = logging.getLogger("netmon.collectors.micetro")

#: IPAMRecordState (API) → the migration's lowercase enum. Anything unrecognised
#: becomes 'unknown' rather than being coerced to a state we did not read.
_STATES = {"free", "assigned", "claimed", "pending", "held"}


def _s(value: Any) -> str | None:
    """Trim to a non-empty string, else None (so NULL means absent, not '')."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _parse_ts(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _truthy(value: Any) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _pick_mac(record: dict) -> tuple[str | None, str | None]:
    """Best MAC for an IPAM record, and how it was established.

    Precedence is lease → reservation → discovery, strongest first. A lease
    means the DHCP server handed *that* address to *that* MAC. A reservation is
    configured intent, which may never have been claimed. ARP/ping discovery is
    a scan-interval-old observation. The origin is returned alongside so the UI
    can say which, instead of presenting three different confidences as one
    fact.

    DHCPv6 leases carry `duid`/`iaid` rather than a MAC (spec 21 Q5), so a
    v6-only address yields (None, None) here and identifies by DNS name alone.
    """
    for lease in record.get("dhcpLeases") or []:
        if isinstance(lease, dict):
            mac = canon_mac(str(lease.get("mac") or ""))
            if mac:
                return mac, "lease"
    for res in record.get("dhcpReservations") or []:
        if isinstance(res, dict):
            mac = canon_mac(str(res.get("clientIdentifier") or ""))
            if mac:
                return mac, "reservation"
    mac = canon_mac(str(record.get("lastKnownClientIdentifier") or ""))
    if mac:
        return mac, "discovery"
    return None, None


def _dns_names(record: dict) -> list[str]:
    """Host names attached to the address, in the order Micetro returned them."""
    names: list[str] = []
    for host in record.get("dnsHosts") or []:
        if not isinstance(host, dict):
            continue
        rec = host.get("dnsRecord")
        name = _s(rec.get("name")) if isinstance(rec, dict) else None
        if name and name not in names:
            names.append(name)
    return names


def _first_lease(record: dict) -> dict:
    for lease in record.get("dhcpLeases") or []:
        if isinstance(lease, dict):
            return lease
    return {}


def _first_reservation(record: dict) -> dict:
    for res in record.get("dhcpReservations") or []:
        if isinstance(res, dict):
            return res
    return {}


def is_empty_record(record: dict) -> bool:
    """True when an address carries nothing worth storing.

    The sweep bound (spec 21 §4): Micetro's address space is not NetMon's
    device count — one /16 container holds 65,534 addresses against a ~3,600
    device registry. A row survives if it has a MAC, a DNS name, a lease, a
    reservation, or a state other than Free. Merely-unallocated addresses are
    dropped before they reach the DB, so the table scales with *assignments*
    rather than with address space.
    """
    mac, _ = _pick_mac(record)
    if mac or _dns_names(record):
        return False
    if record.get("dhcpLeases") or record.get("dhcpReservations"):
        return False
    state = str(record.get("state") or "").strip().lower()
    return state in ("", "free")


def build_address_rows(records: list[dict], range_cidr: str | None) -> list[dict]:
    """Map IPAM records to ``ddi_addresses`` rows, dropping empty ones.

    Later duplicates of an address within a range are ignored — the PK is the
    IP, and a replace-on-refresh write must not carry two rows for one key.
    """
    rows: list[dict] = []
    seen: set[str] = set()
    for rec in records:
        if not isinstance(rec, dict):
            continue
        ip = _s(rec.get("address"))
        if not ip or ip in seen or is_empty_record(rec):
            continue
        seen.add(ip)
        mac, origin = _pick_mac(rec)
        names = _dns_names(rec)
        lease = _first_lease(rec)
        state = str(rec.get("state") or "").strip().lower()
        rows.append({
            "ip": ip,
            "mac": mac,
            "mac_origin": origin,
            "dns_name": names[0] if names else None,
            "dns_extra": max(0, len(names) - 1),
            "state": state if state in _STATES else "unknown",
            "discovery_type": _s(rec.get("discoveryType")),
            "last_seen": _parse_ts(rec.get("lastSeenDate")),
            "lease_state": _s(lease.get("state")),
            "lease_expires": _parse_ts(lease.get("lease")),
            "reservation": _s(_first_reservation(rec).get("name")),
            "device_name": _s(rec.get("device")),
            "interface_name": _s(rec.get("interface")),
            "range_cidr": range_cidr,
            "addr_ref": _s(rec.get("addrRef")),
        })
    return rows


def classify_utilization(pct: float | None, warn_pct: int, crit_pct: int) -> str:
    """Severity for a scope's fill level.

    ``None`` stays ``unknown`` — Micetro reporting no utilization figure is not
    evidence that a pool is healthy, and rendering it as ok would be exactly
    the fabrication §4.5 forbids.
    """
    if pct is None:
        return "unknown"
    if pct >= crit_pct:
        return "crit"
    if pct >= warn_pct:
        return "warn"
    return "ok"


def build_scope_rows(scopes: list[dict], ranges_by_ref: dict[str, dict],
                     warn_pct: int, crit_pct: int) -> list[dict]:
    """Map DHCP scopes to ``ddi_scopes`` rows.

    ``utilizationPercentage`` is a field of Micetro's *Range*, not of
    DHCPScope (which carries only `available`, a count), so it is joined on
    ``rangeRef`` — free, because the address sweep already drained /ranges.
    A scope whose range is missing keeps severity ``unknown``.
    """
    rows: list[dict] = []
    seen: set[str] = set()
    for scope in scopes:
        if not isinstance(scope, dict):
            continue
        ref = _s(scope.get("ref"))
        if not ref or ref in seen:
            continue
        seen.add(ref)
        rng = ranges_by_ref.get(str(scope.get("rangeRef") or "")) or {}
        pct = rng.get("utilizationPercentage")
        try:
            pct = float(pct) if pct is not None else None
        except (TypeError, ValueError):
            pct = None
        available = scope.get("available")
        try:
            available = int(available) if available is not None else None
        except (TypeError, ValueError):
            available = None
        enabled = scope.get("enabled")
        rows.append({
            "scope_ref": ref,
            "name": _s(scope.get("name")),
            "range_cidr": _s(scope.get("range")) or _s(rng.get("name")),
            "from_addr": _s(rng.get("from")),
            "to_addr": _s(rng.get("to")),
            "server": _s(scope.get("dhcpServerRef")),
            "superscope": _s(scope.get("superscope")),
            "enabled": None if enabled is None else (1 if bool(enabled) else 0),
            "available": available,
            "utilization_pct": pct,
            "severity": classify_utilization(pct, warn_pct, crit_pct),
        })
    return rows


class MicetroCollector(Collector):
    name = "micetro"

    def __init__(self, engine: Engine, client: MicetroClient,
                 interval_s: float = 900.0,
                 sweep_addresses: bool = True, sweep_scopes: bool = True,
                 max_records: int = 60000, max_ranges: int = 2000,
                 scope_warn_pct: int = 85, scope_crit_pct: int = 95) -> None:
        super().__init__(engine)
        self.client = client
        self.interval_s = interval_s
        self.timeout_s = max(120.0, interval_s)
        self.sweep_addresses = sweep_addresses
        self.sweep_scopes = sweep_scopes
        self.max_records = max_records
        self.max_ranges = max_ranges
        self.scope_warn_pct = scope_warn_pct
        self.scope_crit_pct = scope_crit_pct

    @classmethod
    def from_config(cls, engine: Engine, cfg: Config) -> "MicetroCollector":
        src = cfg.sources.get("micetro")
        s = src.settings if src else {}
        client = MicetroClient(
            url=(s.get("url") or "").strip(),
            username=(s.get("username") or "").strip(),
            password=s.get("password") or "",
            verify_ssl=_truthy(s.get("verify_ssl", "true")),
            page_size=int(s.get("page_size") or 500),
        )
        return cls(
            engine, client,
            interval_s=int(s.get("interval_s") or 900),
            sweep_addresses=_truthy(s.get("sweep_addresses", "true")),
            sweep_scopes=_truthy(s.get("sweep_scopes", "true")),
            max_records=int(s.get("max_records") or 60000),
            max_ranges=int(s.get("max_ranges") or 2000),
            scope_warn_pct=int(s.get("scope_warn_pct") or 85),
            scope_crit_pct=int(s.get("scope_crit_pct") or 95),
        )

    # --- cycles --------------------------------------------------------------

    async def _fetch_ranges(self) -> list[dict]:
        ranges = await self.client.ranges(limit_total=self.max_ranges + 1)
        if len(ranges) > self.max_ranges:
            raise MicetroError(
                f"micetro returned {len(ranges)} ranges, over max_ranges="
                f"{self.max_ranges} — raise [micetro] max_ranges if this is real")
        return ranges

    async def _sweep_addresses(self, ranges: list[dict]) -> int:
        """Drain ipamRecords for every subnet range, then one atomic replace.

        Rows accumulate across ranges and are written **once**, table-wide, at
        the end. Writing per range would leave the table half-old whenever a
        later range failed, and `replace_rows` scoped per range cannot prune an
        address that moved between subnets.
        """
        subnets = [r for r in ranges if isinstance(r, dict) and r.get("subnet")]
        skipped = len(ranges) - len(subnets)
        rows: list[dict] = []
        for rng in subnets:
            ref = _s(rng.get("ref"))
            if not ref:
                continue
            records = await self.client.ipam_records(
                ref, limit_total=self.max_records + 1)
            rows.extend(build_address_rows(records, _s(rng.get("name"))))
            if len(rows) > self.max_records:
                # Refuse rather than truncate: a half-mirror that looks
                # complete is the fabrication §4.5 forbids. The first --once
                # run reports the number to raise this to (spec 21 Q2).
                raise MicetroError(
                    f"micetro kept {len(rows)} addresses, over max_records="
                    f"{self.max_records} — raise [micetro] max_records if this is real")

        # De-duplicate across ranges: `ip` is the PK, and overlapping or nested
        # Micetro ranges can return the same address twice. replace_rows would
        # otherwise INSERT a duplicate key.
        by_ip: dict[str, dict] = {}
        for row in rows:
            by_ip.setdefault(row["ip"], row)
        deduped = list(by_ip.values())

        with_mac = sum(1 for r in deduped if r["mac"])
        with_dns = sum(1 for r in deduped if r["dns_name"])
        db.replace_rows(self.engine, "ddi_addresses", ["ip"], deduped)
        log.info("micetro addresses: %d subnets (%d non-subnet ranges skipped) → "
                 "%d rows (%d with MAC, %d with DNS name)",
                 len(subnets), skipped, len(deduped), with_mac, with_dns)
        write_snapshot(self.engine, "micetro.addresses", {
            "ranges_total": len(ranges), "subnets": len(subnets),
            "rows": len(deduped), "with_mac": with_mac, "with_dns": with_dns,
        }, source="micetro")
        return len(deduped)

    async def _sweep_scopes(self, ranges: list[dict]) -> int:
        scopes = await self.client.dhcp_scopes()
        by_ref = {str(r.get("ref")): r for r in ranges
                  if isinstance(r, dict) and r.get("ref")}
        rows = build_scope_rows(scopes, by_ref, self.scope_warn_pct, self.scope_crit_pct)
        db.replace_rows(self.engine, "ddi_scopes", ["scope_ref"], rows)
        counts: dict[str, int] = {}
        for row in rows:
            counts[row["severity"]] = counts.get(row["severity"], 0) + 1
        log.info("micetro dhcp scopes: %d rows (%s)", len(rows),
                 ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "none")
        write_snapshot(self.engine, "micetro.dhcp", {
            "scopes": len(rows), "by_severity": counts,
            "warn_pct": self.scope_warn_pct, "crit_pct": self.scope_crit_pct,
        }, source="micetro")
        return len(rows)

    async def run_once(self) -> int:
        if not (self.sweep_addresses or self.sweep_scopes):
            log.info("micetro: both sweeps disabled, nothing to do")
            return 0
        # Ranges feed both cycles — the address sweep needs the subnet list,
        # the scope sweep needs utilizationPercentage. Fetched once.
        ranges = await self._fetch_ranges()
        written = 0
        if self.sweep_addresses:
            written += await self._sweep_addresses(ranges)
        if self.sweep_scopes:
            written += await self._sweep_scopes(ranges)
        return written


def main(argv: list[str] | None = None) -> int:
    try:
        return run_standalone(lambda engine, cfg: MicetroCollector.from_config(engine, cfg), argv)
    except MicetroError as exc:
        print(f"error: {exc} — set [micetro] url (https)/username/password.", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
