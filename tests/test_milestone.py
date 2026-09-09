import asyncio

import pytest
from datetime import datetime, timezone

from sqlalchemy import text

from netmon import db
from netmon.collectors.milestone import MilestoneCollector
from netmon.collectors.milestone_client import MilestoneError
from netmon.snapshots import read_snapshot
from tests.conftest import create_core_tables


class FakeMs:
    def __init__(self):
        self.servers = []
        self.cameras_data = []
        self.storage_data = []
        self.hardware_data = []
        # hardwareDriverSettings: the only place Milestone exposes a camera MAC.
        self.settings_data = {}
        self.settings_calls = []
        self.settings_fail = None
        self.fail = None
        self.storage_fail = None
        # Camera groups (migration 026) — the Smart Client tree.
        self.groups_data = []
        self.groups_fail = None
        # Environment facts (spec 20 S2): /sites and /licenseDetails.
        self.site_data = {}
        self.site_fail = None
        self.license_data = []
        self.license_fail = None

    async def recording_servers(self):
        if self.fail:
            raise self.fail
        return self.servers

    async def cameras(self):
        if self.fail:
            raise self.fail
        return self.cameras_data

    async def storage(self, recording_server_ids=None):
        if self.storage_fail:
            raise self.storage_fail
        return self.storage_data

    async def hardware(self):
        return self.hardware_data

    async def camera_groups(self):
        if self.groups_fail:
            raise self.groups_fail
        return self.groups_data

    async def site_info(self):
        if self.site_fail:
            raise self.site_fail
        return self.site_data

    async def license_details(self):
        if self.license_fail:
            raise self.license_fail
        return self.license_data

    async def hardware_driver_settings(self, hardware_id):
        self.settings_calls.append(hardware_id)
        if self.settings_fail:
            raise self.settings_fail
        return self.settings_data.get(hardware_id, {})


def _engine(tmp_path):
    e = db.make_engine(f"sqlite:///{tmp_path / 'ms.db'}")
    create_core_tables(e)
    with e.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, enabled, milestone_hardware_id) "
            "VALUES ('NVR-1','BHS','recording_server',1,'RS1'),"
            "       ('CAM-Hall','BHS','camera',1,'CAM1')"
        ))
    return e


def _state(engine, dimension):
    return {
        r["milestone_hardware_id"]: r
        for r in db.fetch_all(
            engine,
            "SELECT d.milestone_hardware_id, s.value, s.severity FROM devices d "
            "JOIN device_state s ON s.device_id = d.id AND s.dimension = :dim",
            {"dim": dimension},
        )
    }


def test_milestone_writes_recording_and_source_status(tmp_path):
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": False}]
    ms = MilestoneCollector(engine, fake, ess_enabled=False)
    n = asyncio.run(ms.run_once())
    assert n == 4  # 2 state writes (RS source_status + cam recording) + 2 persisted rows

    src = _state(engine, "source_status")
    rec = _state(engine, "recording")
    assert src["RS1"]["value"] == "up" and src["RS1"]["severity"] == "ok"
    assert rec["CAM1"]["value"] == "down" and rec["CAM1"]["severity"] == "crit"


def test_milestone_blind_on_unreachable(tmp_path):
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    ms = MilestoneCollector(engine, fake, ess_enabled=False)
    asyncio.run(ms.run_once())

    fake.fail = MilestoneError("gateway down")
    # A source that is genuinely gone must go blind — stale rows would read as
    # healthy. But that now takes a *persistent* failure: one blip used to
    # overwrite good state for the whole estate, which on 2026-09-06 turned a
    # transient error into an apparent full recovery.
    asyncio.run(ms.run_guarded())
    src = _state(engine, "source_status")
    assert src["RS1"]["value"] != "blind", "one failure must not blind the estate"

    for _ in range(ms.blind_after_failures - 1):
        asyncio.run(ms.run_guarded())

    src = _state(engine, "source_status")
    assert src["RS1"]["value"] == "blind"
    assert src["CAM1"]["value"] == "blind"
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='milestone'")
    assert h["consecutive_failures"] == ms.blind_after_failures


# ---- Phase 10.4 inventory persistence ---------------------------------------

def test_milestone_persists_cameras_servers_and_overview(tmp_path):
    from netmon.collectors.milestone_client import MilestoneError
    from netmon.snapshots import read_snapshot
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "hostName": "nvr-1.tcs", "running": True,
                     "productVersion": "23.2", "cameraCount": 40, "recordingCameraCount": 38}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True, "model": "AXIS P3255",
                          "resolution": "1920x1080", "framerate": 15, "codec": "H.264",
                          "recordingServerId": "RS1", "hardwareId": "HW1"}]
    fake.hardware_data = [{"id": "HW1", "mac": "00:40:8c:aa:bb:cc", "address": "192.0.2.60"}]
    # Real /recordingServers/{id}/storages shape: maxSize in MB, retainMinutes,
    # and archives inline. The previous fixture here used {used, size,
    # retentionDays} — the invented shape of GET /storages, which does not
    # exist (400). It asserted against a payload nobody ever received.
    fake.storage_data = [{"id": "S1", "recordingServerId": "RS1",
                          "maxSize": 8_192_000, "retainMinutes": 43_200,
                          "archives": []}]
    n = asyncio.run(MilestoneCollector(engine, fake, ess_enabled=False).run_once())
    assert n >= 4  # 2 state + 1 rs row + 1 cam row

    rs = db.fetch_one(engine, "SELECT * FROM recording_servers WHERE device_id=1")
    assert rs["hostname"] == "nvr-1.tcs" and rs["chans_total"] == 40
    assert round(rs["storage_total_gb"]) == 8000 and rs["retention_days"] == 30

    cam = db.fetch_one(engine, "SELECT * FROM cameras WHERE device_id=2")
    assert cam["model"] == "AXIS P3255" and cam["fps_target"] == 15
    assert cam["mac"] == "00:40:8c:aa:bb:cc"        # FDB join key, canonicalized
    assert cam["recording_server_device_id"] == 1   # linked to the RS device

    ov = read_snapshot(engine, "milestone.overview")
    assert ov["ok"] and ov["payload"]["cameras"] == 1 and ov["payload"]["recording_servers"] == 1


def test_milestone_unlinked_entities_surface_in_overview(tmp_path):
    """The exact 'configured but no data' trap: Milestone answers, but no
    registry device carries the matching milestone_hardware_id. The overview
    snapshot must expose discovered>0 / linked==0 so the UI can point at the
    import (and nothing is silently blank)."""
    from netmon.snapshots import read_snapshot
    engine = db.make_engine(f"sqlite:///{tmp_path/'ms.db'}")
    create_core_tables(engine)  # NOTE: no devices linked to Milestone
    fake = FakeMs()
    fake.servers = [{"id": "RS-X", "running": True}]
    fake.cameras_data = [{"id": "CAM-X", "recordingEnabled": True},
                         {"id": "CAM-Y", "recordingEnabled": True}]
    n = asyncio.run(MilestoneCollector(engine, fake, ess_enabled=False).run_once())
    assert n == 0  # nothing linked → nothing written
    ov = read_snapshot(engine, "milestone.overview")["payload"]
    assert ov["discovered_servers"] == 1 and ov["discovered_cameras"] == 2
    assert ov["linked_servers"] == 0 and ov["linked_cameras"] == 0
    assert ov["cameras"] == 0  # no rows persisted


