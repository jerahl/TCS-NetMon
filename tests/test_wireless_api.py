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
            "INSERT INTO wireless_clients (mac, device_id, radio, ssid, band, rssi_dbm, os, hostname, username, ip, updated_at) VALUES "
            "('aa:bb:cc:00:01:01',1,'wifi0','TCS-Student','5',-54,'Chrome OS','cb-1','student1@example.org','192.0.2.101',:t),"
            "('aa:bb:cc:00:01:02',1,'wifi0','TCS-Staff','2.4',-61,'Windows','lt-9','teacher9@example.org','192.0.2.102',:t),"
            "('aa:bb:cc:00:01:03',NULL,NULL,'TCS-IoT','2.4',-70,NULL,NULL,NULL,'192.0.2.103',:t)"), {"t": now})
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


def test_ap_radio_client_counts_are_derived_not_stored(tmp_path):
    """``ap_radios.clients`` is NULL on every row by design — XIQ's radio
    payload carries SSID descriptors, not clients — so the count is rolled up
    from ``wireless_clients.radio`` at read time, the way ssids already works.

    A radio with no clients must report 0, not NULL: on this fleet 700 of 1,574
    radios genuinely have none, and "0" and "we don't know" are different
    answers.
    """
    url = f"sqlite:///{tmp_path/'w.db'}"
    _seed(url)
    with _client(tmp_path, url) as client:
        radios = {r["radio"]: r for r in client.get("/api/wireless/aps/1").json()["radios"]}
        assert radios["wifi0"]["clients"] == 2   # both seeded clients are on wifi0
        assert radios["wifi1"]["clients"] == 0   # real zero, not a null
        # The stored column stays untouched and unused.
        assert "util_pct" in radios["wifi0"]


def test_ap_uplink_prefers_the_access_port_not_a_trunk(tmp_path):
    """The failure this guards against is destructive, not cosmetic.

    An AP's MAC is learned on every port in its path — on the live fleet a
    median of 5 and up to 14 — and all but one are uplink trunks. Taking any
    FDB row would point Cycle PoE at a 10G uplink carrying 168 MACs, bouncing a
    whole switch's worth of devices instead of one AP.
    """
    from netmon.api.wireless import _ap_uplink
    from sqlalchemy import text
    url = f"sqlite:///{tmp_path/'w.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        # Two switches learn the AP: its access port (1 MAC, PoE copper) and a
        # trunk (3 MACs, SFP). Note the unpunctuated ap_details MAC vs the
        # colon form in fdb_entries — the join must normalise or it finds none.
        c.execute(text("INSERT INTO devices (id,name,site,device_type,enabled) "
                       "VALUES (10,'EDGE-SW','S','switch',1),(11,'CORE-SW','S','switch',1)"))
        c.execute(text("UPDATE ap_details SET mgmt_mac='aabbcc001122' WHERE device_id=1"))
        c.execute(text("INSERT INTO fdb_entries (device_id,mac,ifindex,updated_at) VALUES "
                       "(10,'aa:bb:cc:00:11:22',5,:t),(11,'aa:bb:cc:00:11:22',49,:t),"
                       "(11,'aa:bb:cc:00:99:01',49,:t),(11,'aa:bb:cc:00:99:02',49,:t)"),
                  {"t": "2026-09-01 00:00:00"})
        c.execute(text("INSERT INTO switch_ports (device_id,ifindex,name,poe_delivering,is_sfp,speed_mbps) "
                       "VALUES (10,5,'1:5',1,0,1000),(11,49,'1:49',NULL,1,10000)"))
    engine.dispose()

    engine = db.make_engine(url)
    u = _ap_uplink(engine, {"mgmt_mac": "aabbcc001122"})
    assert u["switch_name"] == "EDGE-SW"      # not the 3-MAC SFP trunk
    assert u["port"] == "1:5"
    assert u["macs_on_port"] == 1
    assert u["candidates"] == 2
    assert u["poe_cycle_safe"] is True


def test_ap_uplink_refuses_to_confirm_an_unpoed_port(tmp_path):
    """No PoE and/or SFP means it is probably an uplink — show it, don't act."""
    from netmon.api.wireless import _ap_uplink
    from sqlalchemy import text
    url = f"sqlite:///{tmp_path/'w.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        c.execute(text("INSERT INTO devices (id,name,site,device_type,enabled) "
                       "VALUES (11,'CORE-SW','S','switch',1)"))
        c.execute(text("UPDATE ap_details SET mgmt_mac='aabbcc001122' WHERE device_id=1"))
        c.execute(text("INSERT INTO fdb_entries (device_id,mac,ifindex,updated_at) "
                       "VALUES (11,'aa:bb:cc:00:11:22',49,:t)"), {"t": "2026-09-01 00:00:00"})
        c.execute(text("INSERT INTO switch_ports (device_id,ifindex,name,poe_delivering,is_sfp,speed_mbps) "
                       "VALUES (11,49,'1:49',NULL,1,10000)"))
    engine.dispose()

    u = _ap_uplink(db.make_engine(url), {"mgmt_mac": "aabbcc001122"})
    assert u["port"] == "1:49"                 # still shown
    assert u["poe_cycle_safe"] is False        # but never actioned
    assert "uplink" in u["why"]


def test_ap_uplink_blocks_when_packetfence_disagrees(tmp_path):
    """PF's last_port is an independent source; a conflict must veto the action.

    PF spells an Extreme stacked port "5035" where SNMP spells it "5:35", so
    the comparison normalises before concluding anything.
    """
    from netmon.api.wireless import _ap_uplink
    from sqlalchemy import text
    url = f"sqlite:///{tmp_path/'w.db'}"
    _seed(url)
    engine = db.make_engine(url)
    with engine.begin() as c:
        c.execute(text("INSERT INTO devices (id,name,site,device_type,enabled) "
                       "VALUES (10,'EDGE-SW','S','switch',1)"))
        c.execute(text("UPDATE ap_details SET mgmt_mac='aabbcc001122' WHERE device_id=1"))
        c.execute(text("INSERT INTO fdb_entries (device_id,mac,ifindex,updated_at) "
                       "VALUES (10,'aa:bb:cc:00:11:22',35,:t)"), {"t": "2026-09-01 00:00:00"})
        c.execute(text("INSERT INTO switch_ports (device_id,ifindex,name,poe_delivering,is_sfp,speed_mbps) "
                       "VALUES (10,35,'5:35',1,0,1000)"))
    engine.dispose()
    engine = db.make_engine(url)

    agree = _ap_uplink(engine, {"mgmt_mac": "aabbcc001122"}, {"last_port": "5035"})
    assert agree["pf_agrees"] is True and agree["poe_cycle_safe"] is True

    clash = _ap_uplink(engine, {"mgmt_mac": "aabbcc001122"}, {"last_port": "5036"})
    assert clash["pf_agrees"] is False
    assert clash["poe_cycle_safe"] is False    # corroborated port, vetoed anyway

    silent = _ap_uplink(engine, {"mgmt_mac": "aabbcc001122"}, {"last_port": None})
    assert silent["pf_agrees"] is None and silent["poe_cycle_safe"] is True


def test_ap_uplink_none_when_mac_unknown(tmp_path):
    from netmon.api.wireless import _ap_uplink
    url = f"sqlite:///{tmp_path/'w.db'}"
    _seed(url)
    engine = db.make_engine(url)
    assert _ap_uplink(engine, {"mgmt_mac": None}) is None
    assert _ap_uplink(engine, {"mgmt_mac": "nonsense"}) is None
    assert _ap_uplink(engine, {"mgmt_mac": "aabbcc001122"}) is None   # no FDB rows
