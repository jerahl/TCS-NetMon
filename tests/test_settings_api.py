"""Settings API tests (spec 12): gating, masking, audit, apply."""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config

KEY = "c" * 64
SECURITY = f"[security]\nsettings_key = {KEY}\nallow_web_edit = true"


def _seed(url):
    engine = db.make_engine(url)
    create_core_tables(engine)
    engine.dispose()


def _app(conf):
    return create_app(config=load_config(conf), supervisor=Supervisor())


def _client(tmp_path, *, extra_sections=SECURITY, dev_bypass=True, role="admin"):
    url = f"sqlite:///{tmp_path / 'settings.db'}"
    _seed(url)
    conf = write_config(tmp_path, db_url=url, extra_sections=extra_sections)
    if role != "admin":
        text_ = conf.read_text().replace("dev_bypass_role = admin", f"dev_bypass_role = {role}")
        conf.write_text(text_)
    return TestClient(_app(conf)), url


def test_settings_requires_admin(tmp_path):
    client, _ = _client(tmp_path, role="operator")
    with client:
        assert client.get("/api/settings").status_code == 403
        assert client.put("/api/settings/engine.interval_s", json={"value": 60}).status_code == 403


def test_settings_list_masks_secrets(tmp_path):
    client, _ = _client(tmp_path)
    with client:
        r = client.get("/api/settings")
        assert r.status_code == 200
        body = r.json()
        assert body["edit_enabled"] is True and body["secrets_enabled"] is True
        rows = {s["key"]: s for g in body["groups"] for s in g["settings"]}
        tok = rows["xiq.api_token"]
        assert tok["secret"] is True and tok["value"] is None and tok["is_set"] is False
        assert rows["poller.ping_interval_s"]["value"] == 60
        assert rows["poller.ping_interval_s"]["source"] == "default"


def test_settings_write_disabled_without_flag(tmp_path):
    client, _ = _client(tmp_path, extra_sections="")  # no [security]
    with client:
        r = client.get("/api/settings")
        assert r.status_code == 200
        assert r.json()["edit_enabled"] is False
        r = client.put("/api/settings/engine.interval_s", json={"value": 60})
        assert r.status_code == 403 and "allow_web_edit" in r.json()["detail"]


def test_settings_put_delete_and_audit(tmp_path):
    client, url = _client(tmp_path)
    with client:
        r = client.put("/api/settings/poller.ping_interval_s", json={"value": 30})
        assert r.status_code == 200
        assert r.json()["value"] == 30 and r.json()["source"] == "override"

        # Validation: bounds + unknown key + bad bool.
        assert client.put("/api/settings/poller.ping_interval_s", json={"value": 1}).status_code == 422
        assert client.put("/api/settings/db.url", json={"value": "x"}).status_code == 404
        assert client.put("/api/settings/engine.shadow", json={"value": "maybe"}).status_code == 422

        rows = {s["key"]: s for g in client.get("/api/settings").json()["groups"]
                for s in g["settings"]}
        assert rows["poller.ping_interval_s"]["value"] == 30

        r = client.delete("/api/settings/poller.ping_interval_s")
        assert r.status_code == 200
        assert client.delete("/api/settings/poller.ping_interval_s").status_code == 404

        audit = client.get("/api/settings/audit").json()
        assert [a["action"] for a in audit] == ["clear", "set"]
        assert audit[1]["new_value"] == "30" and audit[1]["changed_by"] == "devadmin"


def test_settings_secret_sealed_and_never_returned(tmp_path):
    client, url = _client(tmp_path)
    with client:
        r = client.put("/api/settings/xiq.api_token", json={"value": "super-secret-token"})
        assert r.status_code == 200
        body = r.json()
        assert body["value"] is None and body["is_set"] is True
        assert "super-secret-token" not in r.text

        # At rest: sealed nmsb1 token, not the plaintext.
        engine = db.make_engine(url)
        row = db.fetch_one(engine, "SELECT value, is_secret FROM app_settings WHERE `key`='xiq.api_token'")
        assert row["is_secret"] == 1
        assert row["value"].startswith("nmsb1:") and "super-secret-token" not in row["value"]

        # Audit is redacted for secrets.
        audit = client.get("/api/settings/audit").json()
        assert audit[0]["old_value"] is None and audit[0]["new_value"] is None
        assert "super-secret-token" not in str(audit)

        # The whole settings payload never contains the secret.
        assert "super-secret-token" not in client.get("/api/settings").text
        engine.dispose()


def test_settings_secret_requires_settings_key(tmp_path):
    client, _ = _client(tmp_path, extra_sections="[security]\nallow_web_edit = true")
    with client:
        assert client.get("/api/settings").json()["secrets_enabled"] is False
        r = client.put("/api/settings/xiq.api_token", json={"value": "tok"})
        assert r.status_code == 409 and "settings_key" in r.json()["detail"]


def test_settings_apply_swaps_config_and_supervisor(tmp_path):
    client, url = _client(tmp_path)
    app = client.app
    with client:
        client.put("/api/settings/poller.ping_interval_s", json={"value": 30})
        # Startup overlay ran before the override existed.
        assert app.state.config.poller.ping_interval_s == 60

        r = client.post("/api/settings/apply")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "applied" and "heartbeat" in body["tasks"]
        assert app.state.config.poller.ping_interval_s == 30
        # Base (file) config is untouched — reset-to-file stays possible.
        assert app.state.base_config.poller.ping_interval_s == 60


def test_startup_overlay_applies_existing_overrides(tmp_path):
    url = f"sqlite:///{tmp_path / 'pre.db'}"
    _seed(url)
    engine = db.make_engine(url)
    db.execute(engine, "INSERT INTO app_settings (`key`, value, is_secret, updated_by) "
                       "VALUES ('engine.interval_s', '99', 0, 'test')")
    engine.dispose()
    conf = write_config(tmp_path, db_url=url, extra_sections=SECURITY)
    with TestClient(_app(conf)) as client:
        assert client.app.state.config.engine.interval_s == 99
