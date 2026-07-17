"""Global summary API (spec 10 §6 / phase 10.5): fleet + severity + alerts
roll-ups and per-domain system cards, folding source health honestly."""

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
            "('BHS-Core-1','BHS','switch','192.0.2.2',1),"       # 1 switch up
            "('BHS-Core-2','BHS','switch','192.0.2.3',1),"       # 2 switch down
            "('BHS-56-AP','BHS','ap','192.0.2.11',1),"           # 3 ap up
            "('BHS-Cam-1','BHS','camera','192.0.2.21',1),"       # 4 camera recording
            "('BHS-Trunk','BHS','trunk',NULL,1)"                 # 5 trunk
        ))

    def st(dev, dim, value, sev, source="poller"):
        db.upsert(engine, "device_state", {"device_id": dev, "dimension": dim},
                  {"value": value, "severity": sev, "source": source, "updated_at": now})
    st(1, "ping", "up", "ok")
    st(2, "ping", "down", "crit")
    st(3, "ping", "up", "ok")
    st(3, "source_status", "blind", "warn", "xiq")   # AP source blind
    st(4, "ping", "up", "ok")
    st(4, "recording", "up", "ok", "milestone")
    st(5, "trunk", "registered", "ok", "threecx")

    with engine.begin() as conn:
        # Two switch ports (one down), one camera, one trunk.
        conn.execute(text(
            "INSERT INTO switch_ports (device_id, ifindex, oper_state, updated_at) VALUES "
            "(1, 1, 'up', :now), (1, 2, 'down', :now)"), {"now": now})
        conn.execute(text(
            "INSERT INTO cameras (device_id, enabled, updated_at) VALUES (4, 1, :now)"),
            {"now": now})
        conn.execute(text(
            "INSERT INTO trunks (device_id, name, reg_status, ch_total, ch_in_use, updated_at) "
            "VALUES (5, 'PRI', 'registered', 23, 4, :now)"), {"now": now})
        conn.execute(text(
            "INSERT INTO pf_nodes (mac, online, reg_status, updated_at) VALUES "
            "('aa:bb:cc:00:00:01', 1, 'reg', :now), "
            "('aa:bb:cc:00:00:02', 0, 'unreg', :now)"), {"now": now})
        # One open crit alert on the down switch.
        conn.execute(text(
            "INSERT INTO alert_rules (id, name, dimension, `condition`, severity) "
            "VALUES (1, 'ping-down', 'ping', 'value=down', 'crit')"))
        conn.execute(text(
            "INSERT INTO alerts (device_id, rule_id, opened_at) VALUES (2, 1, :now)"),
            {"now": now})
        # Collector health: xiq failing (blind), snmp_inventory ok.
        conn.execute(text(
            "INSERT INTO collector_health (name, last_success, consecutive_failures, updated_at) "
            "VALUES ('snmp_inventory', :now, 0, :now), "
            "('xiq', :old, 3, :now), "
            "('milestone', :now, 0, :now), "
            "('threecx', :now, 0, :now)"),
            {"now": now, "old": now})
    engine.dispose()


def _app(conf):
    return create_app(config=load_config(conf), supervisor=Supervisor())


def test_summary_fleet_and_severity(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        r = client.get("/api/summary")
        assert r.status_code == 200
        data = r.json()
        f = data["fleet"]
        assert f["total"] == 5
        assert f["up"] == 3           # switch1, ap3, cam4
        assert f["down"] == 1         # switch2
        assert f["unknown"] == 1      # trunk5 has no ping row
        assert f["blind"] == 1        # ap3 source_status=blind
        assert f["by_type"]["switch"] == 2
        # Device worst-of severity roll-up: switch2 is crit, ap3 warn, rest ok.
        sev = data["severity"]
        assert sev["crit"] == 1
        assert sev["warn"] == 1


def test_summary_alerts_rollup(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        a = client.get("/api/summary").json()["alerts"]
        assert a["open"] == 1
        assert a["crit"] == 1
        assert a["unacked"] == 1
        assert a["acked"] == 0
        assert a["assigned"] == 0


def test_summary_domains_and_blind_source(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        domains = {d["key"]: d for d in client.get("/api/summary").json()["domains"]}
        assert set(domains) == {
            "switching", "wireless", "nac", "surveillance", "voip", "config"}

        # Switching: one switch down → crit; source snmp_inventory ok → not blind.
        assert domains["switching"]["status"] == "crit"
        assert domains["switching"]["blind"] is False
        assert domains["switching"]["source"] == "snmp_inventory"

        # Wireless: XIQ collector is failing → blind, and never 'ok'.
        wl = domains["wireless"]
        assert wl["blind"] is True
        assert wl["status"] != "ok"
        assert wl["updated_at"] is not None   # last_success carried for staleness

        # NAC card counts pf_nodes, not registry devices.
        nac = {k["label"]: k["value"] for k in domains["nac"]["kpis"]}
        assert nac["Nodes"] == "2"
        assert nac["Online"] == "1"
        assert nac["Unregistered"] == "1"

        # VoIP trunk registered → ok.
        assert domains["voip"]["status"] == "ok"


def test_summary_requires_auth(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(_app(conf)) as client:
        assert client.get("/api/summary").status_code == 401
