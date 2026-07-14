import asyncio
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from netmon import db
from netmon.collectors.rconfig import RConfigCollector, _last_backup, _parse_ts
from netmon.collectors.rconfig_client import RConfigError
from tests.conftest import create_core_tables


class FakeRc:
    def __init__(self):
        self.devices_data = []
        self.fail = None

    async def devices(self):
        if self.fail:
            raise self.fail
        return self.devices_data


def test_parse_ts_and_last_backup():
    assert _parse_ts(None) is None
    assert _parse_ts("2026-07-01T00:00:00Z").year == 2026
    assert _parse_ts(1_700_000_000).tzinfo is not None
    assert _last_backup({"last_success": "2026-07-01T00:00:00Z"}) is not None
    assert _last_backup({"nothing": 1}) is None


def _engine(tmp_path):
    e = db.make_engine(f"sqlite:///{tmp_path / 'rc.db'}")
    create_core_tables(e)
    with e.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, device_type, enabled, rconfig_device_id) "
            "VALUES ('SW-Fresh','switch',1,'1'),('SW-Stale','switch',1,'2'),('SW-Unknown','switch',1,'3')"
        ))
    return e


def _cb_state(engine):
    return {r["rconfig_device_id"]: r for r in db.fetch_all(
        engine,
        "SELECT d.rconfig_device_id, s.value, s.severity FROM devices d "
        "JOIN device_state s ON s.device_id = d.id AND s.dimension='config_backup'")}


def test_rconfig_freshness(tmp_path):
    engine = _engine(tmp_path)
    now = datetime.now(timezone.utc)
    fake = FakeRc()
    fake.devices_data = [
        {"id": 1, "last_backup": (now - timedelta(days=1)).isoformat()},   # fresh
        {"id": 2, "last_backup": (now - timedelta(days=30)).isoformat()},  # stale
        {"id": 3},                                                          # unknown
    ]
    n = asyncio.run(RConfigCollector(engine, fake, stale_after_s=604800).run_once())
    assert n == 3
    st = _cb_state(engine)
    assert st["1"]["value"] == "fresh" and st["1"]["severity"] == "ok"
    assert st["2"]["value"] == "stale" and st["2"]["severity"] == "warn"
    assert st["3"]["value"] == "unknown" and st["3"]["severity"] == "unknown"


def test_rconfig_blind_on_unreachable(tmp_path):
    engine = _engine(tmp_path)
    fake = FakeRc()
    fake.devices_data = [{"id": 1, "last_backup": datetime.now(timezone.utc).isoformat()}]
    coll = RConfigCollector(engine, fake)
    asyncio.run(coll.run_once())
    fake.fail = RConfigError("rconfig down")
    asyncio.run(coll.run_guarded())
    st = _cb_state(engine)
    assert st["1"]["value"] == "blind"
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='rconfig'")
    assert h["consecutive_failures"] == 1