def test_milestone_storage_endpoint_fail_soft(tmp_path):
    from netmon.collectors.milestone_client import MilestoneError
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    fake.storage_fail = MilestoneError("Milestone HTTP 404 on /storages")
    # The whole cycle still succeeds; RS row just has NULL storage.
    asyncio.run(MilestoneCollector(engine, fake, ess_enabled=False).run_once())
    rs = db.fetch_one(engine, "SELECT * FROM recording_servers WHERE device_id=1")
    assert rs is not None and rs["storage_total_gb"] is None


def test_milestone_unreachable_keeps_inventory_stale(tmp_path):
    from netmon.collectors.milestone_client import MilestoneError
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    asyncio.run(MilestoneCollector(engine, fake, ess_enabled=False).run_once())

    fake.fail = MilestoneError("unreachable")
    asyncio.run(MilestoneCollector(engine, fake, ess_enabled=False).run_guarded())
    # Rows kept (stale), never blanked on a failed refresh.
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM cameras")["n"] == 1
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='milestone'")
    assert h["consecutive_failures"] == 1


def test_degraded_enrichment_is_reported_not_silent(tmp_path):
    """A 0 GB storage roll-up must be distinguishable from a broken endpoint.

    /storages answers HTTP 400 on the live deployment and the collector caught
    it at log.info, so the roll-up was empty while the cycle reported success —
    the exact invisible degradation §4.5 exists to prevent.
    """
    import json

    from netmon.collectors.milestone_client import MilestoneError
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    fake.storage_fail = MilestoneError("Milestone HTTP 400 on /storages")
    asyncio.run(MilestoneCollector(engine, fake, ess_enabled=False).run_once())

    row = db.fetch_one(engine, "SELECT payload FROM snapshot_cache WHERE `key`='milestone.overview'")
    payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
    assert payload["degraded"] == ["storage"]
    # Still fail-soft: the cycle completed and the rest of the inventory landed.
    assert payload["recording_servers"] == 1


def test_healthy_cycle_reports_nothing_degraded(tmp_path):
    import json

    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    asyncio.run(MilestoneCollector(engine, fake, ess_enabled=False).run_once())

    row = db.fetch_one(engine, "SELECT payload FROM snapshot_cache WHERE `key`='milestone.overview'")
    payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
    assert payload["degraded"] == []


def test_camera_hardware_resolves_via_relations_parent():
    """/cameras has no hardwareId — the link is relations.parent.

    Regression (2026-07-28): build_cameras keyed hw_by_id on
    _first(cam, "hardwareId", "hardware"), a field this XProtect never returns.
    The key was always "", the hardware dict always empty, and cameras.ip
    unconditionally NULL — even though the fallback to hardware was written.
    """
    from datetime import datetime, timezone

    from netmon.collectors.milestone import build_cameras

    reg = {"CAM1": {"id": 1}}
    cams = [{
        "id": "CAM1",
        "relations": {"parent": {"type": "hardware", "id": "HW-GUID-1"}},
        "recordingEnabled": True,
    }]
    hw = {"HW-GUID-1": {"address": "http://192.0.2.10/", "model": "FAKE-CAM",
                        "mac": "00:00:5E:00:53:01"}}
    rows = build_cameras(cams, reg, hw, {}, datetime.now(timezone.utc))

    assert len(rows) == 1
    assert rows[0]["ip"] == "192.0.2.10", "URL-shaped address must reduce to a bare host"
    assert rows[0]["model"] == "FAKE-CAM"
    assert rows[0]["mac"] is not None, "the hardware MAC still reaches the row"


def test_camera_hardware_link_tolerates_other_shapes():
    """Other XProtect versions expose the link differently — keep working."""
    from netmon.collectors.milestone import _hardware_key

    assert _hardware_key({"relations": {"parent": {"type": "hardware", "id": "H1"}}}) == "H1"
    # parent as a list, and relations carrying unrelated entries first
    assert _hardware_key({"relations": {"parent": [
        {"type": "recordingServer", "id": "RS1"},
        {"type": "Hardware", "id": "H2"},
    ]}}) == "H2"
    assert _hardware_key({"relations": {"related": [{"type": "hardware", "guid": "H3"}]}}) == "H3"
    # Legacy flat field still honoured.
    assert _hardware_key({"hardwareId": "H4"}) == "H4"
    # Nothing resolvable → empty, and build_cameras degrades to NULL ip.
    assert _hardware_key({"relations": {"parent": {"type": "recordingServer", "id": "RS"}}}) == ""
    assert _hardware_key({}) == ""


def test_host_from_address_handles_ports_and_bare_hosts():
    """5 devices carry a non-default port; the host alone belongs in cameras.ip."""
    from netmon.collectors.milestone import _host_from_address

    assert _host_from_address("http://192.0.2.10/") == "192.0.2.10"
    assert _host_from_address("http://192.0.2.10:8080/") == "192.0.2.10"
    assert _host_from_address("192.0.2.10") == "192.0.2.10"
    assert _host_from_address("192.0.2.10:8080") == "192.0.2.10"
    assert _host_from_address("https://cam.example.invalid/snap") == "cam.example.invalid"
    assert _host_from_address(None) is None
    assert _host_from_address("") is None


def test_storage_rollup_uses_megabytes_and_cumulative_retention(tmp_path):
    """Two units were wrong here, and both rendered as plausible numbers.

    ``maxSize`` is MEGABYTES. NHS's live storage reads 103,014,400, which is its
    documented 100,600 GB — dividing by 1e9 as though it were bytes rendered
    every recorder on the estate as 0 GB while the collector reported success.

    Archive retention in XProtect is **cumulative from the moment of recording,
    not additive** on top of the live storage, so the total a recorder holds is
    MAX(retainMinutes) and never SUM. Summing NHS's 45-day live and 61-day
    archive would claim 106 days where it actually keeps 61.
    """
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "name": "NVR-1", "enabled": True}]
    fake.storage_data = [{
        "id": "S1", "recordingServerId": "RS1", "name": "Local default",
        "maxSize": 103_014_400,          # 100,600 GB
        "retainMinutes": 64_800,          # 45 days (live)
        "archives": [{"id": "A1", "maxSize": 20_480_000,   # 20,000 GB
                      "retainMinutes": 87_840}],           # 61 days (cumulative)
    }]
    asyncio.run(MilestoneCollector(engine, fake, ess_enabled=False).run_once())

    row = db.fetch_one(engine, "SELECT storage_total_gb, retention_days, storage_used_gb "
                               "FROM recording_servers LIMIT 1")
    assert round(row["storage_total_gb"]) == 120_600      # 100,600 live + 20,000 archive
    assert row["retention_days"] == 61                     # MAX, not 45+61=106
    # The Config API exposes configured size but not consumed space, so used
    # must stay NULL. A 0 here would render as "nothing used" on the NOC wall.
    assert row["storage_used_gb"] is None


def test_storage_walk_failure_leaves_the_rollup_empty_not_zero(tmp_path):
    """A failed walk must be visible as degraded, never as a confident 0 GB."""
    from netmon.collectors.milestone import MilestoneError
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "name": "NVR-1", "enabled": True}]
    fake.storage_fail = MilestoneError("boom")
    asyncio.run(MilestoneCollector(engine, fake, ess_enabled=False).run_once())

    row = db.fetch_one(engine, "SELECT storage_total_gb FROM recording_servers LIMIT 1")
    assert not row["storage_total_gb"]
    snap = read_snapshot(engine, "milestone.overview")
    assert "storage" in (snap["payload"].get("degraded") or [])


