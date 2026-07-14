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
        conn.execute(text("INSERT INTO devices (name, site, device_type, enabled) VALUES ('SW1','BHS','switch',1)"))
        conn.execute(text("INSERT INTO alert_rules (name, dimension, `condition`, severity, min_duration_s, enabled) "
                          "VALUES ('device_down','ping','{\"op\":\"eq\",\"value\":\"down\"}','crit',0,1)"))
        conn.execute(text("INSERT INTO alerts (device_id, rule_id, opened_at, last_seen_at) VALUES (1,1,:t,:t)"),
                     {"t": now})
    engine.dispose()


def _app(conf):
    return create_app(config=load_config(conf), supervisor=Supervisor())


def test_alerts_list_and_ack(tmp_path):
    url = f"sqlite:///{tmp_path / 'a.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:  # dev bypass = admin
        r = client.get("/api/alerts")
        assert r.status_code == 200
        alerts = r.json()
        assert len(alerts) == 1 and alerts[0]["rule_name"] == "device_down"
        assert alerts[0]["acked_by"] is None

        aid = alerts[0]["id"]
        r2 = client.post(f"/api/alerts/{aid}/ack")
        assert r2.status_code == 200 and r2.json()["acked_by"] == "devadmin"

        assert client.get("/api/alerts").json()[0]["acked_by"] == "devadmin"
        # Unknown alert → 404.
        assert client.post("/api/alerts/999/ack").status_code == 404


def test_maintenance_create_and_list(tmp_path):
    url = f"sqlite:///{tmp_path / 'm.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        body = {
            "scope_type": "site", "scope_value": "BHS",
            "starts_at": "2026-07-13T00:00:00Z", "ends_at": "2026-07-14T00:00:00Z",
        }
        assert client.post("/api/maintenance", json=body).status_code == 200
        rows = client.get("/api/maintenance").json()
        assert len(rows) == 1 and rows[0]["scope_value"] == "BHS"
        # Bad scope rejected.
        assert client.post("/api/maintenance", json={**body, "scope_type": "bogus"}).status_code == 422
