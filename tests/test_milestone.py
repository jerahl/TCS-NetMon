import asyncio

from sqlalchemy import text

from netmon import db
from netmon.collectors.milestone import MilestoneCollector
from netmon.collectors.milestone_client import MilestoneError
from tests.conftest import create_core_tables


class FakeMs:
    def __init__(self):
        self.servers = []
        self.cameras_data = []
        self.storage_data = []
        self.hardware_data = []
        self.fail = None
        self.storage_fail = None

    async def recording_servers(self):
        if self.fail:
            raise self.fail
        return self.servers

    async def cameras(self):
        if self.fail:
            raise self.fail
        return self.cameras_data

    async def storage(self):
        if self.storage_fail:
            raise self.storage_fail
        return self.storage_data

    async def hardware(self):
        return self.hardware_data


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
    ms = MilestoneCollector(engine, fake)
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
    ms = MilestoneCollector(engine, fake)
    asyncio.run(ms.run_once())

    fake.fail = MilestoneError("gateway down")
    asyncio.run(ms.run_guarded())

    src = _state(engine, "source_status")
    # Every tracked Milestone device goes blind (source unreachable), not left fresh.
    assert src["RS1"]["value"] == "blind"
    assert src["CAM1"]["value"] == "blind"
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='milestone'")
    assert h["consecutive_failures"] == 1


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
    fake.storage_data = [{"recordingServerId": "RS1", "used": 4200, "size": 8000, "retentionDays": 30}]
    n = asyncio.run(MilestoneCollector(engine, fake).run_once())
    assert n >= 4  # 2 state + 1 rs row + 1 cam row

    rs = db.fetch_one(engine, "SELECT * FROM recording_servers WHERE device_id=1")
    assert rs["hostname"] == "nvr-1.tcs" and rs["chans_total"] == 40
    assert rs["storage_total_gb"] == 8000 and rs["retention_days"] == 30

    cam = db.fetch_one(engine, "SELECT * FROM cameras WHERE device_id=2")
    assert cam["model"] == "AXIS P3255" and cam["fps_target"] == 15
    assert cam["mac"] == "00:40:8c:aa:bb:cc"        # FDB join key, canonicalized
    assert cam["recording_server_device_id"] == 1   # linked to the RS device

    ov = read_snapshot(engine, "milestone.overview")
    assert ov["ok"] and ov["payload"]["cameras"] == 1 and ov["payload"]["recording_servers"] == 1


def test_milestone_storage_endpoint_fail_soft(tmp_path):
    from netmon.collectors.milestone_client import MilestoneError
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    fake.storage_fail = MilestoneError("Milestone HTTP 404 on /storages")
    # The whole cycle still succeeds; RS row just has NULL storage.
    asyncio.run(MilestoneCollector(engine, fake).run_once())
    rs = db.fetch_one(engine, "SELECT * FROM recording_servers WHERE device_id=1")
    assert rs is not None and rs["storage_total_gb"] is None


def test_milestone_unreachable_keeps_inventory_stale(tmp_path):
    from netmon.collectors.milestone_client import MilestoneError
    engine = _engine(tmp_path)
    fake = FakeMs()
    fake.servers = [{"id": "RS1", "running": True}]
    fake.cameras_data = [{"id": "CAM1", "recordingEnabled": True}]
    asyncio.run(MilestoneCollector(engine, fake).run_once())

    fake.fail = MilestoneError("unreachable")
    asyncio.run(MilestoneCollector(engine, fake).run_guarded())
    # Rows kept (stale), never blanked on a failed refresh.
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM cameras")["n"] == 1
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='milestone'")
    assert h["consecutive_failures"] == 1