def test_camera_address_keeps_its_port_and_names_its_physical_device():
    """Two facts the host reduction was throwing away.

    Six of 2,489 hardware carry an explicit port and five are
    ``http://<ip>:443/`` — an http scheme on the TLS port. Inferring the scheme
    from the port contradicts the field; dropping the port sends D7's snapshot
    proxy to the wrong socket. Neither shows up in a fixture, because a fixture
    would not contain six oddities out of 2,489.

    And 61 hardware records here carry more than one camera — one AXIS M3007
    panoramic has eleven, on channels 0-10. That is one physical device, not
    eleven rivals for an address, which is the distinction the poller's
    contested-address guard cannot make without ``hardware_id``.
    """
    from netmon.collectors.milestone import _host_from_address, _port_from_address

    assert _host_from_address("http://10.84.18.20/") == "10.84.18.20"
    assert _port_from_address("http://10.84.18.20/") is None      # default

    # The live oddity: http scheme, TLS port. Host and port must both survive.
    assert _host_from_address("http://10.84.18.20:443/") == "10.84.18.20"
    assert _port_from_address("http://10.84.18.20:443/") == 443
    assert _port_from_address("http://10.84.18.21:8080/") == 8080

    # Bare and malformed forms must not raise or invent a port.
    assert _port_from_address("10.84.18.20") is None
    assert _port_from_address("") is None
    assert _port_from_address(None) is None


def test_multi_camera_device_rows_share_one_hardware_id(tmp_path):
    """One device, one IP, several cameras — recorded as such."""
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "name": "NVR-1", "enabled": True}]
    fake.hardware_data = [{"id": "HW1", "address": "http://10.88.18.190:8080/"}]
    # Two channels of the same physical camera, joined via relations.parent.
    fake.cameras_data = [
        {"id": "C1", "name": "cam ch0", "channel": 0, "enabled": True,
         "relations": {"parent": {"type": "hardware", "id": "HW1"}}},
        {"id": "C2", "name": "cam ch1", "channel": 1, "enabled": True,
         "relations": {"parent": {"type": "hardware", "id": "HW1"}}},
    ]
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO devices (name, site, device_type, enabled, "
                          "milestone_hardware_id) VALUES "
                          "('cam ch0','BHS','camera',1,'C1'),"
                          "('cam ch1','BHS','camera',1,'C2')"))
    asyncio.run(MilestoneCollector(engine, fake, ess_enabled=False).run_once())

    rows = db.fetch_all(engine, "SELECT ip, http_port, hardware_id FROM cameras "
                                "WHERE hardware_id IS NOT NULL")
    assert len(rows) == 2
    assert {r["hardware_id"] for r in rows} == {"HW1"}     # one physical device
    assert {r["ip"] for r in rows} == {"10.88.18.190"}     # host, port stripped
    assert {r["http_port"] for r in rows} == {8080}        # but not lost


def test_ess_communication_maps_to_camera_source_status(tmp_path):
    """Cameras had `source_status = blind` because the Config API has no
    per-camera status field — an honest "cannot tell" that nothing on the
    success path ever cleared, so 2,659 rows sat two days stale behind 2,659
    open alerts. The ESS can tell, so the blind rows become a real verdict.
    """
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "hostName": "nvr-1.tcs", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True},
                         {"id": "CAM2", "recordingEnabled": True}]
    fake.hardware_data = []
    col = MilestoneCollector(engine, fake, ess_enabled=True)

    async def fake_ess():
        # (camera verdicts, recording-server states) — one snapshot serves both
        # since the subscription asks for both resource types (migration 027).
        # Keyed by GUID, as the ESS `source` field supplies it.
        return {"CAM1": ("up", "ok"), "CAM2": ("down", "crit")}, {}
    col._ess_state = fake_ess
    asyncio.run(col.run_once())

    rows = {r["device_id"]: r for r in db.fetch_all(
        engine, "SELECT device_id, value, severity, source FROM device_state "
                "WHERE dimension='source_status'")}
    cams = db.fetch_all(engine, "SELECT id, milestone_hardware_id FROM devices "
                                "WHERE device_type='camera'")
    for c in cams:
        got = rows.get(c["id"])
        if c["milestone_hardware_id"] == "CAM1":
            assert got["value"] == "up" and got["source"] == "milestone-ess"
        elif c["milestone_hardware_id"] == "CAM2":
            assert got["value"] == "down" and got["severity"] == "crit"


def test_ess_failure_degrades_without_failing_the_cycle(tmp_path):
    """The ESS is enrichment. A WebSocket problem must not fail a Config-API
    cycle that otherwise succeeded, and must not downgrade known state to a
    guess — prior rows are left untouched and the degradation is recorded.
    """
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "hostName": "nvr-1.tcs", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True},
                         {"id": "CAM2", "recordingEnabled": True}]
    fake.hardware_data = []
    col = MilestoneCollector(engine, fake, ess_enabled=True)

    async def no_ess():
        return None
    col._ess_state = no_ess
    written = asyncio.run(col.run_once())          # must not raise

    assert written > 0
    snap = read_snapshot(engine, "milestone.overview")
    assert "ess" in (snap["payload"].get("degraded") or [])


def test_recording_state_is_not_derived_from_the_ess(tmp_path):
    """Recording here is motion-triggered, so `RecordingStopped` is the ordinary
    resting state for most cameras most of the time (owner, 2026-09-04).
    Mapping it onto `recording = down` would manufacture an outage out of normal
    operation, so only the Communication group is mapped."""
    from netmon.collectors.milestone import ESS_COMMUNICATION

    assert set(ESS_COMMUNICATION) == {
        "CommunicationStarted", "CommunicationError", "CommunicationStopped"}
    assert not any("Recording" in k or "FPS" in k for k in ESS_COMMUNICATION)


def test_a_single_transport_error_does_not_blind_the_estate(tmp_path):
    """One blip must not erase good state.

    On 2026-09-06 a single transient error on /cameras overwrote ESS-derived
    status for all 2,659 cameras 90 seconds after a clean cycle, and the result
    read as "0 cameras down" — a total recovery, produced by losing the signal.
    CLAUDE.md §4.5 requires a failing collector to record the failure and leave
    prior state visibly stale, never to overwrite it.
    """
    from netmon.collectors.milestone_client import MilestoneError
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "hostName": "nvr-1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    col = MilestoneCollector(engine, fake, ess_enabled=False)
    asyncio.run(col.run_once())                      # good state first

    before = {r["device_id"]: r["value"] for r in db.fetch_all(
        engine, "SELECT device_id, value FROM device_state WHERE dimension='source_status'")}
    assert before, "expected state from the healthy cycle"

    fake.fail = MilestoneError("transient")
    for _ in range(2):                               # below the threshold
        try:
            asyncio.run(col.run_once())
        except MilestoneError:
            pass

    after = {r["device_id"]: r["value"] for r in db.fetch_all(
        engine, "SELECT device_id, value FROM device_state WHERE dimension='source_status'")}
    assert after == before, "prior state must survive a blip, not be blinded"


