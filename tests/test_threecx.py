import asyncio

from sqlalchemy import text

from netmon import db
from netmon.collectors.threecx import ThreeCxCollector
from netmon.collectors.threecx_client import ThreeCxError
from tests.conftest import create_core_tables


class FakeTcx:
    def __init__(self):
        self.trunks_data = []
        self.extensions_data = []
        self.system_data = {}
        self.fail = None
        self.ext_fail = None

    async def trunks(self):
        if self.fail:
            raise self.fail
        return self.trunks_data

    async def extensions(self):
        if self.ext_fail:
            raise self.ext_fail
        return self.extensions_data

    async def system_status(self):
        return self.system_data


def _engine(tmp_path):
    e = db.make_engine(f"sqlite:///{tmp_path / 'tcx.db'}")
    create_core_tables(e)
    with e.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, device_type, enabled, threecx_ref) "
            "VALUES ('SIP-Trunk-1','trunk',1,'10'),('SIP-Trunk-2','trunk',1,'11')"
        ))
    return e


def _trunk_state(engine):
    return {r["threecx_ref"]: r for r in db.fetch_all(
        engine,
        "SELECT d.threecx_ref, s.value, s.severity FROM devices d "
        "JOIN device_state s ON s.device_id = d.id AND s.dimension='trunk'")}


def test_threecx_trunk_registration(tmp_path):
    engine = _engine(tmp_path)
    fake = FakeTcx()
    fake.trunks_data = [
        {"Id": 10, "Name": "Primary", "Registered": True},
        {"Id": 11, "Name": "Backup", "RegistrationStatus": "Unregistered"},
    ]
    n = asyncio.run(ThreeCxCollector(engine, fake).run_once())
    assert n == 4  # 2 trunk-state writes + 2 persisted trunk rows
    st = _trunk_state(engine)
    assert st["10"]["value"] == "up" and st["10"]["severity"] == "ok"
    assert st["11"]["value"] == "down" and st["11"]["severity"] == "crit"


def test_threecx_blind_on_unreachable(tmp_path):
    engine = _engine(tmp_path)
    fake = FakeTcx()
    fake.trunks_data = [{"Id": 10, "Registered": True}]
    coll = ThreeCxCollector(engine, fake)
    asyncio.run(coll.run_once())
    fake.fail = ThreeCxError("pbx down")
    asyncio.run(coll.run_guarded())
    st = _trunk_state(engine)
    assert st["10"]["value"] == "blind" and st["11"]["value"] == "blind"
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='threecx'")
    assert h["consecutive_failures"] == 1


# ---- Phase 10.4 inventory persistence ---------------------------------------

def test_threecx_persists_trunks_extensions_and_system(tmp_path):
    from netmon.snapshots import read_snapshot
    engine = _engine(tmp_path)
    fake = FakeTcx()
    fake.trunks_data = [
        {"Id": 10, "Name": "SIP-A", "Host": "sip.provider.net", "MainNumber": "2055550100",
         "Registered": True, "SimultaneousCalls": 30, "ActiveCalls": 4},
        {"Id": 11, "Name": "SIP-B", "Registered": False},
    ]
    fake.extensions_data = [
        {"Number": "1001", "FirstName": "Ada", "LastName": "Byte", "IsRegistered": True, "Office": "BHS"},
        {"Number": "1002", "DisplayName": "Front Desk", "IsRegistered": False, "Dnd": True},
    ]
    fake.system_data = {"CallsActive": 4, "TrunksRegistered": 1, "Version": "20.0.5"}
    n = asyncio.run(ThreeCxCollector(engine, fake).run_once())
    assert n >= 4  # 2 trunk state + 2 trunk rows (+ ext rows)

    trunks = {t["name"]: t for t in db.fetch_all(engine, "SELECT * FROM trunks")}
    assert trunks["SIP-A"]["reg_status"] == "registered" and trunks["SIP-A"]["ch_total"] == 30
    assert trunks["SIP-A"]["ch_in_use"] == 4 and trunks["SIP-A"]["did"] == "2055550100"
    assert trunks["SIP-B"]["reg_status"] == "unregistered"

    exts = {e["ext"]: e for e in db.fetch_all(engine, "SELECT * FROM extensions")}
    assert exts["1001"]["name"] == "Ada Byte" and exts["1001"]["registered"] == 1
    assert exts["1002"]["name"] == "Front Desk" and exts["1002"]["dnd"] == 1

    sysstat = read_snapshot(engine, "threecx.system")
    assert sysstat["ok"] and sysstat["payload"]["Version"] == "20.0.5"


def test_threecx_extensions_endpoint_fail_soft(tmp_path):
    engine = _engine(tmp_path)
    fake = FakeTcx()
    fake.trunks_data = [{"Id": 10, "Registered": True}]
    fake.ext_fail = ThreeCxError("HTTP 404 on /Users")
    # Trunk persistence + system snapshot still succeed.
    asyncio.run(ThreeCxCollector(engine, fake).run_once())
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM trunks")["n"] == 1
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM extensions")["n"] == 0
