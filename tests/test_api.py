from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.supervisor import Supervisor
from tests.conftest import DEVICES_DDL_SQLITE, write_config


def _seed_devices(url: str) -> None:
    engine = db.make_engine(url)
    with engine.begin() as conn:
        conn.execute(text(DEVICES_DDL_SQLITE))
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, mgmt_ip, snmp_capable, enabled) "
            "VALUES ('BHS-56-Hallway','BHS','ap','192.0.2.11',0,1),"
            "       ('BHS-Core-1','BHS','switch','192.0.2.2',1,1)"
        ))
    engine.dispose()


def _app(conf_path):
    cfg = load_config(conf_path)
    # Empty supervisor — no heartbeat noise during the test.
    return create_app(config=cfg, supervisor=Supervisor())


def test_healthz(tmp_path):
    conf = write_config(tmp_path)
    with TestClient(_app(conf)) as client:
        r = client.get("/healthz")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["db_ok"] is True


def test_devices_list_and_get_with_dev_bypass(tmp_path):
    url = f"sqlite:///{tmp_path / 'netmon.db'}"
    conf = write_config(tmp_path, db_url=url)  # dev bypass = admin
    _seed_devices(url)
    with TestClient(_app(conf)) as client:
        r = client.get("/api/devices")
        assert r.status_code == 200
        names = [d["name"] for d in r.json()]
        assert names == ["BHS-56-Hallway", "BHS-Core-1"]

        r2 = client.get("/api/devices?device_type=switch")
        assert [d["name"] for d in r2.json()] == ["BHS-Core-1"]

        r3 = client.get("/api/devices/1")
        assert r3.status_code == 200
        assert r3.json()["name"] == "BHS-56-Hallway"

        r4 = client.get("/api/devices/999")
        assert r4.status_code == 404


def test_me_with_dev_bypass(tmp_path):
    with TestClient(_app(write_config(tmp_path))) as client:
        r = client.get("/auth/me")
        assert r.status_code == 200
        assert r.json() == {"username": "devadmin", "role": "admin", "groups": []}


def test_root_redirects_to_ui(tmp_path):
    # Visiting the bare host must not 404 — it redirects to the UI (the built
    # bundle is committed, so ui_built is true).
    with TestClient(_app(write_config(tmp_path)), follow_redirects=False) as client:
        r = client.get("/")
        assert r.status_code in (307, 308)
        assert r.headers["location"] in ("/ui/", "/docs")


def test_unauthenticated_without_bypass(tmp_path):
    # No dev bypass, no session cookie → 401 on a gated route.
    conf = write_config(tmp_path, dev_bypass=False)
    with TestClient(_app(conf)) as client:
        assert client.get("/api/devices").status_code == 401
        assert client.get("/auth/me").status_code == 401
