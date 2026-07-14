"""3CX collector — trunk registration into device_state (dimension `trunk`).

Writes `trunk` up/down for devices matched by `threecx_ref`; blind on
unreachable. Read-only (v20 REST).

    python -m netmon.collectors.threecx --once|--loop
"""

from __future__ import annotations

import logging
import sys
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.collectors.base import Collector, run_standalone
from netmon.collectors.threecx_client import ThreeCxClient, ThreeCxError
from netmon.config import Config
from netmon.state import write_state

log = logging.getLogger("netmon.collectors.threecx")


def _registered(trunk: dict) -> bool:
    for key in ("Registered", "IsRegistered", "registered"):
        v = trunk.get(key)
        if isinstance(v, bool):
            return v
    status = str(trunk.get("RegistrationStatus") or trunk.get("Status") or "").strip().lower()
    return status in ("registered", "online", "ok", "up")


class ThreeCxCollector(Collector):
    name = "threecx"

    def __init__(self, engine: Engine, client: ThreeCxClient, interval_s: float = 120.0) -> None:
        super().__init__(engine)
        self.client = client
        self.interval_s = interval_s
        self.timeout_s = max(60.0, interval_s)

    @classmethod
    def from_config(cls, engine: Engine, cfg: Config) -> "ThreeCxCollector":
        s = (cfg.sources.get("threecx").settings if cfg.sources.get("threecx") else {})
        client = ThreeCxClient(
            url=(s.get("url") or "").strip(),
            client_id=(s.get("client_id") or "").strip(),
            client_secret=s.get("client_secret") or "",
            verify_ssl=str(s.get("verify_ssl", "true")).strip().lower() in ("1", "true", "yes", "on"),
        )
        return cls(engine, client, interval_s=int(s.get("interval_s") or 120))

    def _registry(self) -> list[dict[str, Any]]:
        return db.fetch_all(
            self.engine,
            "SELECT id, threecx_ref FROM devices "
            "WHERE enabled = 1 AND threecx_ref IS NOT NULL AND threecx_ref <> ''",
        )

    async def run_once(self) -> int:
        registry = self._registry()
        try:
            trunks = await self.client.trunks()
        except ThreeCxError:
            for r in registry:
                write_state(self.engine, int(r["id"]), "trunk", "blind", "warn", "threecx")
            raise

        by_ref: dict[str, dict] = {}
        for t in trunks:
            for key in ("Id", "id", "Number", "number", "Name", "name"):
                val = t.get(key)
                if val is not None:
                    by_ref.setdefault(str(val), t)

        written = 0
        for r in registry:
            t = by_ref.get(str(r["threecx_ref"]))
            if t is None:
                continue
            up = _registered(t)
            write_state(self.engine, int(r["id"]), "trunk",
                        "up" if up else "down", "ok" if up else "crit", "threecx")
            written += 1
        return written


def main(argv: list[str] | None = None) -> int:
    try:
        return run_standalone(lambda engine, cfg: ThreeCxCollector.from_config(engine, cfg), argv)
    except ThreeCxError as exc:
        print(f"error: {exc} — set [threecx] url/client_id/client_secret.", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
