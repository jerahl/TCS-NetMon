"""Wireless API — read-only, DB-only (spec 10 §6, Phase 10.2)."""

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
        c.execute(text(
            "INSERT INTO devices (name, site, device_type, enabled, xiq_device_id) VALUES "
            "('BHS-56-Hallway','BHS','ap',1,'100001'),"
            "('CHS-12-Room','CHS','ap',1,'100003'),"
            "('BHS-Core-1','BHS','switch',1,'100002')"))
        c.execute(text(
            "INSERT INTO device_state (device_id, dimension, value, severity, source, updated_at) VALUES "
            "(1,'source_status','up','ok','xiq',:t),(2,'source_status','down','crit','xiq',:t)"),
            {"t": now})
        c.execute(text(
            "INSERT INTO ap_details (device_id, model, serial, fw_version, ip, network_policy, "
            "uptime_s, clients_total, updated_at) VALUES "
            "(1,'AP305C','S1','10.6.4.0','192.0.2.11','TCS-Schools',86400,2,:t),"
            "(2,'AP305C','S3','10.5.9.1','192.0.2.30','TCS-Schools',NULL,0,:t)"), {"t": now})
        c.execute(text(
            "INSERT INTO ap_radios (device_id, radio, band, channel, width_mhz, tx_power_dbm, clients, updated_at) "
            "VALUES (1,'wifi0','2.4',6,20,14,1,:t),(1,'wifi1','5',149,80,17,1,:t)"), {"t": now})
        c.execute(text(
            "INSERT INTO wireless_clients (mac, device_id, ssid, band, rssi_dbm, os, hostname, username, ip, updated_at) VALUES "
            "('aa:bb:cc:00:01:01',1,'TCS-Student','5',-54,'Chrome OS','cb-1','student1@example.org','192.0.2.101',:t),"
            "('aa:bb:cc:00:01:02',1,'TCS-Staff','2.4',-61,'Windows','lt-9','teacher9@example.org','192.0.2.102',:t),"
            "('aa:bb:cc:00:01:03',NULL,'TCS-IoT','2.4',-70,NULL,NULL,NULL,'192.0.2.103',:t)"), {"t": now})
        c.execute(text(
            "INSERT INTO ssids (name, auth, enabled, network_policy, updated_at) VALUES "
            "('TCS-Student','WPA2_PSK',1,'TCS-Schools',:t),"
            "('TCS-Staff','WPA2_ENTERPRISE',1,'TCS-Schools',:t)"), {"t": now})
    engine.dispose()


def _client(tmp_path, url):
    return TestClient(create_app(config=load_config(write_config(tmp_path, db_url=url)),
                                 supervisor=Supervisor()))


def test_wireless_summary(tmp_path):
    url = f"sqlite:///{tmp_path/'w.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        s = client.get("/api/wireless/summary").json()
        assert s["aps_total"] == 2 and s["aps_up"] == 1 and s["aps_down"] == 1
        assert s["clients_total"] == 3
        assert s["clients_by_band"] == {"5": 1, "2.4": 2}
        assert s["firmware"][0]["n"] == 1  # two distinct versions
        assert {f["fw_version"] for f in s["firmware"]} == {"10.6.4.0", "10.5.9.1"}
        assert s["top_ssids"][0]["n"] == 1


def test_wireless_aps_and_detail(tmp_path):
    url = f"sqlite:///{tmp_path/'w.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        aps = client.get("/api/wireless/aps").json()
        assert [a["name"] for a in aps] == ["BHS-56-Hallway", "CHS-12-Room"]  # switch excluded
        assert aps[0]["status"] == "up" and aps[0]["model"] == "AP305C"

        d = client.get("/api/wireless/aps/1").json()
        assert d["detail"]["fw_version"] == "10.6.4.0"
        assert [r["radio"] for r in d["radios"]] == ["wifi0", "wifi1"]
        assert len(d["clients"]) == 2
        assert client.get("/api/wireless/aps/999").status_code == 404


def test_wireless_ssids_rollup_and_clients_search(tmp_path):
    url = f"sqlite:///{tmp_path/'w.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        ssids = {s["name"]: s for s in client.get("/api/wireless/ssids").json()}
        assert ssids["TCS-Student"]["clients"] == 1
        assert ssids["TCS-Staff"]["auth"] == "WPA2_ENTERPRISE"

        rows = client.get("/api/wireless/clients?q=teacher9").json()
        assert len(rows) == 1 and rows[0]["ap_name"] == "BHS-56-Hallway"
        assert client.get("/api/wireless/clients?q=no-such-thing").json() == []
        # Unattributed client keeps a NULL ap.
        iot = client.get("/api/wireless/clients?q=TCS-IoT").json()
        assert iot[0]["ap_name"] is None


def test_wireless_requires_auth(tmp_path):
    url = f"sqlite:///{tmp_path/'w.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(create_app(config=load_config(conf), supervisor=Supervisor())) as client:
        assert client.get("/api/wireless/summary").status_code == 401
        assert client.get("/api/wireless/clients").status_code == 401
