import asyncio
import json

from netmon import db
from netmon.collectors.packetfence import PfCollector, build_pf_rows
from netmon.collectors.pf_client import PfError
from netmon.snapshots import read_snapshot
from tests.conftest import create_core_tables


class FakePf:
    def __init__(self):
        self.nodes_data = []
        self.categories_data = {}
        self.locs_data = []
        self.failures_data = []
        self.snapshots = {}          # path -> payload
        self.snapshot_fail = set()   # paths that raise
        self.fail = None

    async def nodes(self, limit=1000):
        if self.fail:
            raise self.fail
        return self.nodes_data

    async def node_categories(self):
        if self.fail:
            raise self.fail
        return self.categories_data

    async def open_locationlogs(self, limit=1000):
        if self.fail:
            raise self.fail
        return self.locs_data

    async def recent_auth_failures(self, limit=25):
        return self.failures_data

    async def get_json(self, path):
        if path in self.snapshot_fail:
            raise PfError(f"HTTP 404 on {path}")
        return self.snapshots.get(path, {"items": []})


def _engine(tmp_path):
    e = db.make_engine(f"sqlite:///{tmp_path / 'pf.db'}")
    create_core_tables(e)
    return e


def _fake():
    fake = FakePf()
    fake.nodes_data = [
        {"mac": "AA-BB-CC-00-00-11", "computername": "student-cb", "status": "reg",
         "category_id": "12", "device_class": "Chrome OS", "device_type": "Laptop",
         "device_manufacturer": "HP", "pid": "student1@example.org",
         "dhcp_fingerprint": "1,121,3,6", "ip4log.ip": "192.0.2.101",
         "last_seen": "2026-07-16 12:00:00"},
        {"mac": "aa:bb:cc:00:00:22", "computername": "rogue-thing", "status": "pending",
         "category_id": "99", "device_class": "Generic", "pid": "default"},
    ]
    fake.categories_data = {"12": "Student"}
    fake.locs_data = [
        # newest first; the first row per MAC wins
        {"mac": "aabbcc000011", "switch": "BHS-Core-1", "switch_ip": "192.0.2.2",
         "port": "1001", "vlan": 100, "role": "Student", "ssid": "TCS-Student",
         "connection_type": "Wireless-802.11-EAP", "connection_sub_type": "PEAP",
         "dot1x_username": "student1", "start_time": "2026-07-16 11:59:00"},
        {"mac": "aabbcc000011", "switch": "OLD-SW", "port": "9",
         "start_time": "2026-07-15 08:00:00"},
    ]
    fake.failures_data = [{"mac": "aa:bb:cc:00:00:33", "reason": "eap timeout"}]
    fake.snapshots["/api/v1/cluster/servers"] = {"items": [{"host": "pf-1", "management_ip": "192.0.2.9"}]}
    return fake


def test_build_pf_rows_merges_identity_role_and_location():
    from datetime import datetime, timezone
    fake = _fake()
    rows = {r["mac"]: r for r in build_pf_rows(
        fake.nodes_data, fake.categories_data, fake.locs_data,
        datetime.now(timezone.utc))}
    a = rows["aa:bb:cc:00:00:11"]
    assert a["role"] == "Student"               # category_id resolved to a name
    assert a["last_switch"] == "BHS-Core-1"     # newest open session wins
    assert a["last_port"] == "1001" and a["vlan"] == "100"
    assert a["conn_method"] == "Wireless-802.11-EAP" and a["conn_sub"] == "PEAP"
    assert a["owner"] == "student1@example.org" and a["online"] == 1
    b = rows["aa:bb:cc:00:00:22"]
    assert b["role"] is None                    # unknown category, no session
    assert b["online"] == 0 and b["reg_status"] == "pending"


def test_pf_persists_nodes_and_snapshots(tmp_path):
    engine = _engine(tmp_path)
    pf = PfCollector(engine, _fake())
    n = asyncio.run(pf.run_once())
    assert n == 2

    rows = {r["mac"]: r for r in db.fetch_all(engine, "SELECT * FROM pf_nodes")}
    assert rows["aa:bb:cc:00:00:11"]["last_switch"] == "BHS-Core-1"
    assert rows["aa:bb:cc:00:00:22"]["reg_status"] == "pending"

    rejects = read_snapshot(engine, "pf.rejects")
    assert rejects["ok"] is True and rejects["payload"][0]["reason"] == "eap timeout"
    cluster = read_snapshot(engine, "pf.cluster")
    assert cluster["payload"]["items"][0]["host"] == "pf-1"


def test_pf_replace_on_refresh_prunes_gone_nodes(tmp_path):
    engine = _engine(tmp_path)
    fake = _fake()
    pf = PfCollector(engine, fake)
    asyncio.run(pf.run_once())
    fake.nodes_data = fake.nodes_data[:1]  # second node gone from PF
    asyncio.run(pf.run_once())
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM pf_nodes")["n"] == 1


def test_pf_unreachable_keeps_rows_stale_and_records_error(tmp_path):
    engine = _engine(tmp_path)
    fake = _fake()
    pf = PfCollector(engine, fake)
    asyncio.run(pf.run_once())

    fake.fail = PfError("PF unreachable")
    asyncio.run(pf.run_guarded())  # guarded: records health, no raise

    # Rows stay (visibly stale) — never blanked on a failed refresh.
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM pf_nodes")["n"] == 2
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='packetfence'")
    assert h["consecutive_failures"] == 1
    assert "unreachable" in (h["last_error"] or "")


def test_pf_snapshot_fetch_failure_is_fail_soft(tmp_path):
    engine = _engine(tmp_path)
    fake = _fake()
    pf = PfCollector(engine, fake)
    asyncio.run(pf.run_once())  # pf.cluster ok

    fake.snapshot_fail.add("/api/v1/cluster/servers")
    asyncio.run(pf.run_once())  # node cycle still succeeds

    cluster = read_snapshot(engine, "pf.cluster")
    # Previous payload retained, flagged not-ok (stale, never blanked).
    assert cluster["ok"] is False
    assert cluster["payload"]["items"][0]["host"] == "pf-1"
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM pf_nodes")["n"] == 2
