"""Collector base contract (finalized in Phase 3).

Every collector (XIQ, PacketFence, Milestone, 3CX, rConfig) subclasses
``Collector``:

  * ``run_once()`` — one collection cycle; read-only against the source,
    Pydantic-validated payloads, writes to ``device_state``/``state_events``
    via ``netmon.state.write_state``. Returns the number of records written.
  * ``run_guarded()`` — wraps ``run_once`` in the portable ``collector_health``
    heartbeat + error boundary (``netmon.health``, shared with the poller). A
    failure records loud and leaves prior state intact — never fabricated (§4.5).
  * ``as_task()`` — the callable the supervisor schedules in-process.
  * ``run_standalone(build)`` — ``python -m netmon.collectors.<name>
    --once|--loop``, the documented escape hatch (§5).
"""

from __future__ import annotations

import abc
import argparse
import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

from sqlalchemy.engine import Engine

from netmon import health

log = logging.getLogger("netmon.collector")


class Collector(abc.ABC):
    #: unique collector name; also the collector_health primary key.
    name: str = "collector"
    #: default in-process poll interval and per-run timeout (seconds).
    interval_s: float = 300.0
    timeout_s: float = 120.0

    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    @abc.abstractmethod
    async def run_once(self) -> int:
        """Perform one collection cycle. Return the number of records written."""
        raise NotImplementedError

    async def run_guarded(self) -> None:
        """Run one cycle inside the heartbeat + error boundary."""
        health.record_start(self.engine, self.name)
        started = time.monotonic()
        try:
            written = await self.run_once()
        except Exception as exc:  # fail loud into collector_health; keep prior state
            health.record_error(
                self.engine, self.name, message=repr(exc),
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            log.exception("collector %s failed", self.name)
            return
        health.record_success(
            self.engine, self.name, records=written,
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    def as_task(self) -> Callable[[], Awaitable[None]]:
        """The callable the supervisor schedules."""
        return self.run_guarded


def run_standalone(
    build: Callable[[Engine, "object"], Collector],
    argv: list[str] | None = None,
) -> int:
    """Shared ``python -m netmon.collectors.<x>`` entry point.

    ``build(engine, cfg)`` constructs the collector from the loaded config.
    """
    from netmon import db
    from netmon.config import load_config

    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="run one cycle and exit")
    mode.add_argument("--loop", action="store_true", help="run forever on the interval")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)
    collector = build(engine, cfg)

    async def _run() -> None:
        if args.once:
            await collector.run_guarded()
            return
        while True:  # --loop
            await collector.run_guarded()
            await asyncio.sleep(collector.interval_s)

    asyncio.run(_run())
    return 0