def test_a_persistent_outage_does_blind(tmp_path):
    """A source that is genuinely gone must not read as healthy — stale rows
    would. Past the threshold, blind is the honest answer."""
    from netmon.collectors.milestone_client import MilestoneError
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "hostName": "nvr-1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    col = MilestoneCollector(engine, fake, ess_enabled=False, blind_after_failures=3)
    asyncio.run(col.run_once())

    fake.fail = MilestoneError("gone")
    for _ in range(3):
        try:
            asyncio.run(col.run_once())
        except MilestoneError:
            pass

    vals = {r["value"] for r in db.fetch_all(
        engine, "SELECT value FROM device_state WHERE dimension='source_status'")}
    assert vals == {"blind"}


def test_the_failure_counter_resets_on_success(tmp_path):
    """Two blips a week apart must not add up to an outage."""
    from netmon.collectors.milestone_client import MilestoneError
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "hostName": "nvr-1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    col = MilestoneCollector(engine, fake, ess_enabled=False, blind_after_failures=3)

    for _ in range(2):
        fake.fail = MilestoneError("blip")
        try:
            asyncio.run(col.run_once())
        except MilestoneError:
            pass
        fake.fail = None
        asyncio.run(col.run_once())

    assert col._consecutive_failures == 0
    vals = {r["value"] for r in db.fetch_all(
        engine, "SELECT value FROM device_state WHERE dimension='source_status'")}
    assert "blind" not in vals


def _cam(cid, hw):
    return {"id": cid, "name": cid, "enabled": True,
            "relations": {"parent": {"type": "hardware", "id": hw}}}


def _identity_engine(tmp_path, cam_ids):
    """Registry with one device per camera GUID, so every camera links."""
    e = db.make_engine(f"sqlite:///{tmp_path / 'id.db'}")
    create_core_tables(e)
    with e.begin() as conn:
        for cid in cam_ids:
            conn.execute(text(
                "INSERT INTO devices (name, site, device_type, enabled, "
                "milestone_hardware_id) VALUES (:n,'S','camera',1,:m)"),
                {"n": cid, "m": cid})
    return e


def test_camera_mac_comes_from_hardware_driver_settings(tmp_path):
    """The MAC is not on /cameras or /hardware — it is one resource deeper.

    NetMon looked on both for months and wrote NULL for all 2,651 cameras while
    the Management Client displayed a MAC for every one of them, because the
    Management Client reads hardwareDriverSettings and NetMon never did.
    """
    e = _identity_engine(tmp_path, ["C1"])
    fake = FakeMs()
    fake.cameras_data = [_cam("C1", "HW1")]
    fake.hardware_data = [{"id": "HW1", "address": "http://192.0.2.60/"}]
    fake.settings_data = {"HW1": {"macAddress": "00075FD83950", "serialNumber": "d83950",
                                  "firmwareVersion": "900", "productID": "Bosch"}}
    asyncio.run(MilestoneCollector(e, fake).run_once())

    row = db.fetch_one(e, "SELECT mac, serial, firmware, vendor FROM cameras")
    assert row["mac"] == "00:07:5f:d8:39:50"      # canonicalised on the way in
    assert row["serial"] == "d83950"
    assert row["firmware"] == "900"
    assert row["vendor"] == "Bosch"


def test_every_camera_on_one_device_shares_its_mac(tmp_path):
    """One hardware, one NIC, one MAC — however many cameras hang off it.

    61 hardware records here carry more than one camera (eleven on one AXIS
    M3007). Fetching per camera would issue eleven identical requests and, if
    the settings were keyed per camera, would leave ten of them NULL.
    """
    e = _identity_engine(tmp_path, ["C1", "C2", "C3"])
    fake = FakeMs()
    fake.cameras_data = [_cam("C1", "HW1"), _cam("C2", "HW1"), _cam("C3", "HW1")]
    fake.hardware_data = [{"id": "HW1", "address": "http://192.0.2.60/"}]
    fake.settings_data = {"HW1": {"macAddress": "00075FD83950"}}
    asyncio.run(MilestoneCollector(e, fake).run_once())

    macs = [r["mac"] for r in db.fetch_all(e, "SELECT mac FROM cameras")]
    assert macs == ["00:07:5f:d8:39:50"] * 3
    # One request for the device, not one per camera.
    assert fake.settings_calls == ["HW1"]


def test_identity_backfill_is_bounded_per_cycle(tmp_path):
    """There is no collection form of hardwareDriverSettings, so this is one
    request per hardware at ~300 ms. Sweeping 2,489 every 120 s cycle would be
    ~12 minutes of gateway traffic every two minutes."""
    ids = [f"C{i}" for i in range(10)]
    e = _identity_engine(tmp_path, ids)
    fake = FakeMs()
    fake.cameras_data = [_cam(c, f"HW{i}") for i, c in enumerate(ids)]
    fake.hardware_data = [{"id": f"HW{i}"} for i in range(10)]
    fake.settings_data = {f"HW{i}": {"macAddress": f"00075FD839{i:02d}"} for i in range(10)}

    col = MilestoneCollector(e, fake, identity_batch=4)
    asyncio.run(col.run_once())
    assert len(fake.settings_calls) == 4
    assert db.fetch_one(e, "SELECT COUNT(*) n FROM cameras WHERE mac IS NOT NULL")["n"] == 4

    # Next cycle picks up where it left off and does not re-fetch what is known.
    fake.settings_calls.clear()
    asyncio.run(col.run_once())
    assert len(fake.settings_calls) == 4
    assert db.fetch_one(e, "SELECT COUNT(*) n FROM cameras WHERE mac IS NOT NULL")["n"] == 8


def test_known_macs_survive_a_cycle_that_does_not_refetch_them(tmp_path):
    """`replace_rows` rewrites the whole camera row, so a MAC that is not
    re-supplied would be silently blanked. The backfill reads what is already
    stored before deciding what to fetch, which is what keeps it stable."""
    e = _identity_engine(tmp_path, ["C1"])
    fake = FakeMs()
    fake.cameras_data = [_cam("C1", "HW1")]
    fake.hardware_data = [{"id": "HW1"}]
    fake.settings_data = {"HW1": {"macAddress": "00075FD83950", "firmwareVersion": "900"}}
    col = MilestoneCollector(e, fake)
    asyncio.run(col.run_once())

    fake.settings_calls.clear()
    asyncio.run(col.run_once())
    assert fake.settings_calls == []                      # nothing left to fetch
    row = db.fetch_one(e, "SELECT mac, firmware FROM cameras")
    assert row["mac"] == "00:07:5f:d8:39:50"              # and it is still there
    assert row["firmware"] == "900"


def test_identity_backfill_failure_is_soft_and_reported(tmp_path):
    """A camera whose hardware could not be read keeps NULL rather than losing
    the cycle — but the overview must say the enrichment degraded, or a stalled
    backfill looks exactly like a finished one (§4.5)."""
    e = _identity_engine(tmp_path, ["C1"])
    fake = FakeMs()
    fake.cameras_data = [_cam("C1", "HW1")]
    fake.hardware_data = [{"id": "HW1"}]
    fake.settings_fail = MilestoneError("boom")
    asyncio.run(MilestoneCollector(e, fake).run_once())

    assert db.fetch_one(e, "SELECT mac FROM cameras")["mac"] is None
    overview = read_snapshot(e, "milestone.overview")["payload"]
    assert "identity" in overview["degraded"]


