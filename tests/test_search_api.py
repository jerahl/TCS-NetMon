"""⌘K search API (spec 10 §6 / phase 10.5): devices + pf_nodes + fdb_entries."""

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
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, mgmt_ip, enabled) VALUES "
            "('BHS-Core-1','BHS','switch','192.0.2.2',1),"
            "('BHS-56-AP','BHS','ap','192.0.2.11',1)"
        ))
        conn.execute(text(
            "INSERT INTO pf_nodes (mac, computername, ip, dot1x_user, role, reg_status, "
            "last_switch, last_port, updated_at) VALUES "
            "('aa:bb:cc:11:22:33', 'LAPTOP-JDOE', '10.1.2.3', 'jdoe', 'staff', 'reg', "
            " 'BHS-Core-1', '1:12', :now)"), {"now": now})
        conn.execute(text(
            "INSERT INTO fdb_entries (device_id, mac, vlan_id, ifindex, updated_at) VALUES "
            "(1, 'aa:bb:cc:11:22:33', 100, 12, :now)"), {"now": now})
    engine.dispose()


def _app(conf):
    return create_app(config=load_config(conf), supervisor=Supervisor())


def test_search_device_by_name_and_ip(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        data = client.get("/api/search?q=Core").json()
        assert [h["title"] for h in data["devices"]] == ["BHS-Core-1"]
        assert data["devices"][0]["href"] == "#/switches/1"

        by_ip = client.get("/api/search?q=192.0.2.11").json()
        assert by_ip["devices"][0]["title"] == "BHS-56-AP"
        assert by_ip["devices"][0]["href"] == "#/ap/2"


def test_search_endpoint_by_user_and_hostname(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        by_user = client.get("/api/search?q=jdoe").json()
        assert len(by_user["endpoints"]) == 1
        hit = by_user["endpoints"][0]
        assert hit["title"] == "LAPTOP-JDOE"
        assert "aa:bb:cc:11:22:33" in hit["subtitle"]
        # Pre-filtered to the node's MAC (URL-encoded colons).
        assert hit["href"] == "#/nac?q=aa%3Abb%3Acc%3A11%3A22%3A33"


def test_search_mac_hits_endpoint_and_fdb(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        data = client.get("/api/search?q=aa:bb:cc:11").json()
        # MAC matches both the NAC node and the FDB entry.
        assert len(data["endpoints"]) == 1
        assert len(data["macs"]) == 1
        mac = data["macs"][0]
        # Pre-filtered to the MAC on that switch's FDB tab.
        assert mac["href"] == "#/switches/1?mac=aa%3Abb%3Acc%3A11%3A22%3A33"
        assert "on BHS-Core-1" in mac["subtitle"]
        assert data["total"] == 2


def test_search_short_query_is_empty(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        data = client.get("/api/search?q=a").json()
        assert data["total"] == 0
        assert data["devices"] == []


def test_search_requires_auth(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(_app(conf)) as client:
        assert client.get("/api/search?q=Core").status_code == 401
