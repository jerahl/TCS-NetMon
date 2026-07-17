"""Events console API: filters on the flat feed + the 24 h stats histogram."""

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
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, enabled) VALUES "
            "('BHS-Core-1','BHS','switch',1),"
            "('CHS-Cam-1','CHS','camera',1)"
        ))
        # Three transitions across two devices/sites/sources/severities.
        conn.execute(
            text("INSERT INTO state_events "
                 "(device_id, dimension, old_value, new_value, severity, source, occurred_at) "
                 "VALUES (:d,:dim,:o,:n,:sev,:src,:t)"),
            [
                {"d": 1, "dim": "ping", "o": "up", "n": "down", "sev": "crit",
                 "src": "poller", "t": now - timedelta(hours=2)},
                {"d": 1, "dim": "snmp", "o": "up", "n": "down", "sev": "warn",
                 "src": "poller", "t": now - timedelta(hours=1)},
                {"d": 2, "dim": "recording", "o": "recording", "n": "stopped",
                 "sev": "crit", "src": "milestone", "t": now - timedelta(minutes=5)},
            ],
        )
    engine.dispose()


def _app(conf):
    return create_app(config=load_config(conf), supervisor=Supervisor())


def test_events_default_feed(tmp_path):
    url = f"sqlite:///{tmp_path/'e.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        events = client.get("/api/events").json()
        assert len(events) == 3
        # Newest first; enriched with device_id + device_type.
        assert events[0]["device"] == "CHS-Cam-1"
        assert events[0]["device_type"] == "camera"
        assert events[0]["device_id"] == 2
        assert events[0]["site"] == "CHS"


def test_events_filters(tmp_path):
    url = f"sqlite:///{tmp_path/'e.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        assert len(client.get("/api/events?severity=crit").json()) == 2
        assert len(client.get("/api/events?source=milestone").json()) == 1
        assert len(client.get("/api/events?site=BHS").json()) == 2
        assert len(client.get("/api/events?device_type=camera").json()) == 1
        # exclude_device_type drops a whole type (the map hides AP noise this way).
        assert len(client.get("/api/events?exclude_device_type=camera").json()) == 2
        assert len(client.get("/api/events?exclude_device_type=switch").json()) == 1
        assert len(client.get("/api/events?dimension=snmp").json()) == 1
        # q matches device name and new_value.
        assert len(client.get("/api/events?q=CHS").json()) == 1
        assert len(client.get("/api/events?q=stopped").json()) == 1
        # offset paginates within the DESC feed.
        page = client.get("/api/events?limit=1&offset=1").json()
        assert len(page) == 1 and page[0]["device"] == "BHS-Core-1"


def test_events_stats(tmp_path):
    url = f"sqlite:///{tmp_path/'e.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        stats = client.get("/api/events/stats").json()
        assert stats["total"] == 3
        assert stats["by_severity"]["crit"] == 2
        assert stats["by_severity"]["warn"] == 1
        assert stats["window_hours"] == 24
        # Buckets span the window and sum back to the total.
        assert sum(b["total"] for b in stats["buckets"]) == 3
        # A narrow window drops the older events.
        narrow = client.get("/api/events/stats?window_hours=1").json()
        assert narrow["total"] == 1  # only the 5-min-ago camera event


def test_events_requires_auth(tmp_path):
    url = f"sqlite:///{tmp_path/'e.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(_app(conf)) as client:
        assert client.get("/api/events").status_code == 401
        assert client.get("/api/events/stats").status_code == 401
