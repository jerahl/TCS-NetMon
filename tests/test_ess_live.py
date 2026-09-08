"""Live ESS subscription (spec 20 S7) — no socket, no credentials, no VMS.

Every frame here is the shape the live gateway actually sent on 2026-09-08:
`{"events": [...]}` with no top-level command, and each event carrying the same
six keys a `getState` state does. The interesting cases are all about what the
task refuses to do with that stream — 200 events a second, of which over 99% are
motion — rather than about the happy path.
"""

import asyncio
import json

from sqlalchemy import text

from netmon import db
from netmon.collectors.ess_live import EssLive
from tests.conftest import create_core_tables

# Event-type GUIDs are opaque; these stand in for the ones /eventTypes resolves.
COMM_STARTED = "type-comm-started"
COMM_ERROR = "type-comm-error"
MOTION_START = "type-motion-start"
RECORDING_STARTED = "type-recording-started"

NAMES = {
    COMM_STARTED: "CommunicationStarted",
    COMM_ERROR: "CommunicationError",
    MOTION_START: "MotionStart",
    RECORDING_STARTED: "RecordingStarted",
}


class FakeClient:
    base_url = "https://vms.example.invalid"
    verify_ssl = True

    async def bearer_token(self):
        return "FAKE-TOKEN"

    async def event_types(self):
        return [{"id": k, "name": v} for k, v in NAMES.items()]


def _seed(url):
    """Two cameras Milestone knows, one it knows and the registry does not."""
    engine = db.make_engine(url)
    create_core_tables(engine)
    with engine.begin() as c:
        c.execute(text(
            "INSERT INTO devices (name, site, device_type, enabled, milestone_hardware_id) "
            "VALUES ('CAM-Hall','BHS','camera',1,'guid-1'),"
            "       ('CAM-Gym','BHS','camera',1,'guid-2'),"
            "       ('NVR-1','BHS','recording_server',1,'guid-rs')"))
    engine.dispose()


def _live(url, **kw):
    live = EssLive(db.make_engine(url), FakeClient(), **kw)
    live._names = dict(NAMES)
    live._refresh_registry(force=True)
    return live


def _frame(*events):
    return json.dumps({"events": list(events)})


def _event(guid, type_id, kind="cameras"):
    return {"id": "e1", "source": f"{kind}/{guid}", "specversion": "1.0",
            "stategroupid": "sg", "time": "2026-09-08T16:00:00Z", "type": type_id}


def _state_of(url, device_id):
    engine = db.make_engine(url)
    row = db.fetch_one(engine, "SELECT value, severity, source FROM device_state "
                               "WHERE device_id = :d AND dimension = 'source_status'",
                       {"d": device_id})
    engine.dispose()
    return row


def test_a_communication_event_becomes_source_status(tmp_path):
    url = f"sqlite:///{tmp_path/'e1.db'}"
    _seed(url)
    live = _live(url)

    asyncio.run(live.handle_frame(_frame(_event("guid-1", COMM_ERROR))))
    # Nothing is written until the flush — the point of staging.
    assert _state_of(url, 1) is None
    live._flush()

    row = _state_of(url, 1)
    assert (row["value"], row["severity"]) == ("down", "crit")
    # The source names the interface, not just the platform: the Surveillance
    # page badges ESS-derived state separately from Config-API state.
    assert row["source"] == "milestone-ess"


def test_motion_and_recording_churn_is_dropped_not_written(tmp_path):
    """Over 99% of this stream is motion. Writing it would bury `state_events`.

    9,354 MotionStart in 120 seconds on the live estate, plus 2,406
    RecordingStarted — turning that into transition rows would make NetMon's
    history unreadable while describing an estate that is behaving perfectly
    normally.
    """
    url = f"sqlite:///{tmp_path/'e2.db'}"
    _seed(url)
    live = _live(url)

    frame = _frame(_event("guid-1", MOTION_START),
                   _event("guid-2", RECORDING_STARTED),
                   _event("guid-1", MOTION_START))
    asyncio.run(live.handle_frame(frame))
    assert live._flush() == 0
    assert _state_of(url, 1) is None
    # Dropped, but counted: the evidence of what this VMS emits is the reason
    # the mapping could be written at all.
    assert live.seen["MotionStart"] == 2
    assert live.seen["RecordingStarted"] == 1
    assert live.events == 3


