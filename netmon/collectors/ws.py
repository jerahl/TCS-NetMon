"""Resilient WebSocket task: reconnect + exponential backoff + watchdog.

The one genuinely long-lived connection in the system (Milestone Events/State).
Kept transport-agnostic and dependency-free: ``connect`` is an injectable async
context-manager factory yielding an object with ``async recv()`` (real
``websockets.connect(...)`` in production, a fake in tests). This is what the
Phase 5 forced-disconnect test exercises.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

log = logging.getLogger("netmon.collectors.ws")

# connect() → async context manager yielding a connection with async recv().
ConnectFactory = Callable[[], Any]
Handler = Callable[[Any], Awaitable[None]]


class ResilientWebSocket:
    def __init__(
        self,
        name: str,
        connect: ConnectFactory,
        handle: Handler,
        *,
        watchdog_s: float = 60.0,
        base_backoff: float = 1.0,
        max_backoff: float = 30.0,
    ) -> None:
        self.name = name
        self._connect = connect
        self._handle = handle
        self.watchdog_s = watchdog_s
        self.base_backoff = base_backoff
        self.max_backoff = max_backoff
        self._stop = asyncio.Event()
        # Observability.
        self.reconnects = 0
        self.messages = 0
        self.last_message_at: float | None = None
        self.connected = False

    def stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        backoff = self.base_backoff
        while not self._stop.is_set():
            try:
                async with self._connect() as conn:
                    self.connected = True
                    backoff = self.base_backoff  # reset on a successful connect
                    log.info("ws %s connected", self.name)
                    await self._pump(conn)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("ws %s connection error: %r", self.name, exc)
            finally:
                self.connected = False

            if self._stop.is_set():
                break
            self.reconnects += 1
            await self._sleep(backoff)
            backoff = min(self.max_backoff, backoff * 2) if backoff > 0 else 0.0

    async def _pump(self, conn: Any) -> None:
        while not self._stop.is_set():
            try:
                msg = await asyncio.wait_for(conn.recv(), timeout=self.watchdog_s)
            except asyncio.TimeoutError:
                # Watchdog: a silent connection is a dead connection — reconnect.
                log.warning("ws %s watchdog fired (no message in %ss)", self.name, self.watchdog_s)
                return
            self.messages += 1
            self.last_message_at = time.time()
            try:
                await self._handle(msg)
            except Exception:
                log.exception("ws %s message handler error", self.name)

    async def _sleep(self, seconds: float) -> None:
        if seconds <= 0:
            await asyncio.sleep(0)  # yield so a zero-backoff reconnect can't starve the loop
            return
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass
