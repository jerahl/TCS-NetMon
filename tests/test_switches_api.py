"""Switch inventory API — read-only, DB-only (spec 10 §6)."""

from datetime import datetime, timezone

from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config


def _seed(url):
    engine = db.make_engine(url)
    create_core_tables(engine)
    now = datetime.now(timezone.utc)
    with engine.begin() as c:
        c.execute(text("INSERT INTO devices (name, site, device_type, mgmt_ip, snmp_capable, enabled) "
                       "VALUES ('BHS-Core-1','BHS','switch','192.0.2.2',1,1)"))
        c.execute(text("INSERT INTO devices (name, site, device_type, enabled) "
                       "VALUES ('BHS-AP-1','BHS','ap',1)"))
    for i, oper in ((1001, "up"), (1002, "down")):
        db.upsert(engine, "switch_ports", {"device_id": 1, "ifindex": i},
                  {"name": f"1:{i-1000}", "member": 1, "oper_state": oper,
                   "speed_mbps": 1000, "updated_at": now})
    db.upsert(engine, "fdb_entries", {"device_id": 1, "mac": "00:0b:82:01:02:03"},
              {"ifindex": 1001, "updated_at": now})
    db.upsert(engine, "lldp_neighbors", {"device_id": 1, "local_ifindex": 1001},
              {"remote_sysname": "core-1", "updated_at": now})
    db.upsert(engine, "switch_vlans", {"device_id": 1, "vlan_id": 100},
              {"name": "Data", "admin_up": 1, "updated_at": now})
    db.upsert(engine, "stack_members", {"device_id": 1, "slot": 1},
              {"cpu_pct": 12, "mem_pct": 40.0, "temp_c": 38, "updated_at": now})
    db.upsert(engine, "config_backups", {"device_id": 1, "taken_at": now},
              {"size_bytes": 24576, "hash": "abc123", "updated_at": now})
    engine.dispose()


def _app(conf):
    return create_app(config=load_config(conf), supervisor=Supervisor())


def test_list_switches_rollup(tmp_path):
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        rows = client.get("/api/switches").json()
        assert len(rows) == 1  # the AP is excluded
        assert rows[0]["name"] == "BHS-Core-1"
        assert rows[0]["ports_total"] == 2 and rows[0]["ports_up"] == 1


def test_switch_detail_and_tabs(tmp_path):
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        d = client.get("/api/switches/1").json()
        assert d["name"] == "BHS-Core-1" and len(d["stack"]) == 1
        assert d["stack"][0]["mem_pct"] == 40.0

        ports = client.get("/api/switches/1/ports").json()
        assert [p["oper_state"] for p in ports] == ["up", "down"]

        pd = client.get("/api/switches/1/ports/1001").json()
        assert pd["port"]["name"] == "1:1"
        assert [m["mac"] for m in pd["macs"]] == ["00:0b:82:01:02:03"]

        assert client.get("/api/switches/1/fdb").json()[0]["ifindex"] == 1001
        assert client.get("/api/switches/1/lldp").json()[0]["remote_sysname"] == "core-1"
        assert client.get("/api/switches/1/vlans").json()[0]["vlan_id"] == 100

        backups = client.get("/api/switches/1/backups").json()
        assert backups[0]["size_bytes"] == 24576 and backups[0]["hash"] == "abc123"


def test_switch_404s(tmp_path):
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        assert client.get("/api/switches/2").status_code == 404   # id 2 is an AP
        assert client.get("/api/switches/1/ports/7777").status_code == 404


def test_switches_require_auth(tmp_path):
    url = f"sqlite:///{tmp_path/'s.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(_app(conf)) as client:
        assert client.get("/api/switches").status_code == 401
        assert client.get("/api/switches/1/ports").status_code == 401
