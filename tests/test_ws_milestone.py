"""Milestone ESS transport tests — no socket, no credentials, no live VMS."""

import asyncio
import json

import pytest

from netmon.collectors.milestone_client import MilestoneError
from netmon.collectors.ws_milestone import (
    PERMITTED_COMMANDS,
    EssProtocolError,
    ForbiddenCommand,
    MilestoneEss,
    send_command,
    ws_url,
)


class FakeConn:
    """Scripted ESS peer. Replies by commandId and can interleave events."""

    def __init__(self, *, interleave=None, fail_on=None, reply_extra=None):
        self.sent: list[dict] = []
        self._out: list[str] = []
        self._interleave = list(interleave or [])
        self._fail_on = fail_on
        self._reply_extra = reply_extra or {}

    async def send(self, raw):
        msg = json.loads(raw)
        self.sent.append(msg)
        # Unsolicited event frames arrive before the reply — the reader must
        # skip them rather than mistake one for its answer.
        while self._interleave:
            self._out.append(self._interleave.pop(0))
        reply = {"commandId": msg["commandId"], "success": True}
        if msg["command"] == "startSession":
            reply["sessionId"] = "SESSION-FAKE"
        if self._fail_on == msg["command"]:
            reply = {"commandId": msg["commandId"], "success": False, "error": "nope"}
        reply.update(self._reply_extra.get(msg["command"], {}))
        self._out.append(json.dumps(reply))

    async def recv(self):
        if self._out:
            return self._out.pop(0)
        await asyncio.sleep(3600)  # nothing more to say


class FakeClient:
    """Stands in for MilestoneClient without any credential."""

    base_url = "https://vms.example.invalid"
    verify_ssl = True

    def __init__(self):
        self.token_calls = 0

    async def bearer_token(self):
        self.token_calls += 1
        return "FAKE-TOKEN"


def test_ws_url_derivation():
    assert ws_url("https://h") == "wss://h/api/ws/events"
    assert ws_url("http://h") == "ws://h/api/ws/events"
    assert ws_url("https://h", "/x") == "wss://h/x"
    with pytest.raises(MilestoneError):
        ws_url("ftp://h")


def test_handshake_sends_exactly_the_three_permitted_verbs_in_order():
    ess = MilestoneEss(FakeClient())
    conn = FakeConn()
    asyncio.run(ess.handshake(conn))

    assert [m["command"] for m in conn.sent] == [
        "startSession", "addSubscription", "getState",
    ]
    # commandIds are monotonic, and the session is threaded through.
    assert [m["commandId"] for m in conn.sent] == [1, 2, 3]
    assert ess.session_id == "SESSION-FAKE"
    assert conn.sent[1]["sessionId"] == "SESSION-FAKE"


def test_no_verb_outside_the_permitted_set_can_be_sent():
    """The read-only rule is enforced in code, not just in the spec.

    A docs-only rule is one careless commit away from being broken, and this
    one is a charter invariant (CLAUDE.md §4.1).
    """
    conn = FakeConn()
    for forbidden in ("setState", "ptzMove", "startRecording", "deleteCamera", "removeSubscription"):
        with pytest.raises(ForbiddenCommand):
            asyncio.run(send_command(conn, {"command": forbidden, "commandId": 1}))
    assert conn.sent == []          # nothing reached the wire
    assert "setState" not in PERMITTED_COMMANDS


def test_reply_matching_skips_interleaved_event_frames():
    """The server pushes events between request and reply."""
    conn = FakeConn(interleave=[
        json.dumps({"eventType": "CameraStateChanged"}),
        "not json at all",
        json.dumps(["a", "list", "not", "an", "object"]),
    ])
    reply = asyncio.run(send_command(conn, {"command": "getState", "commandId": 7}))
    assert reply["commandId"] == 7


def test_rejected_handshake_raises_so_ws_treats_it_as_a_failed_connection():
    ess = MilestoneEss(FakeClient())
    with pytest.raises(EssProtocolError, match="addSubscription"):
        asyncio.run(ess.handshake(FakeConn(fail_on="addSubscription")))


def test_unfamiliar_but_successful_reply_shape_is_not_rejected():
    """ESS replies vary; only an explicit failure should fail."""
    ess = MilestoneEss(FakeClient())
    conn = FakeConn(reply_extra={
        "startSession": {"success": None, "status": "OK"},
        "addSubscription": {"success": None, "status": "OK"},
    })
    # success=None would be falsy, but an explicit OK status must win.
    conn._reply_extra["startSession"].pop("success")
    conn._reply_extra["addSubscription"].pop("success")
    asyncio.run(ess.handshake(conn))
    assert [m["command"] for m in conn.sent][0] == "startSession"


def test_observe_event_types_counts_without_interpreting():
    """The placeholder handler must never write state — it has no engine."""
    ess = MilestoneEss(FakeClient())

    async def feed():
        await ess.observe_event_types(json.dumps({"eventType": "CameraStateChanged"}))
        await ess.observe_event_types(json.dumps({"eventType": "CameraStateChanged"}))
        await ess.observe_event_types(json.dumps({"type": "HardwareOffline"}))
        await ess.observe_event_types("{{{ not json")
        await ess.observe_event_types(json.dumps([1, 2, 3]))
        await ess.observe_event_types(json.dumps({"nothing": "named"}))

    asyncio.run(feed())
    assert ess.event_types == {
        "CameraStateChanged": 2,
        "HardwareOffline": 1,
        "<unparseable>": 1,
        "<non-object>": 1,
        "<unnamed>": 1,
    }


def test_a_fresh_token_is_fetched_per_connect():
    """A reconnect after a long outage must not present an expired token."""
    client = FakeClient()
    ess = MilestoneEss(client)

    async def drive():
        # connect() is an async CM; entering it is what fetches the token. The
        # socket itself is never opened here — _ws_connect would need a server —
        # so assert on the token fetch, which happens first.
        gen = ess.connect()
        with pytest.raises(Exception):
            await gen.__aenter__()   # DNS/connect failure on .invalid
        return client.token_calls

    assert asyncio.run(drive()) == 1
