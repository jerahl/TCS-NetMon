"""Milestone Events/State as a live stream (spec 20 S7).

The ESS has been read as a **snapshot**: every 120 s the Milestone cycle opens a
socket, runs `startSession → addSubscription → getState`, reads ~16,500 states
out of the reply and closes it. That is honest but coarse — a camera that stops
talking is invisible for up to two minutes, and the 4 MB snapshot is paid every
cycle.

This keeps the socket open instead and applies `source_status` as the events
arrive. Same three approved verbs (D5), same read-only posture: the stream still
has to be *asked* for, and nothing else is ever sent.

**What the estate actually emits**, measured on the live gateway 2026-09-08
before any of this was written, because the event schema had never been
validated (the reason `ws_milestone.observe_event_types` counts types rather
than interpreting them):

    120 s of subscription → 7,366 frames, ~24,000 events
    frame shape:  {"events": [ ... ]}       — no command/type at the top level
    event shape:  id, source, specversion, stategroupid, time, type
                  — byte-identical to a `getState` state, so one parser serves both

    MotionStart 9,354 · MotionEnd 9,311 · RecordingStarted 2,406 ·
    RecordingStopped 2,373 · Recording FPS Warning 520 · … and no Communication
    event at all in that window

Three things follow from that measurement, and they are the whole design:

1. **Volume is the constraint, not latency.** ~200 events/second, sustained. A
   DB write per event would be 200 transactions/second against a table the
   dashboards read; a name lookup per event that touched the network would be
   worse. So events are filtered in memory against a cached type map and
   coalesced into one batched write every `flush_s`.

2. **Almost everything is noise, and writing it would be damage.** Only
   `Communication*` moves `source_status`. Motion and recording churn is
   *deliberately dropped*: `recording` is a Config-API fact here, and turning
   24,000 motion events an hour into `state_events` rows would bury the
   transition log this project treats as its history (CLAUDE.md §6) under an
   estate that is behaving perfectly normally.

3. **A quiet socket is not obviously a dead one.** At 3am the motion that
   dominates this stream stops, so the watchdog is 180 s rather than ws.py's
   60 s default — long enough that an idle night does not force a needless 4 MB
   resync, short enough that a genuinely dead socket is noticed and replaced.

**Why this may run alongside the 120 s snapshot rather than replacing it.** Both
writers derive the same dimension from the same interface, so they cannot
disagree about a camera that has not changed, and `write_states` only records a
transition when the value actually moves — so agreement costs nothing and logs
nothing. Where they differ, the newer observation is the correct one and it wins,
whichever produced it. That makes the periodic snapshot a *repair* for any delta
this task missed while reconnecting, which is worth more than the bytes it costs.
The recording-server state columns stay the cycle's alone: it owns that row with
a replace-on-refresh upsert, and a second writer there would fight it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db, health
# ESS_COMMUNICATION maps an event name to (`source_status`, severity). Imported
# rather than re-declared so the snapshot path and this one can never drift into
# disagreeing about what "CommunicationStopped" means. `milestone` does not
# import this module, so the dependency runs one way only.
from netmon.collectors.milestone import ESS_COMMUNICATION
from netmon.collectors.milestone_client import MilestoneClient
from netmon.collectors.ws import ResilientWebSocket
from netmon.collectors.ws_milestone import MilestoneEss
from netmon.state import write_states

log = logging.getLogger("netmon.collectors.ess_live")

HEALTH_NAME = "milestone_ess_live"


class EssLive:
    """Long-lived ESS subscription writing camera `source_status` deltas."""

    def __init__(self, engine: Engine, client: MilestoneClient, *,
                 flush_s: float = 5.0, watchdog_s: float = 180.0,
                 registry_refresh_s: float = 300.0) -> None:
        self.engine = engine
        self.client = client
        self.flush_s = max(1.0, flush_s)
        self.watchdog_s = max(30.0, watchdog_s)
        self.registry_refresh_s = max(60.0, registry_refresh_s)

        self.ess = MilestoneEss(client, resource_types=("cameras",))
        # Only cameras. Recording-server state columns belong to the 120 s
        # cycle, which owns that row wholesale; subscribing to them here would
        # collect events this task then has nowhere safe to put.

        #: Staged deltas, `device_id → (value, severity)`. Last write wins
        #: within a flush window, which is what "current state" means: a camera
        #: that fails and recovers inside five seconds is up, and the
        #: intermediate value is not a fact worth a transition row.
        self._pending: dict[int, tuple[str, str]] = {}
        self._names: dict[str, str] = {}
        self._registry: dict[str, int] = {}
        self._registry_at = 0.0

        # Observability, all bounded. `seen` counts event *types*, never
        # payloads — the same rule ws_milestone.observe_event_types follows.
        self.frames = 0
        self.events = 0
        self.applied = 0
        self.dropped = 0
        #: States read out of a `getState` reply, counted apart from stream
        #: events. Mixing them makes the stream look like it carries thousands
        #: of Communication events when almost all of those are one connect's
        #: baseline: measured live, a connect stages ~2,500 CommunicationStarted
        #: states while 100 s of actual stream carried none.
        self.snapshot_states = 0
        self.seen: dict[str, int] = {}
        self.connected_at: float | None = None
        self._ws: ResilientWebSocket | None = None

    # ── wiring ────────────────────────────────────────────────────────────

    @classmethod
    def from_collector(cls, engine: Engine, collector: Any, settings: dict[str, str]) -> "EssLive":
        """Built from the Milestone collector so both share one client/token."""
        return cls(
            engine, collector.client,
            flush_s=float(settings.get("ess_live_flush_s") or 5.0),
            watchdog_s=float(settings.get("ess_live_watchdog_s") or 180.0),
        )

    async def run(self) -> None:
        """Pump the socket and flush staged deltas, until cancelled."""
        self._ws = ResilientWebSocket(
            "milestone-ess",
            connect=self.ess.connect,
            handle=self.handle_frame,
            on_connect=self._on_connect,
            watchdog_s=self.watchdog_s,
        )
        health.record_start(self.engine, HEALTH_NAME)
        flusher = asyncio.create_task(self._flush_loop(), name="ess-live-flush")
        try:
            await self._ws.run()
        finally:
            flusher.cancel()
            try:
                await flusher
            except asyncio.CancelledError:
                pass
            # Whatever is staged at shutdown is still true; write it rather
            # than discard it.
            self._flush()

    def stop(self) -> None:
        if self._ws is not None:
            self._ws.stop()

    # ── connection ────────────────────────────────────────────────────────

    async def _on_connect(self, conn: Any) -> None:
        """Handshake, then apply the snapshot the handshake already fetched.

        The snapshot is not a nicety: it is what makes a reconnect self-healing.
        Anything that changed while the socket was down is in `getState`, so the
        estate is correct again the moment the stream is back rather than only
        after each camera next changes.
        """
        await self.ess.handshake(conn)
        self.connected_at = time.time()
        await self._refresh_names()
        self._refresh_registry(force=True)

        states = (self.ess.initial_state or {}).get("states") or []
        staged = 0
        for st in states:
            self.snapshot_states += 1
            if self._stage(st, live=False):
                staged += 1
        log.info("ess-live connected: %d state(s) in the snapshot, %d camera verdict(s) staged",
                 len(states), staged)
        self._flush()

    async def _refresh_names(self) -> None:
        """GUID → event-type name. One Config-API read per connection.

        Cached for the life of the connection because it is the hot path's only
        lookup: at 200 events/second this map is consulted 200 times a second,
        and a network call there would be the whole problem.
        """
        if self._names:
            return
        rows = await self.client.event_types()
        self._names = {str(t.get("id")): str(t.get("name") or "") for t in rows}

    def _refresh_registry(self, *, force: bool = False) -> None:
        """Milestone hardware id → NetMon device id, for cameras only."""
        if not force and (time.time() - self._registry_at) < self.registry_refresh_s:
            return
        rows = db.fetch_all(
            self.engine,
            "SELECT id, milestone_hardware_id FROM devices "
            "WHERE enabled = 1 AND device_type = 'camera' "
            "AND milestone_hardware_id IS NOT NULL AND milestone_hardware_id <> ''")
        self._registry = {str(r["milestone_hardware_id"]): int(r["id"]) for r in rows}
        self._registry_at = time.time()

    # ── the hot path ──────────────────────────────────────────────────────

    async def handle_frame(self, raw: Any) -> None:
        """One frame → staged deltas. Must stay cheap: ~60 frames/second."""
        try:
            msg = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
        except (json.JSONDecodeError, TypeError):
            self.dropped += 1
            return
        if not isinstance(msg, dict):
            self.dropped += 1
            return
        self.frames += 1
        events = msg.get("events")
        if not isinstance(events, list):
            # Not every frame is an event batch — a late command reply can land
            # here. Counted, not interpreted.
            self._count("<no-events>")
            return
        for ev in events:
            if isinstance(ev, dict):
                self.events += 1
                self._stage(ev)

    def _stage(self, st: dict, *, live: bool = True) -> bool:
        """Stage one state/event if it is a camera Communication verdict.

        Returns True when it was staged. Everything else — motion, recording,
        FPS, live-feed — is counted and dropped, which on this estate is well
        over 99% of the stream. ``live`` is False for the connect snapshot, whose
        states must not be counted as stream traffic.
        """
        source = str(st.get("source") or "")
        if not source.startswith("cameras/"):
            return False
        name = self._names.get(str(st.get("type"))) or ""
        if live:
            self._count(name or "<unknown-type>")
        verdict = ESS_COMMUNICATION.get(name)
        if verdict is None:
            return False
        device_id = self._registry.get(source.split("/")[-1])
        if device_id is None:
            # A camera Milestone knows and the registry does not. Real and worth
            # counting — it means an import is behind — but not an error here.
            self._count("<unregistered-camera>")
            return False
        self._pending[device_id] = verdict
        return True

    def _count(self, kind: str) -> None:
        # Bounded: an unbounded counter keyed on a remote system's strings is a
        # memory leak with a plausible excuse.
        if kind in self.seen or len(self.seen) < 200:
            self.seen[kind] = self.seen.get(kind, 0) + 1

    # ── flushing ──────────────────────────────────────────────────────────

    async def _flush_loop(self) -> None:
        while True:
            await asyncio.sleep(self.flush_s)
            try:
                self._refresh_registry()
                self._flush()
            except Exception as exc:              # noqa: BLE001 — never kill the pump
                log.warning("ess-live flush failed, deltas kept for the next one: %r", exc)
                health.record_error(self.engine, HEALTH_NAME, message=repr(exc)[:400],
                                    duration_ms=0)

    def _flush(self) -> int:
        """Write staged deltas in one batch. Returns rows actually changed."""
        if not self._pending:
            return 0
        started = time.monotonic()
        batch, self._pending = self._pending, {}
        rows = [(device_id, "source_status", value, severity, "milestone-ess")
                for device_id, (value, severity) in batch.items()]
        try:
            changed = write_states(self.engine, rows)
        except Exception:
            # A failed write must not lose the observation. Put the batch back
            # for the next flush — but never over a value that arrived while
            # this one was in flight, because that one is newer and newer is
            # what `device_state` means.
            for device_id, verdict in batch.items():
                self._pending.setdefault(device_id, verdict)
            raise
        self.applied += changed
        health.record_success(self.engine, HEALTH_NAME, records=changed,
                              duration_ms=int((time.monotonic() - started) * 1000))
        if changed:
            log.info("ess-live applied %d camera state change(s) from %d delta(s)",
                     changed, len(rows))
        return changed

    # ── observability ─────────────────────────────────────────────────────

    def status(self) -> dict:
        """What NetMon Status shows for the live stream."""
        ws = self._ws
        return {
            "connected": bool(ws and ws.connected),
            "reconnects": ws.reconnects if ws else 0,
            "frames": self.frames,
            "events": self.events,
            "applied": self.applied,
            "snapshot_states": self.snapshot_states,
            "pending": len(self._pending),
            "connected_at": self.connected_at,
            "last_message_at": ws.last_message_at if ws else None,
            # Top event types by volume — evidence, not payloads.
            "top_event_types": sorted(self.seen.items(), key=lambda kv: -kv[1])[:10],
        }
