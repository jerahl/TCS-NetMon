"""Milestone collector — recording-server + camera state via the Config API.

Writes, for devices matched by ``milestone_hardware_id``:
  * recording servers → ``source_status`` (running → up / down)
  * cameras → ``recording`` (enabled+recording → up / down)
Blind on unreachable (all matched Milestone devices → blind). The live
Events/State WebSocket is the resilient task in ws.py (wiring needs the
`websockets` dependency — owner approval pending); this poll gives state now.

    python -m netmon.collectors.milestone --once|--loop
"""

from __future__ import annotations

import logging
import sys
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.collectors.base import Collector, run_standalone
from netmon.collectors.milestone_client import MilestoneClient, MilestoneError
from netmon.config import Config
from netmon.state import write_state

log = logging.getLogger("netmon.collectors.milestone")


def _truthy(*vals: Any) -> bool:
    for v in vals:
        if isinstance(v, bool):
            return v
        if isinstance(v, str) and v.strip().lower() in ("running", "true", "enabled", "online", "ok"):
            return True
    return False


class MilestoneCollector(Collector):
    name = "milestone"

    def __init__(self, engine: Engine, client: MilestoneClient, interval_s: float = 120.0) -> None:
        super().__init__(engine)
        self.client = client
        self.interval_s = interval_s
        self.timeout_s = max(60.0, interval_s)

    @classmethod
    def from_config(cls, engine: Engine, cfg: Config) -> "MilestoneCollector":
        s = (cfg.sources.get("milestone").settings if cfg.sources.get("milestone") else {})
        client = MilestoneClient(
            host=(s.get("host") or "").strip(),
            user=(s.get("user") or "").strip(),
            password=s.get("pass") or "",
            scheme=(s.get("scheme") or "https").strip(),
            client_id=(s.get("client_id") or "GrantValidatorClient").strip(),
            verify_ssl=str(s.get("verify_ssl", "true")).strip().lower() in ("1", "true", "yes", "on"),
        )
        return cls(engine, client, interval_s=int(s.get("interval_s") or 120))

    def _by_milestone_id(self) -> dict[str, dict]:
        rows = db.fetch_all(
            self.engine,
            "SELECT id, milestone_hardware_id FROM devices "
            "WHERE enabled = 1 AND milestone_hardware_id IS NOT NULL AND milestone_hardware_id <> ''",
        )
        return {str(r["milestone_hardware_id"]): r for r in rows}

    async def run_once(self) -> int:
        registry = self._by_milestone_id()
        try:
            servers = await self.client.recording_servers()
            cameras = await self.client.cameras()
        except MilestoneError:
            for r in registry.values():
                # We don't know which dimension a device uses; blind the ones we track.
                write_state(self.engine, int(r["id"]), "source_status", "blind", "warn", "milestone")
            raise

        written = 0
        for srv in servers:
            r = registry.get(str(srv.get("id")))
            if r is None:
                continue
            running = _truthy(srv.get("running"), srv.get("state"), srv.get("enabled"))
            write_state(self.engine, int(r["id"]), "source_status",
                        "up" if running else "down", "ok" if running else "crit", "milestone")
            written += 1

        for cam in cameras:
            r = registry.get(str(cam.get("id")))
            if r is None:
                continue
            recording = _truthy(cam.get("recordingEnabled"), cam.get("recording"), cam.get("enabled"))
            write_state(self.engine, int(r["id"]), "recording",
                        "up" if recording else "down", "ok" if recording else "crit", "milestone")
            written += 1

        return written


def main(argv: list[str] | None = None) -> int:
    try:
        return run_standalone(lambda engine, cfg: MilestoneCollector.from_config(engine, cfg), argv)
    except MilestoneError as exc:
        print(f"error: {exc} — set [milestone] host/user/pass in the config.", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
