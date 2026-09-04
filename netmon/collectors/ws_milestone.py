"""Milestone Events/State (ESS) live path — connect factory + handshake.

The transport half of spec 11 D5 (approved 2026-07-28). ``ws.py`` owns
reconnect/backoff/watchdog and stays transport-agnostic; this module supplies
the two things it needs for Milestone specifically: a ``connect`` factory that
opens an authenticated socket, and an ``on_connect`` handshake that actually
starts the stream.

**Read-only in effect, not silent.** ESS is request/response keyed by
``commandId``, so the stream does not exist until commands are sent. Exactly
three verbs are permitted and ``_send`` refuses anything else — the rule is
enforced in code, not just documented, because "read-only" is a charter
invariant (CLAUDE.md §4.1) and a docs-only rule is one careless commit from
being broken.

What is deliberately NOT here: mapping event payloads onto ``device_state``.
The ESS event schema has never been validated against this VMS (spec 05
"validated against the live VMS at deploy"), and inventing a mapping would
fabricate state — the exact failure §4.5 forbids. ``observe_event_types``
records what actually arrives so the schema can be established from evidence;
the state mapping is a follow-up that runs after that.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from netmon.collectors.milestone_client import MilestoneClient, MilestoneError

log = logging.getLogger("netmon.collectors.ws_milestone")

# websockets >= 13 moved the asyncio client to websockets.asyncio.client.connect,
# which takes `additional_headers`; the legacy top-level websockets.connect takes
# `extra_headers`. Passing the wrong kwarg does NOT fail at import — it fails
# later inside loop.create_connection() with an opaque TypeError, which is how it
# reached production cron logs in the ZCD reference implementation. Bind whichever
# exists rather than assuming, and record which kwarg name goes with it.
try:  # pragma: no cover — depends on the installed websockets version
    from websockets.asyncio.client import connect as _ws_connect  # type: ignore[attr-defined]
    _HEADERS_KW = "additional_headers"
except ImportError:  # pragma: no cover
    from websockets import connect as _ws_connect  # type: ignore[no-redef]
    _HEADERS_KW = "extra_headers"

# The only verbs NetMon may send. Session setup and reads — nothing that mutates
# VMS state or controls a device (PTZ, recording start/stop, config change).
PERMITTED_COMMANDS = frozenset({"startSession", "addSubscription", "getState"})

# The path carries a version segment. Without it the gateway answers 404 at the
# HTTP upgrade, before any ESS command is sent — confirmed live 2026-09-04.
# reference/zabbix/milestone/milestone_ess_state.py:13 documents the real one.
DEFAULT_WS_PATH = "/api/ws/events/v1"


class EssProtocolError(MilestoneError):
    """The ESS peer rejected a command or answered unintelligibly."""


class ForbiddenCommand(MilestoneError):
    """A command outside PERMITTED_COMMANDS was attempted.

    Raised rather than logged: sending it would breach the read-only charter,
    so failing the connection is the correct outcome.
    """


class _CommandIds:
    """Monotonic commandId per the ESS spec."""

    def __init__(self) -> None:
        self._n = 0

    def next(self) -> int:
        self._n += 1
        return self._n


def ws_url(base_url: str, ws_path: str = DEFAULT_WS_PATH) -> str:
    """Derive the socket URL from the REST base — https→wss, http→ws."""
    if base_url.startswith("https://"):
        return "wss://" + base_url[len("https://"):] + ws_path
    if base_url.startswith("http://"):
        return "ws://" + base_url[len("http://"):] + ws_path
    raise MilestoneError(f"cannot derive a WebSocket URL from {base_url!r}")


async def send_command(conn: Any, message: dict, *, timeout: float = 20.0) -> dict:
    """Send one permitted command and return its matching reply.

    The server interleaves unsolicited event messages with replies, so read
    until the ``commandId`` matches instead of assuming the next frame is ours.
    """
    verb = message.get("command")
    if verb not in PERMITTED_COMMANDS:
        raise ForbiddenCommand(
            f"refusing to send {verb!r}: not in {sorted(PERMITTED_COMMANDS)} "
            "(NetMon is read-only — CLAUDE.md §4.1)"
        )
    want = message["commandId"]
    await conn.send(json.dumps(message))
    while True:
        raw = await asyncio.wait_for(conn.recv(), timeout=timeout)
        try:
            reply = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue  # an event frame we cannot parse — not our reply
        if not isinstance(reply, dict):
            continue
        if reply.get("commandId") == want:
            return reply


class MilestoneEss:
    """Builds the ``connect`` factory and ``on_connect`` handshake for ws.py."""

    #: What the subscription covers. ``cameras`` is the reference's scope and
    #: the only one proven on this VMS; widen deliberately, having checked the
    #: type is accepted, rather than by assuming a name.
    DEFAULT_RESOURCE_TYPES = ("cameras",)

    def __init__(self, client: MilestoneClient, *, ws_path: str = DEFAULT_WS_PATH,
                 resource_types: tuple[str, ...] = DEFAULT_RESOURCE_TYPES,
                 command_timeout: float = 20.0,
                 max_frame_bytes: int = 32 * 1024 * 1024) -> None:
        self.client = client
        self.ws_path = ws_path
        self.resource_types = resource_types
        self.initial_state: dict | None = None
        self.command_timeout = command_timeout
        # websockets defaults to a 1 MiB frame limit and closes the connection
        # with 1009 when a frame exceeds it. The getState snapshot for this
        # estate is ~4 MB (2,659 cameras, measured 2026-09-04), so the default
        # kills the socket on the first real reply — and the failure looks like
        # a dropped connection rather than a size problem. Headroom is
        # deliberate: the snapshot grows with the camera count.
        self.max_frame_bytes = max_frame_bytes
        self.session_id: str | None = None
        # Event *type* counts only — never payload contents. This is what lets
        # the real schema be established from evidence instead of guessed.
        self.event_types: dict[str, int] = {}

    def url(self) -> str:
        return ws_url(self.client.base_url, self.ws_path)

    @asynccontextmanager
    async def connect(self) -> AsyncIterator[Any]:
        """Open an authenticated socket. A fresh token per connect, so a
        reconnect after a long outage never presents an expired one."""
        token = await self.client.bearer_token()
        kwargs: dict[str, Any] = {
            _HEADERS_KW: {"Authorization": f"Bearer {token}"},
            "max_size": self.max_frame_bytes,
        }
        if not self.client.verify_ssl:
            import ssl

            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            kwargs["ssl"] = ctx
        async with _ws_connect(self.url(), **kwargs) as conn:
            yield conn

    async def handshake(self, conn: Any) -> None:
        """startSession → addSubscription → getState.

        Runs on every fresh connection. ws.py awaits this before marking the
        socket connected, so a failure here is a failed connection rather than
        a silently unsubscribed stream.
        """
        cid = _CommandIds()

        started = await send_command(conn, {
            "command": "startSession", "commandId": cid.next(),
        }, timeout=self.command_timeout)
        self.session_id = str(started.get("sessionId") or "") or None
        if not _ok(started):
            raise EssProtocolError(f"startSession rejected: {_why(started)}")

        # A subscription without filters is accepted and subscribes to
        # *nothing*: the handshake reports success and no frame ever arrives.
        # Confirmed live 2026-09-04 — 45 s of silence against an estate of 2,659
        # cameras. The filter shape is the reference's
        # (milestone_ess_state.py:215).
        subscribed = await send_command(conn, {
            "command": "addSubscription", "commandId": cid.next(),
            "sessionId": self.session_id,
            "filters": [{
                "modifier": "include",
                "resourceTypes": list(self.resource_types),
                "sourceIds": ["*"],
                "eventTypes": ["*"],
            }],
        }, timeout=self.command_timeout)
        if not _ok(subscribed):
            raise EssProtocolError(f"addSubscription rejected: {_why(subscribed)}")

        # Initial snapshot, so state is current at connect rather than only
        # after the first change event arrives. The reply IS the snapshot — the
        # reference reads state from here rather than from the event stream —
        # so it is kept rather than discarded.
        self.initial_state = await send_command(conn, {
            "command": "getState", "commandId": cid.next(),
            "sessionId": self.session_id,
        }, timeout=self.command_timeout)

        log.info("milestone ESS subscribed (session=%s)", "set" if self.session_id else "none")

    async def observe_event_types(self, raw: Any) -> None:
        """Count event types without interpreting them.

        The deliberate placeholder handler. It cannot fabricate state because it
        writes none — it only records which event types this VMS actually emits,
        which is the evidence the state mapping needs.
        """
        try:
            msg = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
        except (json.JSONDecodeError, TypeError):
            self.event_types["<unparseable>"] = self.event_types.get("<unparseable>", 0) + 1
            return
        if not isinstance(msg, dict):
            self.event_types["<non-object>"] = self.event_types.get("<non-object>", 0) + 1
            return
        kind = str(msg.get("eventType") or msg.get("type") or msg.get("command") or "<unnamed>")
        self.event_types[kind] = self.event_types.get(kind, 0) + 1


def _ok(reply: dict) -> bool:
    """ESS replies vary in how they signal success; treat an explicit failure as
    the only failure, so an unfamiliar-but-successful shape is not rejected."""
    for key in ("success", "ok"):
        if key in reply:
            return bool(reply[key])
    status = str(reply.get("status") or "").strip().lower()
    if status:
        return status not in ("error", "failed", "failure", "denied", "unauthorized")
    return "error" not in reply


def _why(reply: dict) -> str:
    """A short, credential-free reason for a rejection."""
    for key in ("error", "message", "reason", "status"):
        v = reply.get(key)
        if v:
            return str(v)[:200]
    return "no reason given"
