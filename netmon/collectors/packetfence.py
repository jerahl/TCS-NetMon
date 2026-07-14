"""PacketFence collector — cached NAC summary for the linked NAC view.

PF is not merged into the device registry (open question §9); this collector
keeps a hard-cached snapshot (node counts, recent auth failures) that the
`/api/nac` endpoint serves. On PF unreachable it fails loud into
collector_health and keeps the last-good snapshot visibly stale.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon.collectors.base import Collector, run_standalone
from netmon.collectors.pf_client import PfClient, PfError
from netmon.config import Config

log = logging.getLogger("netmon.collectors.packetfence")


class PfCollector(Collector):
    name = "packetfence"
    interval_s = 300.0  # PF is slow — minutes-scale, never in a request path

    def __init__(self, engine: Engine, client: PfClient, interval_s: float = 300.0,
                 node_limit: int = 1000) -> None:
        super().__init__(engine)
        self.client = client
        self.interval_s = interval_s
        self.timeout_s = max(60.0, interval_s)
        self.node_limit = node_limit
        # Last-good snapshot served to the NAC page. `ok`/`fetched_at` expose staleness.
        self.snapshot: dict[str, Any] = {"ok": False, "fetched_at": None, "registered": 0,
                                         "unregistered": 0, "auth_failures": [], "nodes": []}

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
        try:
            nodes = await self.client.nodes(limit=self.node_limit)
            failures = await self.client.recent_auth_failures()
        except PfError:
            # Keep the last-good snapshot; mark not-ok. run_guarded records the error.
            self.snapshot["ok"] = False
            raise

        registered = sum(1 for n in nodes if str(n.get("status", "")).lower() == "reg")
        self.snapshot = {
            "ok": True,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "registered": registered,
            "unregistered": len(nodes) - registered,
            "truncated": len(nodes) >= self.node_limit,
            "auth_failures": failures,
            "nodes": nodes,
        }
        return len(nodes)


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
