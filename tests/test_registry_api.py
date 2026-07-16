"""Registry admin API — site CRUD + XIQ import (admin, edit-gated)."""

from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config


def _conf(tmp_path, url, *, allow_edit=True, xiq=False):
    conf = tmp_path / "netmon.conf"
    lines = [
        f"[db]\nurl = {url}\n",
        "[web]\nsecure_cookies = false\n",
        "[auth]\ndev_bypass_user = admin\ndev_bypass_role = admin\n",
        f"[security]\nallow_web_edit = {'true' if allow_edit else 'false'}\n",
    ]
    if xiq:
        lines.append("[xiq]\nenabled = true\napi_token = tok\nbase_url = https://xiq.example\n")
    conf.write_text("\n".join(lines))
    return conf


def _seed(url):
    engine = db.make_engine(url)
    create_core_tables(engine)
    with engine.begin() as c:
        c.execute(text("INSERT INTO sites (name, display_name, tier, lat, lon, enabled) "
                       "VALUES ('BHS','Big High','high',33.2,-87.5,1)"))
        c.execute(text("INSERT INTO devices (name, site, device_type, enabled) "
                       "VALUES ('sw-1','BHS','switch',1)"))
    engine.dispose()


def _client(conf):
    return TestClient(create_app(config=load_config(conf), supervisor=Supervisor()))


def test_site_create_update_delete(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url)) as client:
        assert len(client.get("/api/registry/sites").json()) == 1

        r = client.post("/api/registry/sites", json={"name": "CHS", "tier": "high"})
        assert r.status_code == 200
        # duplicate name → 409
        assert client.post("/api/registry/sites", json={"name": "CHS"}).status_code == 409

        chs = [s for s in client.get("/api/registry/sites").json() if s["name"] == "CHS"][0]
        r = client.put(f"/api/registry/sites/{chs['id']}", json={"name": "CHS-Main", "tier": "high"})
        assert r.status_code == 200 and r.json()["renamed_from"] == "CHS"

        # deleting a site with devices assigned → 409 (no silent orphaning)
        bhs = [s for s in client.get("/api/registry/sites").json() if s["name"] == "BHS"][0]
        assert bhs["device_count"] == 1
        assert client.delete(f"/api/registry/sites/{bhs['id']}").status_code == 409
        # the empty renamed site deletes fine
        assert client.delete(f"/api/registry/sites/{chs['id']}").status_code == 200


def test_site_rename_repoints_devices(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url)) as client:
        bhs = client.get("/api/registry/sites").json()[0]
        client.put(f"/api/registry/sites/{bhs['id']}", json={"name": "BHS-Renamed", "tier": "high"})
    engine = db.make_engine(url)
    # the device's site join key followed the rename
    assert db.fetch_one(engine, "SELECT site FROM devices WHERE name='sw-1'")["site"] == "BHS-Renamed"


def test_edit_gate_blocks_writes(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url, allow_edit=False)) as client:
        # reads still work; writes are 403 until allow_web_edit=true
        assert client.get("/api/registry/sites").status_code == 200
        assert client.post("/api/registry/sites", json={"name": "X"}).status_code == 403


def test_import_xiq_dry_run(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)

    async def fake_get_devices(self, view="BASIC"):
        return [
            {"id": "900001", "hostname": "BHS-Core-9", "device_function": "SWITCH", "ip_address": "192.0.2.9"},
            {"id": "900002", "hostname": "BHS-AP-9", "device_function": "AP", "ip_address": "192.0.2.19"},
        ]
    monkeypatch.setattr("netmon.collectors.xiq_client.XiqClient.get_devices", fake_get_devices)

    with _client(_conf(tmp_path, url, xiq=True)) as client:
        r = client.post("/api/registry/import-xiq", json={"dry_run": True}).json()
        assert r["dry_run"] is True and r["fetched"] == 2 and r["would_add"] == 2
        assert {d["name"] for d in r["new_devices"]} == {"BHS-Core-9", "BHS-AP-9"}
    # dry-run wrote nothing
    engine = db.make_engine(url)
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM devices WHERE xiq_device_id IS NOT NULL")["n"] == 0


def test_import_xiq_writes_and_preserves_site(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    # Pre-existing device carries a site; the import must preserve it (D9).
    engine = db.make_engine(url)
    db.execute(engine, "UPDATE devices SET xiq_device_id='900001', site='BHS' WHERE name='sw-1'")

    async def fake_get_devices(self, view="BASIC"):
        return [{"id": "900001", "hostname": "sw-1", "device_function": "SWITCH"},
                {"id": "900002", "hostname": "new-ap", "device_function": "AP"}]
    monkeypatch.setattr("netmon.collectors.xiq_client.XiqClient.get_devices", fake_get_devices)

    with _client(_conf(tmp_path, url, xiq=True)) as client:
        r = client.post("/api/registry/import-xiq", json={"dry_run": False}).json()
        assert r["added"] == 1 and r["updated"] == 1
    assert db.fetch_one(engine, "SELECT site FROM devices WHERE xiq_device_id='900001'")["site"] == "BHS"
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM devices")["n"] == 2


def test_import_xiq_requires_source_enabled(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    with _client(_conf(tmp_path, url, xiq=False)) as client:
        assert client.post("/api/registry/import-xiq", json={"dry_run": True}).status_code == 400


def test_registry_requires_admin(tmp_path):
    url = f"sqlite:///{tmp_path/'r.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)  # SAML, no session → 401
    with TestClient(create_app(config=load_config(conf), supervisor=Supervisor())) as client:
        assert client.get("/api/registry/sites").status_code == 401
