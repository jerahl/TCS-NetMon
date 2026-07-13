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
            "INSERT INTO devices (name, site, device_type, mgmt_ip, snmp_capable, enabled) "
            "VALUES ('BHS-56-Hallway','BHS','ap','192.0.2.11',0,1),"
            "       ('BHS-Core-1','BHS','switch','192.0.2.2',1,1)"
        ))
    db.upsert(engine, "device_state", {"device_id": 1, "dimension": "ping"},
              {"value": "up", "severity": "ok", "source": "poller", "updated_at": now})
    db.upsert(engine, "device_state", {"device_id": 2, "dimension": "ping"},
              {"value": "down", "severity": "crit", "source": "poller", "updated_at": now})
    db.upsert(engine, "device_state", {"device_id": 2, "dimension": "snmp"},
              {"value": "down", "severity": "warn", "source": "poller", "updated_at": now})
    engine.dispose()


def _app(conf):
    return create_app(config=load_config(conf), supervisor=Supervisor())


def test_status_json(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        r = client.get("/api/status")
        assert r.status_code == 200
        data = {d["name"]: d for d in r.json()}
        assert data["BHS-56-Hallway"]["ping"]["value"] == "up"
        assert data["BHS-56-Hallway"]["ping"]["severity"] == "ok"
        assert data["BHS-Core-1"]["ping"]["severity"] == "crit"
        assert data["BHS-Core-1"]["snmp"]["value"] == "down"
        # A device with no snmp row reports unknown, not a crash.
        assert data["BHS-56-Hallway"]["snmp"]["value"] is None
        assert data["BHS-56-Hallway"]["snmp"]["severity"] == "unknown"


def test_status_page_html(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        r = client.get("/status")
        assert r.status_code == 200
        assert "text/html" in r.headers["content-type"]
        assert "BHS-56-Hallway" in r.text
        assert "Device status" in r.text


def test_status_requires_auth(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(_app(conf)) as client:
        assert client.get("/api/status").status_code == 401
