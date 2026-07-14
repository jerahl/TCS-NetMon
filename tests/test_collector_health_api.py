"""/api/collector-health: source-health pills + derived status."""

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
        conn.execute(
            text("INSERT INTO collector_health "
                 "(name, last_start, last_success, last_error, consecutive_failures, updated_at) "
                 "VALUES (:n,:st,:su,:er,:cf,:up)"),
            [
                {"n": "xiq", "st": now, "su": now, "er": None, "cf": 0, "up": now},
                {"n": "milestone", "st": now, "su": now, "er": "token revoked", "cf": 3, "up": now},
                {"n": "rconfig", "st": now, "su": None, "er": None, "cf": 0, "up": now},
            ],
        )
    engine.dispose()


def _app(conf):
    return create_app(config=load_config(conf), supervisor=Supervisor())


def test_collector_health(tmp_path):
    url = f"sqlite:///{tmp_path/'ch.db'}"
    _seed(url)
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        rows = {r["name"]: r for r in client.get("/api/collector-health").json()}
        assert rows["xiq"]["status"] == "ok"
        # Failing collector reads error even though it once succeeded (fail loud).
        assert rows["milestone"]["status"] == "error"
        assert rows["milestone"]["last_error"] == "token revoked"
        assert rows["milestone"]["consecutive_failures"] == 3
        # Never-succeeded collector is unknown, never ok.
        assert rows["rconfig"]["status"] == "unknown"


def test_collector_health_requires_auth(tmp_path):
    url = f"sqlite:///{tmp_path/'ch.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(_app(conf)) as client:
        assert client.get("/api/collector-health").status_code == 401