def test_the_last_verdict_in_a_window_is_the_one_written(tmp_path):
    """A camera that fails and recovers inside one flush window is up.

    Current state is what `device_state` holds; the flicker is not a fact worth
    a transition row, and writing both would invent a down that was over before
    anyone could see it.
    """
    url = f"sqlite:///{tmp_path/'e3.db'}"
    _seed(url)
    live = _live(url)

    asyncio.run(live.handle_frame(_frame(_event("guid-1", COMM_ERROR))))
    asyncio.run(live.handle_frame(_frame(_event("guid-1", COMM_STARTED))))
    assert live._flush() == 1
    assert _state_of(url, 1)["value"] == "up"

    engine = db.make_engine(url)
    events = db.fetch_all(engine, "SELECT new_value FROM state_events WHERE device_id = 1")
    engine.dispose()
    assert [e["new_value"] for e in events] == ["up"]


def test_a_failed_flush_keeps_its_deltas_for_the_next_one(tmp_path):
    """A write that fails must not lose the observation.

    The camera really did stop talking; a transient DB error does not un-happen
    that, and dropping the batch would leave the estate reading healthy until
    the next 120s snapshot repaired it.
    """
    url = f"sqlite:///{tmp_path/'e4.db'}"
    _seed(url)
    live = _live(url)
    asyncio.run(live.handle_frame(_frame(_event("guid-1", COMM_ERROR))))

    good, live.engine = live.engine, None   # any flush now raises
    try:
        live._flush()
    except Exception:
        pass
    assert live._pending == {1: ("down", "crit")}

    live.engine = good
    assert live._flush() == 1
    assert _state_of(url, 1)["value"] == "down"


def test_a_retried_delta_never_overwrites_a_newer_one(tmp_path):
    """The put-back must lose to anything that arrived while it was in flight.

    Newer is what `device_state` means: if the camera came back during the
    failed write, the retry must not resurrect the down.
    """
    url = f"sqlite:///{tmp_path/'e4b.db'}"
    _seed(url)
    live = _live(url)
    asyncio.run(live.handle_frame(_frame(_event("guid-1", COMM_ERROR))))

    good, live.engine = live.engine, None
    try:
        live._flush()
    except Exception:
        pass
    # ... and the recovery lands before the retry.
    asyncio.run(live.handle_frame(_frame(_event("guid-1", COMM_STARTED))))
    live.engine = good
    live._flush()
    assert _state_of(url, 1)["value"] == "up"


def test_a_camera_the_registry_does_not_know_is_counted_not_guessed(tmp_path):
    url = f"sqlite:///{tmp_path/'e5.db'}"
    _seed(url)
    live = _live(url)

    asyncio.run(live.handle_frame(_frame(_event("guid-unknown", COMM_ERROR))))
    assert live._flush() == 0
    assert live.seen["<unregistered-camera>"] == 1


def test_recording_server_events_are_left_to_the_cycle(tmp_path):
    """The 120s cycle owns `recording_servers` with a replace-on-refresh upsert.

    A second writer there would fight it, so this task subscribes to cameras
    only and ignores anything that is not one.
    """
    url = f"sqlite:///{tmp_path/'e6.db'}"
    _seed(url)
    live = _live(url)
    assert live.ess.resource_types == ("cameras",)

    asyncio.run(live.handle_frame(
        _frame(_event("guid-rs", COMM_ERROR, kind="recordingServers"))))
    assert live._flush() == 0
    assert _state_of(url, 3) is None


