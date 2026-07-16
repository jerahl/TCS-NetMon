"""PacketFence collector — persist the NAC inventory into NetMon's DB.

Phase 10.3 (spec 10 §5): each 5-minute cycle merges three read-only fetches
into one ``pf_nodes`` row per MAC (replace-on-refresh):

  * ``POST /api/v1/nodes/search`` (cursor-paged) — identity: owner/pid,
    hostname, status, category_id, device class/type/vendor, dhcp fp, ip;
  * ``GET /api/v1/node_categories`` — category_id → role *name* (nodes carry
    only the numeric id);
  * ``POST /api/v1/locationlogs/search`` (open sessions) — the current
    switch/port/ssid/auth/802.1X user that /nodes doesn't carry.

Any of the three failing raises — partial data must never overwrite good
rows (§4.5); prior rows stay visibly stale and collector_health records loud.

Page-level singletons go to ``snapshot_cache`` keys, each individually
fail-soft (a failing endpoint flips its key to ok=0, never blocks the node
cycle): ``pf.rejects`` (RADIUS reject tail) + cluster/services/queues/
sources/profiles/violations. Endpoint paths follow PF's documented v1 REST
surface — validate against the production PF 12.3 and adjust if any 404s
(the key will read ok=0, which is the honest signal to look).

    python -m netmon.collectors.packetfence --once|--loop
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.collectors.base import Collector, run_standalone
from netmon.collectors.pf_client import PfClient, PfError
from netmon.config import Config
from netmon.seed import canon_mac
from netmon.snapshots import write_snapshot

log = logging.getLogger("netmon.collectors.packetfence")

# snapshot_cache key → GET path (each fail-soft; spec 10 §3).
SNAPSHOT_FETCHES = [
    ("pf.cluster", "/api/v1/cluster/servers"),
    ("pf.services", "/api/v1/services/status_all"),
    ("pf.queues", "/api/v1/queues/stats"),
    ("pf.sources", "/api/v1/config/sources"),
    ("pf.profiles", "/api/v1/config/connection_profiles"),
    ("pf.violations", "/api/v1/config/security_events"),
]


def build_pf_rows(
    nodes: list[dict], categories: dict[str, str], locs: list[dict], now: datetime
) -> list[dict]:
    """Merge nodes + role names + open locationlog sessions into pf_nodes
    rows. ``locs`` is newest-first; the first entry per MAC wins."""
    loc_by_mac: dict[str, dict] = {}
    for l in locs:
        mac = canon_mac(str(l.get("mac") or ""))
        if mac and mac not in loc_by_mac:
            loc_by_mac[mac] = l

    rows: list[dict] = []
    seen: set[str] = set()
    for n in nodes:
        mac = canon_mac(str(n.get("mac") or ""))
        if not mac or mac in seen:
            continue
        seen.add(mac)
        l = loc_by_mac.get(mac, {})
        role = categories.get(str(n.get("category_id") or "")) or (l.get("role") or None)
        rows.append({
            "mac": mac,
            "computername": (n.get("computername") or None),
            "ip": (n.get("ip4log.ip") or n.get("ip") or None),
            "vendor": (n.get("device_manufacturer") or None),
            "os": (n.get("device_class") or None),
            "device_type": (n.get("device_type") or None),
            "owner": (n.get("pid") or None),
            "role": role,
            "reg_status": (n.get("status") or None),
            "vlan": (str(l.get("vlan")) if l.get("vlan") not in (None, "") else None),
            "last_switch": (l.get("switch") or None),
            "last_switch_ip": (l.get("switch_ip") or None),
            "last_port": (l.get("port") or l.get("ifDesc") or None),
            "last_ssid": (l.get("ssid") or None),
            "conn_method": (l.get("connection_type") or None),
            "conn_sub": (l.get("connection_sub_type") or None),
            "dot1x_user": (l.get("dot1x_username") or None),
            "dhcp_fp": (n.get("dhcp_fingerprint") or None),
            "last_seen": (n.get("last_seen") or None),
            "online": 1 if mac in loc_by_mac else 0,
            "updated_at": now,
        })
    return rows


class PfCollector(Collector):
    name = "packetfence"
    interval_s = 300.0  # PF is slow — minutes-scale, never in a request path

    def __init__(self, engine: Engine, client: PfClient, interval_s: float = 300.0,
                 node_limit: int = 1000) -> None:
        super().__init__(engine)
        self.client = client
        self.interval_s = interval_s
        self.timeout_s = max(120.0, interval_s)
        self.node_limit = node_limit  # page size for the cursor drains

    @classmethod
    def from_config(cls, engine: Engine, cfg: Config) -> "PfCollector":
        s = (cfg.sources.get("packetfence").settings if cfg.sources.get("packetfence") else {})
        client = PfClient(
            url=(s.get("url") or "").strip(),
            user=(s.get("user") or "").strip(),
            password=s.get("pass") or "",
            verify_ssl=str(s.get("verify_ssl", "true")).strip().lower() in ("1", "true", "yes", "on"),
        )
        return cls(engine, client, interval_s=int(s.get("interval_s") or 300),
                   node_limit=int(s.get("node_limit") or 1000))

    async def run_once(self) -> int:
        # All three inputs are required: persisting nodes without roles or
        # locations would silently blank those columns on good rows (§4.5).
        nodes = await self.client.nodes(limit=self.node_limit)
        categories = await self.client.node_categories()
        locs = await self.client.open_locationlogs(limit=self.node_limit)

        rows = build_pf_rows(nodes, categories, locs, datetime.now(timezone.utc))
        written = db.replace_rows(self.engine, "pf_nodes", ["mac"], rows)

        # RADIUS reject tail + page-level singletons — each fail-soft.
        try:
            write_snapshot(self.engine, "pf.rejects",
                           await self.client.recent_auth_failures(), self.name)
        except PfError as exc:
            log.warning("pf.rejects fetch failed: %s", exc)
            write_snapshot(self.engine, "pf.rejects", None, self.name, ok=False)
        for key, path in SNAPSHOT_FETCHES:
            try:
                write_snapshot(self.engine, key, await self.client.get_json(path), self.name)
            except PfError as exc:
                log.warning("%s fetch (%s) failed: %s", key, path, exc)
                write_snapshot(self.engine, key, None, self.name, ok=False)
        return written


def main(argv: list[str] | None = None) -> int:
    try:
        return run_standalone(lambda engine, cfg: PfCollector.from_config(engine, cfg), argv)
    except PfError as exc:
        import sys
        print(f"error: {exc} — set [packetfence] url/user/pass in the config.", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    import sys
    sys.exit(main())
