"""Supervised async task scaffold.

Collectors, the poller, and the alert engine all run as named periodic tasks
started by the FastAPI lifespan. Each task is wrapped in: an interval loop, a
per-run timeout, an exception boundary (a crash logs and reschedules, it never
kills the loop or the event loop), and a heartbeat.

Phase 1 registers no real work — only a ``heartbeat`` self-task that proves the
supervisor runs, cancels cleanly on shutdown, and survives a task raising.
Collectors plug in here in later phases via ``register()``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

log = logging.getLogger("netmon.supervisor")

# A task body: an async callable taking no args. Return value is ignored.
TaskFn = Callable[[], Awaitable[None]]


@dataclass
class TaskSpec:
    name: str
    fn: TaskFn
    interval_s: float
    timeout_s: float
    enabled: bool = True


@dataclass
class TaskStats:
    runs: int = 0
    failures: int = 0
    last_run_at: float | None = None
    last_error: str | None = None


@dataclass
class Supervisor:
    specs: list[TaskSpec] = field(default_factory=list)
    stats: dict[str, TaskStats] = field(default_factory=dict)
    _tasks: list[asyncio.Task[None]] = field(default_factory=list)
    _stopping: asyncio.Event | None = None

    def register(
        self,
        name: str,
        fn: TaskFn,
        *,
        interval_s: float,
        timeout_s: float,
        enabled: bool = True,
    ) -> None:
        if any(s.name == name for s in self.specs):
            raise ValueError(f"task {name!r} already registered")
        self.specs.append(
            TaskSpec(name=name, fn=fn, interval_s=interval_s, timeout_s=timeout_s, enabled=enabled)
        )

    async def _run_loop(self, spec: TaskSpec) -> None:
        stats = self.stats.setdefault(spec.name, TaskStats())
        assert self._stopping is not None
        while not self._stopping.is_set():
            started = time.monotonic()
            stats.runs += 1
            stats.last_run_at = time.time()
            try:
                await asyncio.wait_for(spec.fn(), timeout=spec.timeout_s)
                stats.last_error = None
            except asyncio.CancelledError:
                raise
            except asyncio.TimeoutError:
                stats.failures += 1
                stats.last_error = f"timed out after {spec.timeout_s}s"
                log.warning("task %s timed out (%.0fs)", spec.name, spec.timeout_s)
            except Exception as exc:  # exception boundary — never kills the loop
                stats.failures += 1
                stats.last_error = repr(exc)
                log.exception("task %s raised; rescheduling", spec.name)

            # Sleep the remainder of the interval, but wake early on shutdown.
            elapsed = time.monotonic() - started
            delay = max(0.0, spec.interval_s - elapsed)
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass  # interval elapsed, loop again

    def running_names(self) -> set[str]:
        """Names of tasks whose loops are currently live (for /api/netmon-status)."""
        return {t.get_name() for t in self._tasks if not t.done()}

    async def start(self) -> None:
        self._stopping = asyncio.Event()
        for spec in self.specs:
            if not spec.enabled:
                log.info("task %s disabled by config; not starting", spec.name)
                continue
            self._tasks.append(asyncio.create_task(self._run_loop(spec), name=spec.name))
        log.info("supervisor started %d task(s)", len(self._tasks))

    async def stop(self) -> None:
        if self._stopping is not None:
            self._stopping.set()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._tasks.clear()
        log.info("supervisor stopped")


async def _heartbeat() -> None:
    """Self-task — proves the supervisor loop is alive. Registered by
    ``netmon.app.register_tasks`` alongside the poller/collectors."""
    log.debug("netmon supervisor heartbeat")