def test_a_malformed_frame_cannot_kill_the_pump(tmp_path):
    url = f"sqlite:///{tmp_path/'e7.db'}"
    _seed(url)
    live = _live(url)

    asyncio.run(live.handle_frame("{not json"))
    asyncio.run(live.handle_frame(json.dumps([1, 2, 3])))
    asyncio.run(live.handle_frame(json.dumps({"commandId": 9, "success": True})))
    assert live.dropped == 2
    assert live.seen["<no-events>"] == 1
    # And a good frame after the bad ones still lands.
    asyncio.run(live.handle_frame(_frame(_event("guid-1", COMM_STARTED))))
    assert live._flush() == 1


def test_the_type_counter_is_bounded(tmp_path):
    """A counter keyed on a remote system's strings is a memory leak unless it
    is capped. 200 events/second is a lot of opportunity."""
    url = f"sqlite:///{tmp_path/'e8.db'}"
    _seed(url)
    live = _live(url)
    for i in range(500):
        live._count(f"type-{i}")
    assert len(live.seen) == 200
    # An already-known key keeps counting after the cap.
    live._count("type-0")
    assert live.seen["type-0"] == 2


def test_reconnect_reapplies_the_full_snapshot(tmp_path):
    """What makes a reconnect self-healing.

    Anything that changed while the socket was down is in `getState`, so the
    estate is correct the moment the stream is back — not only after each camera
    next happens to change.
    """
    url = f"sqlite:///{tmp_path/'e9.db'}"
    _seed(url)
    live = _live(url)

    class FakeEss:
        resource_types = ("cameras",)

        def __init__(self):
            self.initial_state = {"states": [
                _event("guid-1", COMM_ERROR),
                _event("guid-2", COMM_STARTED),
                _event("guid-1", MOTION_START),      # ignored, as in the stream
            ]}

        async def handshake(self, conn):
            return None

    live.ess = FakeEss()
    asyncio.run(live._on_connect(object()))

    assert _state_of(url, 1)["value"] == "down"
    assert _state_of(url, 2)["value"] == "up"


def test_status_reports_the_stream_without_leaking_payloads(tmp_path):
    url = f"sqlite:///{tmp_path/'e10.db'}"
    _seed(url)
    live = _live(url)
    asyncio.run(live.handle_frame(_frame(_event("guid-1", COMM_STARTED),
                                         _event("guid-2", MOTION_START))))
    live._flush()

    st = live.status()
    assert st["frames"] == 1 and st["events"] == 2 and st["applied"] == 1
    assert st["connected"] is False          # never actually connected here
    # Event *types* with counts — evidence, never payload contents.
    assert dict(st["top_event_types"])["MotionStart"] == 1


def test_a_connect_snapshot_is_not_counted_as_stream_traffic(tmp_path):
    """Measured live: one connect stages ~2,500 CommunicationStarted states
    while 100 s of actual stream carried none of them. Counting both in one
    bucket makes the stream look like it is full of camera state changes when
    what it is really full of is motion."""
    url = f"sqlite:///{tmp_path/'e11.db'}"
    _seed(url)
    live = _live(url)

    class FakeEss:
        resource_types = ("cameras",)
        initial_state = {"states": [_event("guid-1", COMM_STARTED),
                                    _event("guid-2", COMM_STARTED)]}

        async def handshake(self, conn):
            return None

    live.ess = FakeEss()
    asyncio.run(live._on_connect(object()))

    assert live.snapshot_states == 2
    assert live.events == 0
    assert "CommunicationStarted" not in live.seen
    assert live.status()["snapshot_states"] == 2

    # A real stream event afterwards is counted.
    asyncio.run(live.handle_frame(_frame(_event("guid-1", COMM_ERROR))))
    assert live.events == 1
    assert live.seen["CommunicationError"] == 1
