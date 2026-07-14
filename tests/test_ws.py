import asyncio
from contextlib import asynccontextmanager

from netmon.collectors.ws import ResilientWebSocket


class FakeConn:
    """Delivers its scripted messages, then raises to simulate a drop."""

    def __init__(self, msgs):
        self._msgs = list(msgs)

    async def recv(self):
        await asyncio.sleep(0)
        if self._msgs:
            return self._msgs.pop(0)
        raise ConnectionError("connection dropped")


def _make_connect(scripts, counter):
    @asynccontextmanager
    async def connect():
        i = counter["n"]
        counter["n"] += 1
        yield FakeConn(scripts[i] if i < len(scripts) else [])
    return connect


def test_ws_survives_forced_disconnect():
    received = []

    async def handle(m):
        received.append(m)

    counter = {"n": 0}
    # Three connections; each delivers messages then drops mid-stream.
    connect = _make_connect([["a", "b"], ["c", "d"], ["e"]], counter)
    ws = ResilientWebSocket("test", connect, handle, watchdog_s=5, base_backoff=0, max_backoff=0)

    async def driver():
        task = asyncio.create_task(ws.run())
        for _ in range(500):
            if len(received) >= 5:
                break
            await asyncio.sleep(0.005)
        ws.stop()
        await asyncio.wait_for(task, timeout=2)

    asyncio.run(driver())

    # Every message across the three connections was handled → it reconnected.
    assert received == ["a", "b", "c", "d", "e"]
    assert ws.reconnects >= 2   # dropped at least twice between the three connects
    assert ws.messages == 5


def test_ws_watchdog_reconnects_on_silence():
    # A connection that never sends → the watchdog must force a reconnect.
    class Silent:
        async def recv(self):
            await asyncio.sleep(10)  # longer than the watchdog
            return "never"

    counter = {"n": 0}

    @asynccontextmanager
    async def connect():
        counter["n"] += 1
        yield Silent()

    ws = ResilientWebSocket("silent", connect, lambda m: None,
                            watchdog_s=0.02, base_backoff=0, max_backoff=0)

    async def driver():
        task = asyncio.create_task(ws.run())
        for _ in range(200):
            if ws.reconnects >= 2:
                break
            await asyncio.sleep(0.01)
        ws.stop()
        await asyncio.wait_for(task, timeout=2)

    asyncio.run(driver())
    assert ws.reconnects >= 2   # watchdog fired and reconnected repeatedly