def test_identity_backfill_can_be_disabled(tmp_path):
    """Per-step reversibility (§4.3): the batch size is the off switch, and
    turning it off must not disturb the rest of the cycle."""
    e = _identity_engine(tmp_path, ["C1"])
    fake = FakeMs()
    fake.cameras_data = [_cam("C1", "HW1")]
    fake.hardware_data = [{"id": "HW1", "address": "http://192.0.2.60/"}]
    fake.settings_data = {"HW1": {"macAddress": "00075FD83950"}}
    asyncio.run(MilestoneCollector(e, fake, identity_batch=0).run_once())

    assert fake.settings_calls == []
    row = db.fetch_one(e, "SELECT mac, ip FROM cameras")
    assert row["mac"] is None
    assert row["ip"] == "192.0.2.60"     # the rest of the cycle is unaffected


def test_transport_error_names_a_cause():
    """An error whose message is empty tells an operator nothing.

    httpx timeout exceptions stringify to "", so interpolating the exception
    alone wrote `MilestoneError('Milestone transport error on
    /api/rest/v1/cameras: ')` into collector_health — no cause, no next step.
    The exception class is the diagnosis: ReadTimeout means the gateway was
    slow, ConnectError means it was not there, and those need different
    responses (§4.5).
    """
    import httpx
    import pytest

    from netmon.collectors.milestone_client import MilestoneClient

    client = MilestoneClient(host="ms.invalid", user="u", password="p")
    client._token = "t"

    class Boom:
        async def get(self, path, headers=None):
            raise httpx.ReadTimeout("")          # exactly what the gateway raises

    with pytest.raises(MilestoneError) as err:
        asyncio.run(client._get(Boom(), "/api/rest/v1/cameras"))
    msg = str(err.value)
    assert "ReadTimeout" in msg, f"the cause must survive into the message: {msg}"
    assert "/api/rest/v1/cameras" in msg
    assert not msg.rstrip().endswith(":"), "message must not trail off with no detail"


def test_bulk_endpoints_get_a_longer_timeout_than_the_default():
    """/cameras and /hardware are multi-megabyte responses whose latency is
    variable; the 30s default cost roughly one Milestone cycle in four. Both
    stay under the collector's 120s supervisor boundary so a genuine hang is
    still caught rather than waited out."""
    from netmon.collectors.milestone_client import BULK_TIMEOUT, HARDWARE_TIMEOUT, TIMEOUT

    assert BULK_TIMEOUT > TIMEOUT
    assert BULK_TIMEOUT < 120.0
    assert HARDWARE_TIMEOUT > TIMEOUT


def test_flatten_camera_groups_flat_and_nested():
    """The group walk, against both shapes the API uses.

    2025 R2 returns children inline (`node["cameras"]`); the documented shape
    nests them under `node["children"]`. Reading only one is how the reference
    collector ended up with every camera under a single label on some installs.
    """
    from netmon.collectors.milestone import flatten_camera_groups

    now = datetime(2026, 9, 7, 12, 0, tzinfo=timezone.utc)
    reg = {"cam-1": {"id": 11}, "cam-2": {"id": 12}, "cam-3": {"id": 13}}
    roots = [
        # Inline children, the live shape.
        {"id": "g-bhs", "displayName": "BHS",
         "cameras": [{"id": "cam-1"}, {"id": "cam-2"}, {"id": "not-imported"}]},
        # Nested children plus a subgroup, the documented shape.
        {"id": "g-co", "displayName": "CO",
         "children": {"cameras": [{"id": "cam-3"}],
                      "cameraGroups": [{"id": "g-co-a", "displayName": "Annex",
                                        "cameras": [{"id": "cam-1"}]}]}},
        # Empty group — three exist on the live estate and must survive.
        {"id": "g-nes", "displayName": "NES", "cameras": []},
    ]
    groups, members = flatten_camera_groups(roots, reg, now)

    by = {g["id"]: g for g in groups}
    assert set(by) == {"g-bhs", "g-co", "g-co-a", "g-nes"}
    # camera_count is what Milestone reports, including the camera the registry
    # has never imported — the gap is a real finding, not something to hide.
    assert by["g-bhs"]["camera_count"] == 3
    assert by["g-nes"]["camera_count"] == 0
    # Nesting: parent and slash-separated lineage.
    assert by["g-co-a"]["parent_id"] == "g-co"
    assert by["g-co-a"]["path"] == "CO/Annex"
    assert by["g-bhs"]["path"] == "BHS"

    # Membership only covers registry-linked cameras, and a camera in two
    # groups keeps both memberships.
    pairs = {(m["group_id"], m["device_id"]) for m in members}
    assert pairs == {("g-bhs", 11), ("g-bhs", 12), ("g-co", 13), ("g-co-a", 11)}
    assert len(members) == len(pairs)  # no duplicate rows


def test_flatten_camera_groups_ignores_junk():
    """Malformed payloads must not produce rows the DB will reject."""
    from netmon.collectors.milestone import flatten_camera_groups

    now = datetime(2026, 9, 7, 12, 0, tzinfo=timezone.utc)
    roots = [
        None,                                   # not a dict
        {"displayName": "no id"},               # unusable without an id
        {"id": "g", "displayName": "G",
         "cameras": [None, "string", {"no": "id"}, {"id": "cam-1"}, {"id": "cam-1"}]},
    ]
    groups, members = flatten_camera_groups(roots, {"cam-1": {"id": 5}}, now)
    assert [g["id"] for g in groups] == ["g"]
    # The duplicate camera appears once: the PK is (group_id, device_id).
    assert members == [{"group_id": "g", "device_id": 5, "updated_at": now}]


def test_group_walk_failure_costs_only_the_tree(tmp_path):
    """A failed cameraGroups walk must not take the inventory with it.

    The walk is one more request against the same gateway. Placed before the
    camera writes it would, on failure, skip them entirely — a navigation aid
    taking the estate's inventory down with it. It must also never write an
    empty tree, because replace_rows prunes what it does not see and that would
    delete the last good one (§4.5).
    """
    e = _engine(tmp_path)
    ms = FakeMs()
    ms.servers = [{"id": "RS1", "running": True}]
    ms.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    ms.groups_data = [{"id": "g", "displayName": "BHS", "cameras": [{"id": "CAM1"}]}]
    c = MilestoneCollector(e, ms)

    asyncio.run(c.run_once())
    assert db.fetch_one(e, "SELECT COUNT(*) n FROM camera_groups")["n"] == 1
    assert db.fetch_one(e, "SELECT COUNT(*) n FROM cameras")["n"] == 1

    # Now the walk fails. Cameras still refresh; the tree survives as-is.
    ms.groups_fail = MilestoneError("cameraGroups HTTP 500")
    asyncio.run(c.run_once())
    assert db.fetch_one(e, "SELECT COUNT(*) n FROM camera_groups")["n"] == 1
    assert db.fetch_one(e, "SELECT COUNT(*) n FROM camera_group_members")["n"] == 1
    assert db.fetch_one(e, "SELECT COUNT(*) n FROM cameras")["n"] == 1
    # And the degradation is reported rather than silent.
    ov = read_snapshot(e, "milestone.overview")
    assert "groups" in (ov["payload"]["degraded"] or [])


