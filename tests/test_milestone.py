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
        self.fail = None

    async def recording_servers(self):
        if self.fail:
            raise self.fail
        return self.servers

    async def cameras(self):
        if self.fail:
            raise self.fail
        return self.cameras_data


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
    assert n == 2

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
