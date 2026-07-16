"""/api/netmon-status + /api/meta: the NetMon Status page feed (spec 11 D2)."""

from datetime import datetime, timedelta, timezone

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
    old = now - timedelta(hours=30)
    with engine.begin() as conn:
        conn.execute(
            text("INSERT INTO devices (name, site, device_type, enabled) "
                 "VALUES (:n, :s, :t, :e)"),
            [
                {"n": "sw-1", "s": "Central", "t": "switch", "e": 1},
                {"n": "ap-1", "s": "Central", "t": "ap", "e": 1},
                {"n": "cam-old", "s": "North", "t": "camera", "e": 0},
            ],
        )
        conn.execute(
            text("INSERT INTO device_state (device_id, dimension, value, severity, source, updated_at) "
                 "VALUES (1, 'ping', 'up', 'ok', 'poller', :up)"),
            {"up": now},
        )
        conn.execute(
            text("INSERT INTO state_events (device_id, dimension, old_value, new_value, severity, source, occurred_at) "
                 "VALUES (1, 'ping', :o, :n, 'ok', 'poller', :at)"),
            [
                {"o": "down", "n": "up", "at": now},
                {"o": "up", "n": "down", "at": old},  # outside the 24 h window
            ],
        )
        conn.execute(
            text("INSERT INTO alert_rules (name, dimension, `condition`) VALUES ('r', 'ping', 'down')"))
        conn.execute(
            text("INSERT INTO alerts (device_id, rule_id, opened_at, closed_at) VALUES "
                 "(1, 1, :at, NULL), (2, 1, :at, :at)"),
            {"at": now},
        )
        conn.execute(
            text("INSERT INTO notifications (alert_id, target, shadow) VALUES (1, 'noc@example', 1)"))
        conn.execute(
            text("INSERT INTO collector_health (name, last_success, consecutive_failures, updated_at) "
                 "VALUES ('xiq', :s, 0, :s), ('milestone', NULL, 2, :s)"),
            {"s": now},
        )
    engine.dispose()


def _app(conf, supervisor=None):
    return create_app(config=load_config(conf), supervisor=supervisor or Supervisor())


def test_netmon_status(tmp_path):
    url = f"sqlite:///{tmp_path/'ns.db'}"
    _seed(url)
    supervisor = Supervisor()

    async def _noop() -> None:
        return None

    supervisor.register("poller_ping", _noop, interval_s=60, timeout_s=60)
    supervisor.register("xiq", _noop, interval_s=180, timeout_s=180, enabled=False)

    with TestClient(_app(write_config(tmp_path, db_url=url), supervisor)) as client:
        body = client.get("/api/netmon-status").json()

        assert body["db_ok"] is True
        assert body["uptime_s"] is not None and body["uptime_s"] >= 0
        # Engine/poller flags mirror config (both default off in the test conf).
        assert body["engine_enabled"] is False
        assert body["engine_shadow"] is True

        tasks = {t["name"]: t for t in body["tasks"]}
        # The lifespan registers the heartbeat alongside the injected specs.
        assert "heartbeat" in tasks and tasks["heartbeat"]["running"] is True
        assert tasks["poller_ping"]["interval_s"] == 60
        assert tasks["poller_ping"]["running"] is True
        # A config-disabled task is listed but not running (per-step reversibility).
        assert tasks["xiq"]["enabled"] is False and tasks["xiq"]["running"] is False

        collectors = {c["name"]: c for c in body["collectors"]}
        assert collectors["xiq"]["status"] == "ok"
        assert collectors["milestone"]["status"] == "error"

        stats = body["db"]
        assert stats["devices_total"] == 3
        assert stats["devices_enabled"] == 2
        assert stats["state_rows"] == 1
        assert stats["events_total"] == 2
        assert stats["events_24h"] == 1  # the 30 h-old event is outside the window
        assert stats["alerts_open"] == 1
        assert stats["notifications_shadow"] == 1


def test_meta(tmp_path):
    url = f"sqlite:///{tmp_path/'ns.db'}"
    _seed(url)
    conf = tmp_path / "netmon.conf"
    conf.write_text(
        f"[db]\nurl = {url}\n\n"
        "[web]\nzabbix_url = https://zabbix.example/\nssheasy_url = https://ssh.example/\n\n"
        "[auth]\ndev_bypass_user = devadmin\ndev_bypass_role = admin\n"
    )
    with TestClient(_app(conf)) as client:
        body = client.get("/api/meta").json()
        assert body["zabbix_url"] == "https://zabbix.example"  # trailing / stripped
        assert body["ssheasy_url"] == "https://ssh.example"    # trailing / stripped
        assert body["version"]


def test_netmon_status_requires_auth(tmp_path):
    url = f"sqlite:///{tmp_path/'ns.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(_app(conf)) as client:
        assert client.get("/api/netmon-status").status_code == 401
        assert client.get("/api/meta").status_code == 401