def test_group_membership_prunes_on_refresh(tmp_path):
    """Replace-on-refresh: a camera moved out of a group loses the membership."""
    e = _engine(tmp_path)
    ms = FakeMs()
    ms.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    ms.groups_data = [{"id": "g1", "displayName": "BHS", "cameras": [{"id": "CAM1"}]},
                      {"id": "g2", "displayName": "SKY", "cameras": [{"id": "CAM1"}]}]
    c = MilestoneCollector(e, ms)
    asyncio.run(c.run_once())
    assert db.fetch_one(e, "SELECT COUNT(*) n FROM camera_group_members")["n"] == 2

    # Re-filed under one group only.
    ms.groups_data = [{"id": "g1", "displayName": "BHS", "cameras": [{"id": "CAM1"}]},
                      {"id": "g2", "displayName": "SKY", "cameras": []}]
    asyncio.run(c.run_once())
    rows = db.fetch_all(e, "SELECT group_id FROM camera_group_members")
    assert [r["group_id"] for r in rows] == ["g1"]


def test_ess_recording_server_states_land_on_the_row(tmp_path):
    """Recording-server verdicts from the Events/State interface (migration 027).

    The subscription only ever asked for `resourceTypes: ["cameras"]`, so these
    were never delivered and RS status came from the Config API's `running`
    flag. Communication now drives source_status; the other three are
    descriptive columns and must NOT become severities here — half this estate
    reads "Service Available Critical" with a months-old timestamp.
    """
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "hostName": "nvr-1.tcs", "running": False}]
    fake.cameras_data = []
    col = MilestoneCollector(engine, fake, ess_enabled=True)

    async def fake_ess():
        return {}, {"RS1": {"comm_state": "Communication Started",
                            "cpu_state": "CPU Usage Normal",
                            "retention_state": "Retention time Warning",
                            "service_state": "Service Available Critical",
                            "states_at": "2026-04-24T07:13:31Z"}}
    col._ess_state = fake_ess
    asyncio.run(col.run_once())

    row = db.fetch_one(engine, "SELECT comm_state, cpu_state, retention_state, "
                               "service_state FROM recording_servers")
    assert row["comm_state"] == "Communication Started"
    assert row["retention_state"] == "Retention time Warning"
    assert row["service_state"] == "Service Available Critical"

    # Communication wins over the Config API flag: `running` was False, yet the
    # ESS says the VMS is talking to it, and the ESS is the live view.
    st = db.fetch_one(engine, "SELECT value, severity, source FROM device_state "
                              "WHERE dimension='source_status'")
    assert st["value"] == "up" and st["source"] == "milestone-ess"

    # And the Critical service state did NOT become a crit anywhere.
    assert db.fetch_one(
        engine, "SELECT COUNT(*) n FROM device_state WHERE severity='crit'")["n"] == 0


def test_recording_server_falls_back_to_the_config_flag_without_the_ess(tmp_path):
    """No ESS → the Config API flag still decides, and the state columns stay
    NULL rather than being guessed. A NULL renders "—"; a guess renders a claim.
    """
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "hostName": "nvr-1.tcs", "running": False}]
    fake.cameras_data = []
    col = MilestoneCollector(engine, fake, ess_enabled=False)
    asyncio.run(col.run_once())

    st = db.fetch_one(engine, "SELECT value, source FROM device_state "
                              "WHERE dimension='source_status'")
    assert st["value"] == "down" and st["source"] == "milestone"
    row = db.fetch_one(engine, "SELECT comm_state, service_state FROM recording_servers")
    assert row["comm_state"] is None and row["service_state"] is None


def test_environment_facts_reach_the_overview(tmp_path):
    """Management server, version and device licences (spec 20 S2).

    There is no licence *total* in either licence response — Professional+ is
    licensed per activated device — so the snapshot carries what exists and
    nothing derived from a total that does not.
    """
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = []
    fake.cameras_data = []
    fake.site_data = {"displayName": "CO-MILESTONE", "version": "25.2.0.1",
                      "timeZone": "Central Standard Time"}
    fake.license_data = [{"licenseType": "Device License", "displayName": "Device License",
                          "activated": "2491", "notLicensed": "0", "inGrace": 0}]
    col = MilestoneCollector(engine, fake)
    asyncio.run(col.run_once())

    p = read_snapshot(engine, "milestone.overview")["payload"]
    assert p["management_server"] == "CO-MILESTONE"
    assert p["version"] == "25.2.0.1"
    # `activated` arrives as a string and must be coerced, or the UI formats
    # "2491" as a string and any comparison against it is a string comparison.
    assert p["license_activated"] == 2491
    assert p["license_not_licensed"] == 0
    assert "license_total" not in p


def test_environment_facts_fail_soft_and_say_so(tmp_path):
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = []
    fake.cameras_data = []
    fake.site_fail = MilestoneError("sites HTTP 404")
    fake.license_fail = MilestoneError("licenseDetails HTTP 404")
    col = MilestoneCollector(engine, fake)
    asyncio.run(col.run_once())

    p = read_snapshot(engine, "milestone.overview")["payload"]
    assert p["management_server"] is None and p["version"] is None
    # Both degradations are named, so a missing version is visibly missing
    # rather than looking like a version nobody set.
    assert "site" in p["degraded"] and "license" in p["degraded"]


def test_camera_channel_and_tls_fields(tmp_path):
    """The two fields D7's snapshot proxy needs (migration 027).

    `httpSEnabled` is the STRING 'Yes'/'No'. A truthiness test on the raw value
    marks every camera TLS-enabled, and the proxy then talks https to a camera
    serving http — the correction spec 11 D7 recorded.
    """
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = []
    fake.cameras_data = [{"id": "CAM1", "channel": 3, "recordingEnabled": True,
                          "relations": {"parent": {"type": "hardware", "id": "HW1"}}}]
    fake.hardware_data = [{"id": "HW1", "address": "http://10.1.2.3/"}]
    fake.settings_data = {"HW1": {"httpSEnabled": "Yes", "httpSPort": 443,
                                  "macAddress": "00:11:22:33:44:55"}}
    with engine.begin() as conn:
        conn.execute(text("UPDATE devices SET milestone_hardware_id='CAM1' "
                          "WHERE device_type='camera'"))
    col = MilestoneCollector(engine, fake)
    asyncio.run(col.run_once())

    row = db.fetch_one(engine, "SELECT channel, https_enabled, https_port, ip "
                               "FROM cameras")
    assert row["channel"] == 3
    assert row["https_enabled"] == 1          # 'Yes' → 1, not a truthy string
    assert row["https_port"] == 443
    assert row["ip"] == "10.1.2.3"


def test_https_enabled_no_is_zero_not_none(tmp_path):
    """'No' must be 0, and anything unrecognised None — "we were not told" has
    to stay distinct from "no", because the proxy picks a scheme from it."""
    from netmon.collectors.milestone import _yes_no
    assert _yes_no("Yes") == 1 and _yes_no("yes") == 1 and _yes_no(True) == 1
    assert _yes_no("No") == 0 and _yes_no(False) == 0
    assert _yes_no("") is None and _yes_no(None) is None and _yes_no("maybe") is None


