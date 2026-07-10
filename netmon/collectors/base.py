"""Collector base contract.

Every collector (XIQ, PacketFence, Milestone, 3CX, rConfig) subclasses
``Collector``. The contract, built here from the start (CLAUDE.md §5):

  * ``run_once()`` — one collection cycle; subclass implements the real work.
    Read-only against the source; validates payloads with Pydantic; upserts to
    ``devices``/``device_state``; appends transitions to ``state_events``.
  * heartbeat + error boundary — ``run_guarded()`` wraps ``run_once()`` and
    writes ``collector_health`` (last_start/last_success/last_error/duration/
    records/consecutive_failures). A failure marks health loud and leaves prior
    state visibly stale — it never fabricates or silently overwrites (§4.5).
  * two execution modes — the same object runs in-process under the supervisor
    (``as_task`` returns the supervisor callable) AND standalone via
    ``python -m netmon.collectors.<name> --once|--loop`` (``main()``).

Phase 1 ships the contract only; concrete collectors arrive in Phase 3+.
"""

from __future__ import annotations

import abc
import argparse
import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

from sqlalchemy.engine import Engine

from netmon import db

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
        self._health_start()
        started = time.monotonic()
        try:
            written = await self.run_once()
        except Exception as exc:  # fail loud into collector_health; prior state stays stale
            self._health_error(repr(exc), int((time.monotonic() - started) * 1000))
            log.exception("collector %s failed", self.name)
            return
        self._health_success(written, int((time.monotonic() - started) * 1000))

    def as_task(self) -> Callable[[], Awaitable[None]]:
        """The callable the supervisor schedules."""
        return self.run_guarded

    # --- collector_health writers (best-effort; never mask the real error) ---

    def _health_start(self) -> None:
        db.execute(
            self.engine,
            "INSERT INTO collector_health (name, last_start) VALUES (:n, CURRENT_TIMESTAMP) "
            "ON DUPLICATE KEY UPDATE last_start = CURRENT_TIMESTAMP",
            {"n": self.name},
        )

    def _health_success(self, records: int, duration_ms: int) -> None:
        db.execute(
            self.engine,
            "UPDATE collector_health SET last_success = CURRENT_TIMESTAMP, "
            "duration_ms = :d, records_written = :r, consecutive_failures = 0, "
            "last_error = NULL WHERE name = :n",
            {"n": self.name, "d": duration_ms, "r": records},
        )

    def _health_error(self, message: str, duration_ms: int) -> None:
        db.execute(
            self.engine,
            "UPDATE collector_health SET last_error = :e, duration_ms = :d, "
            "consecutive_failures = consecutive_failures + 1 WHERE name = :n",
            {"n": self.name, "e": message, "d": duration_ms},
        )


def run_standalone(
    build: Callable[[Engine], Collector],
    argv: list[str] | None = None,
) -> int:
    """Shared ``python -m netmon.collectors.<x>`` entry point.

    Loads config, builds the engine and the collector, then runs one cycle
    (``--once``) or loops on the collector's interval (``--loop``).
    """
    from netmon.config import load_config

    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="run one cycle and exit")
    mode.add_argument("--loop", action="store_true", help="run forever on the interval")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)
    collector = build(engine)

    async def _run() -> None:
        if args.once:
            await collector.run_guarded()
            return
        while True:  # --loop
            await collector.run_guarded()
            await asyncio.sleep(collector.interval_s)

    asyncio.run(_run())
    return 0
