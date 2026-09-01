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
    db.upsert(engine, "neighbors", {"device_id": 1, "local_ifindex": 1001},
              {"remote_sysname": "core-1", "remote_port": "1:52", "protocol": "edp",
               "age_s": 12, "updated_at": now})
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
        nb = client.get("/api/switches/1/neighbors").json()[0]
        assert nb["remote_sysname"] == "core-1" and nb["protocol"] == "edp"
        assert nb["local_port"] == "1:1"  # joined from switch_ports
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


def test_poe_cycle_advice_refuses_ports_that_carry_no_poe():
    """Cycling PoE on a port with none is at best a no-op and at worst an
    unexplained config push, since the rConfig snippet still runs."""
    from netmon.api.switches import _poe_cycle_advice

    sfp = _poe_cycle_advice({"is_sfp": 1, "poe_admin": None, "poe_delivering": None}, 2)
    assert sfp["available"] is False and "SFP" in sfp["reason"]

    no_poe = _poe_cycle_advice({"is_sfp": 0, "poe_admin": 0, "poe_delivering": 0}, 1)
    assert no_poe["available"] is False
    assert "not configured for PoE" in no_poe["reason"]


def test_poe_cycle_advice_warns_when_the_port_looks_like_an_uplink():
    """Warns rather than blocks: the operator picked this port off the
    faceplate, and occasionally bouncing an uplink is what you want — but they
    should not learn it from the outage."""
    from netmon.api.switches import _poe_cycle_advice, UPLINK_MAC_HINT

    port = {"is_sfp": 0, "poe_admin": 1, "poe_delivering": 1}
    access = _poe_cycle_advice(port, 2)
    assert access["available"] is True and access["warn"] is None

    trunk = _poe_cycle_advice(port, UPLINK_MAC_HINT + 40)
    assert trunk["available"] is True          # not blocked
    assert "uplink" in trunk["warn"]           # but said out loud
    assert str(UPLINK_MAC_HINT + 40) in trunk["warn"]


def test_poe_cycle_advice_flags_an_unswept_port_without_refusing_it():
    """No PoE reading is not the same as no PoE — say so, don't invent either."""
    from netmon.api.switches import _poe_cycle_advice

    a = _poe_cycle_advice({"is_sfp": 0, "poe_admin": None, "poe_delivering": None}, 1)
    assert a["available"] is True and a["unverified"] is True

    b = _poe_cycle_advice({"is_sfp": 0, "poe_admin": 1, "poe_delivering": 1}, 1)
    assert b["unverified"] is False