def test_ess_timestamp_parsing_and_comm_naming():
    """Two live traps, both of which cost a whole table on first contact.

    Milestone emits seven fractional digits and a trailing Z, which
    `fromisoformat` rejects and MariaDB rejects harder — the unparsed string
    failed the entire recording_servers upsert with "Incorrect datetime value".
    And Milestone is inconsistent with its own state names: recorders report
    `CommunicationStarted` (no space) beside `CPU Usage Normal` (spaces), so
    matching the spaced form marked all 22 recorders down.
    """
    from netmon.collectors.milestone import _ess_time, ESS_RS_COLUMNS

    ts = _ess_time("2026-08-15T04:32:51.5226035Z")
    assert ts is not None and ts.year == 2026 and ts.microsecond == 522603
    assert ts.tzinfo is not None
    assert _ess_time("2026-01-01T00:00:00Z") is not None
    assert _ess_time("") is None and _ess_time(None) is None and _ess_time("junk") is None

    # Both spellings must be recognised as the Communication group…
    for name in ("CommunicationStarted", "Communication Started"):
        assert any(name.startswith(prefix) for prefix, _ in ESS_RS_COLUMNS)
    # …and both must read as "up" under the collector's normalised test.
    for name in ("CommunicationStarted", "Communication Started"):
        assert "started" in name.replace(" ", "").lower()
    for name in ("CommunicationStopped", "Communication Error"):
        assert "started" not in name.replace(" ", "").lower()


def test_stored_identity_is_never_blanked_by_an_unasked_hardware(tmp_path):
    """The regression the identity marker caused, pinned.

    `replace_rows` rewrites the whole camera row, so every cycle has to
    re-supply what is already stored. Gating the read-back on the *marker*
    rather than on "has anything stored" meant a freshly-added marker column —
    NULL for the whole estate — made the collector supply nothing, and 2,496
    MACs were wiped on the live database until the backfill came round again.

    Two questions, two answers: what is stored (supply it) and what has been
    asked (skip it).
    """
    e = _identity_engine(tmp_path, ["C1", "C2"])
    fake = FakeMs()
    fake.cameras_data = [_cam("C1", "HW1"), _cam("C2", "HW2")]
    fake.hardware_data = [{"id": "HW1"}, {"id": "HW2"}]
    fake.settings_data = {"HW1": {"macAddress": "00075FD83950"},
                          "HW2": {"macAddress": "00075FD83951"}}
    # One hardware per cycle, so the second is always "not this batch".
    col = MilestoneCollector(e, fake, identity_batch=1)
    asyncio.run(col.run_once())
    first = {r["mac"] for r in db.fetch_all(e, "SELECT mac FROM cameras WHERE mac IS NOT NULL")}
    assert len(first) == 1

    # Simulate the migration's effect on rows already carrying identity: the
    # marker is cleared, the MAC is not. The next cycle must keep the MAC.
    with e.begin() as conn:
        conn.execute(text("UPDATE cameras SET identity_at = NULL"))
    asyncio.run(col.run_once())
    macs = {r["mac"] for r in db.fetch_all(e, "SELECT mac FROM cameras WHERE mac IS NOT NULL")}
    assert first.issubset(macs), "a stored MAC was blanked by a cycle that did not refetch it"


def test_hardware_that_reports_nothing_is_asked_once(tmp_path):
    """A record with no MAC has nothing to store but has still been asked.

    Keyed on the MAC, such a hardware never became "known" and was re-fetched
    every cycle forever — one wasted request per cycle per record, invisible
    because it looked like ordinary backfill traffic.
    """
    e = _identity_engine(tmp_path, ["C1"])
    fake = FakeMs()
    fake.cameras_data = [_cam("C1", "HW1")]
    fake.hardware_data = [{"id": "HW1"}]
    fake.settings_data = {"HW1": {}}          # answers, but carries nothing
    col = MilestoneCollector(e, fake)
    asyncio.run(col.run_once())
    assert fake.settings_calls == ["HW1"]

    fake.settings_calls.clear()
    asyncio.run(col.run_once())
    assert fake.settings_calls == [], "a hardware with no MAC was asked twice"


def test_camera_links_to_its_recorder_through_the_hardware(tmp_path):
    """The camera→recorder link is two hops, and it was never made.

    `/cameras` carries no recording-server reference — the chain is camera →
    relations.parent (hardware) → hardware's relations.parent
    (recordingServers). The old code looked for a `recordingServerId` on the
    camera, found nothing, and left `recording_server_device_id` NULL for all
    2,651 cameras: the detail page showed "—" for the recorder and per-recorder
    camera counts could not be computed at all.
    """
    e = db.make_engine(f"sqlite:///{tmp_path / 'link.db'}")
    create_core_tables(e)
    with e.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, enabled, milestone_hardware_id) "
            "VALUES ('NVR-1','S','recording_server',1,'RS1'),"
            "       ('CAM-1','S','camera',1,'CAM1')"))
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "hostName": "nvr-1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True,
                          "relations": {"parent": {"type": "hardware", "id": "HW1"}}}]
    fake.hardware_data = [{"id": "HW1", "address": "http://10.0.0.5/",
                           "relations": {"parent": {"type": "recordingServers", "id": "RS1"}}}]
    asyncio.run(MilestoneCollector(e, fake).run_once())

    rs_devid = db.fetch_one(e, "SELECT id FROM devices WHERE device_type='recording_server'")["id"]
    assert db.fetch_one(e, "SELECT recording_server_device_id FROM cameras"
                        )["recording_server_device_id"] == rs_devid


def test_relation_id_checks_the_type(tmp_path):
    """A parent of the wrong type must not be mistaken for the right one."""
    from netmon.collectors.milestone import _relation_id
    hw = {"relations": {"parent": {"type": "recordingServers", "id": "RS9"},
                        "self": {"type": "hardware", "id": "HW9"}}}
    assert _relation_id(hw, "recordingServers") == "RS9"
    assert _relation_id(hw, "hardware") == ""          # self is not parent
    assert _relation_id({}, "recordingServers") == ""
    assert _relation_id({"relations": None}, "recordingServers") == ""


def test_a_slow_bulk_endpoint_does_not_blind_the_estate(tmp_path):
    """Blinding needs evidence that the *source* is gone, not that one endpoint
    was slow.

    /cameras is 2.9 MB and its latency swings from 5s to 19s, so three timeouts
    in a row says little about the VMS. Blinding on it manufactured an
    estate-wide outage about eleven times a day — 940 cameras at a time, ~19,000
    state events daily — and each episode is the storm spec 19 §12 fixed once
    already. If the cheap /sites call answers, the source is reachable and the
    honest state is the previous one, left visibly stale.
    """
    e = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    col = MilestoneCollector(e, fake, blind_after_failures=2)
    asyncio.run(col.run_once())
    assert _state(e, "source_status")           # a real verdict exists

    # The bulk endpoint starts failing, but the gateway still answers /sites.
    fake.fail = MilestoneError("Milestone ReadTimeout on /api/rest/v1/cameras")
    fake.site_data = {"displayName": "CO-MILESTONE", "version": "25.2.0.1"}
    for _ in range(4):
        with pytest.raises(MilestoneError):
            asyncio.run(col.run_once())
    blind = db.fetch_one(e, "SELECT COUNT(*) n FROM device_state "
                            "WHERE dimension='source_status' AND value='blind'")["n"]
    assert blind == 0, "a slow endpoint blinded the estate"


def test_a_genuinely_unreachable_gateway_still_blinds(tmp_path):
    """The protection that must survive: when nothing answers, stale rows would
    read as healthy, so blind is the truth (§4.5)."""
    e = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    col = MilestoneCollector(e, fake, blind_after_failures=2)
    asyncio.run(col.run_once())

    fake.fail = MilestoneError("Milestone ConnectError on /api/rest/v1/cameras")
    fake.site_fail = MilestoneError("Milestone ConnectError on /api/rest/v1/sites")
    for _ in range(2):
        with pytest.raises(MilestoneError):
            asyncio.run(col.run_once())
    blind = db.fetch_one(e, "SELECT COUNT(*) n FROM device_state "
                            "WHERE dimension='source_status' AND value='blind'")["n"]
    assert blind > 0, "an unreachable gateway must still blind — stale must not read healthy"


def test_supervisor_timeout_has_headroom_over_the_interval():
    """A healthy cycle must not be killed by contention.

    The cycle's own work is ~20s, but this collector shares a host with the
    SNMP inventory sweep (156s), so an overlapping-but-healthy Milestone cycle
    measures ~110s. With the boundary tied to the 120s interval those cycles
    were cancelled, and three cancellations in a row blinded 940 cameras.
    """
    e = None
    col = MilestoneCollector(e, FakeMs(), interval_s=120.0)
    assert col.timeout_s >= 300.0
    assert col.timeout_s > col.interval_s * 2, "no headroom over the interval"
    # A long interval still scales rather than being capped at the floor.
    assert MilestoneCollector(e, FakeMs(), interval_s=600.0).timeout_s == 1500.0


def test_a_stale_echo_cannot_undo_a_verified_flash(tmp_path):
    """The 2026-09-09 bug: 50 flashed cameras kept their pre-flash version.

    `replace_rows` rewrites the whole camera row from identity captured at the
    start of the cycle, so echoing `firmware` back silently reverted anything
    `cameras.runner` had recorded in between. Firmware is now written only when
    Milestone was actually just asked, so a value NetMon learned from the
    camera itself survives.
    """
    e = _identity_engine(tmp_path, ["C1"])
    fake = FakeMs()
    fake.cameras_data = [_cam("C1", "HW1")]
    fake.hardware_data = [{"id": "HW1"}]
    fake.settings_data = {"HW1": {"macAddress": "00075FD83950",
                                  "firmwareVersion": "7.10.0074"}}
    col = MilestoneCollector(e, fake)
    asyncio.run(col.run_once())
    assert db.fetch_one(e, "SELECT firmware FROM cameras")["firmware"] == "7.10.0074"

    # A flash happens: the camera reported the new version and the runner
    # recorded it. Milestone still believes the old one.
    from netmon.cameras.runner import record_observed_firmware
    device_id = db.fetch_one(e, "SELECT device_id FROM cameras")["device_id"]
    record_observed_firmware(e, int(device_id), "7.93.0024")

    fake.settings_calls.clear()
    asyncio.run(col.run_once())
    assert fake.settings_calls == []          # nothing re-asked, so nothing to write
    assert db.fetch_one(e, "SELECT firmware FROM cameras")["firmware"] == "7.93.0024"
    # And the MAC is still intact — the fix must not blank the other fields.
    assert db.fetch_one(e, "SELECT mac FROM cameras")["mac"] == "00:07:5f:d8:39:50"


def test_a_replaced_device_still_learns_its_firmware(tmp_path):
    """Fresh hardware must still get firmware from Milestone.

    Gating the write on "asked this cycle" must not mean "never written".
    """
    e = _identity_engine(tmp_path, ["C1"])
    fake = FakeMs()
    fake.cameras_data = [_cam("C1", "HW1")]
    fake.hardware_data = [{"id": "HW1"}]
    fake.settings_data = {"HW1": {"firmwareVersion": "8.00.0001"}}
    asyncio.run(MilestoneCollector(e, fake).run_once())
    assert db.fetch_one(e, "SELECT firmware FROM cameras")["firmware"] == "8.00.0001"


# ── the one write: UpdateHardware (owner sign-off 2026-09-09) ──────────────

HW_GUID = "d6b460a4-2f7e-46f1-a3e8-e29110c679cd"
RS_GUID = "224a7d09-f9c0-44c8-9153-9b56d1eb9262"


def _mock_client(handler):
    """A MilestoneClient whose transport is a fake, with auth pre-satisfied."""
    import httpx

    from netmon.collectors.milestone_client import MilestoneClient

    class Mocked(MilestoneClient):
        async def _mkclient(self):
            return httpx.AsyncClient(base_url="https://ms.example.org",
                                     transport=httpx.MockTransport(handler))

        async def bearer_token(self):
            return "tok"

    c = Mocked("ms.example.org", "u", "p")
    c._token = "tok"
    return c


def test_update_hardware_posts_the_task_under_the_owning_recording_server():
    """Path shape verified live: /api/rest/v1 prefix, `hardware` singular,
    nested under the parent recordingServer, task named UpdateHardware."""
    import httpx

    seen = []

    def handler(request):
        seen.append((request.method, request.url.path))
        if request.method == "GET":
            return httpx.Response(200, json={"data": {
                "id": HW_GUID,
                "relations": {"parent": {"type": "recordingServers", "id": RS_GUID}}}})
        return httpx.Response(200, json={})

    client = _mock_client(handler)
    code, _ = asyncio.run(client.update_hardware(HW_GUID))
    assert code == 200
    assert seen == [
        ("GET", f"/api/rest/v1/hardware/{HW_GUID}"),
        ("POST", f"/api/rest/v1/recordingServers/{RS_GUID}/hardware/{HW_GUID}"
                 "/tasks/UpdateHardware"),
    ]


def test_update_hardware_refuses_anything_that_is_not_a_guid():
    """The id goes into a URL path on the *write* side."""
    from netmon.collectors.milestone_client import MilestoneError

    client = _mock_client(lambda r: None)
    for bad in ("", "not-a-guid", "../../cameras", f"{HW_GUID}/../x"):
        with pytest.raises(MilestoneError, match="hardware GUID"):
            asyncio.run(client.update_hardware(bad))


def test_update_hardware_refuses_when_the_parent_is_missing():
    """Without a recordingServer there is nowhere to post the task."""
    import httpx

    from netmon.collectors.milestone_client import MilestoneError

    def handler(request):
        return httpx.Response(200, json={"data": {"id": HW_GUID, "relations": {}}})

    with pytest.raises(MilestoneError, match="no recordingServers parent"):
        asyncio.run(_mock_client(handler).update_hardware(HW_GUID))


def test_update_hardware_returns_the_status_rather_than_raising():
    """The caller audits the outcome; a 500 is data, not an exception."""
    import httpx

    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"data": {
                "id": HW_GUID,
                "relations": {"parent": {"type": "recordingServers", "id": RS_GUID}}}})
        return httpx.Response(500, text="boom")

    code, body = asyncio.run(_mock_client(handler).update_hardware(HW_GUID))
    assert code == 500 and "boom" in body


def test_update_hardware_is_the_only_non_get_in_the_client():
    """Read-only-first stays structural (CLAUDE.md §4.1).

    The token POST and this one write are the whole list. A new verb appearing
    here means a write to the VMS that nobody signed off.
    """
    import ast
    import inspect

    from netmon.collectors import milestone_client as mc

    tree = ast.parse(inspect.getsource(mc))
    posts = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            for inner in ast.walk(node):
                if (isinstance(inner, ast.Call) and isinstance(inner.func, ast.Attribute)
                        and inner.func.attr in ("post", "put", "patch", "delete")):
                    posts.append((node.name, inner.func.attr))
    assert sorted(posts) == [("_get_token", "post"), ("update_hardware", "post")], posts
