"""History ring buffer (spec 10.6): series builders, record/prune/read,
the sampler task, the /api/history endpoint, and the ≤24 h config guard."""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db, history
from netmon.app import create_app
from netmon.config import ConfigError, load_config
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config


def _seed(url):
    engine = db.make_engine(url)
    create_core_tables(engine)
    now = datetime.now(timezone.utc)
    with engine.begin() as c:
        c.execute(text(
            "INSERT INTO devices (name, site, device_type, enabled) VALUES "
            "('SW1','A','switch',1),('SW2','A','switch',1),"
            "('AP1','A','ap',1),('TRUNK','A','trunk',1)"))
        c.execute(text(
            "INSERT INTO switch_ports (device_id, ifindex, oper_state, in_kbps, out_kbps, updated_at) VALUES "
            "(1,1,'up',100,50,:n),(1,2,'down',0,0,:n),(2,1,'up',10,10,:n)"), {"n": now})
        c.execute(text(
            "INSERT INTO trunks (device_id, name, reg_status, ch_total, ch_in_use, updated_at) VALUES "
            "(4,'PRI','registered',23,7,:n)"), {"n": now})
        c.execute(text("INSERT INTO wireless_clients (mac, updated_at) VALUES ('aa:bb:cc:00:00:01',:n),('aa:bb:cc:00:00:02',:n)"), {"n": now})
        c.execute(text("INSERT INTO stack_members (device_id, slot, poe_measured_w, updated_at) VALUES (1,1,120,:n),(1,2,80,:n)"), {"n": now})
        c.execute(text("INSERT INTO alert_rules (id,name,dimension,`condition`,severity) VALUES (1,'r','ping','x','crit')"))
        c.execute(text("INSERT INTO alerts (device_id, rule_id, opened_at) VALUES (2,1,:n)"), {"n": now})

    def st(dev, dim, value, sev):
        db.upsert(engine, "device_state", {"device_id": dev, "dimension": dim},
                  {"value": value, "severity": sev, "source": "poller", "updated_at": now})
    st(1, "ping", "up", "ok")
    st(2, "ping", "down", "crit")
    st(3, "ping", "up", "ok")
    st(3, "source_status", "blind", "warn")
    # device 4 (trunk) has no ping row → counts as unknown
    return engine


def test_builders(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'h.db'}")
    fleet = history.build_fleet(engine)
    assert fleet == {"fleet.total": 4, "fleet.up": 2, "fleet.down": 1,
                     "fleet.unknown": 1, "fleet.blind": 1}
    assert history.build_alerts(engine) == {"alerts.open": 1.0, "alerts.crit": 1.0}
    voip = history.build_voip(engine)
    assert voip["voip.channels_in_use"] == 7 and voip["voip.channels_total"] == 23
    assert voip["voip.trunks_registered"] == 1
    misc = history.build_misc(engine)
    assert misc["wireless.clients"] == 2 and misc["poe.watts"] == 200
    sw = history.build_switches(engine)
    assert sw["sw.1.tput_kbps"] == 150 and sw["sw.1.ports_up"] == 1
    assert sw["sw.2.tput_kbps"] == 20 and sw["sw.2.ports_up"] == 1


def test_record_read_and_idempotent(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'h.db'}")
    ts = datetime.now(timezone.utc).replace(microsecond=0)
    assert history.record_many(engine, ts, {"fleet.up": 5, "fleet.down": 1}) == 2
    # Re-writing the same ts replaces, never collides on the (series, ts) PK.
    assert history.record_many(engine, ts, {"fleet.up": 6, "fleet.down": 1}) == 2
    got = history.read_series(engine, ["fleet.up", "fleet.down", "absent.series"])
    assert [p["value"] for p in got["fleet.up"]] == [6]
    assert got["absent.series"] == []      # requested-but-empty → stable []


def test_prune_drops_beyond_retention(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'h.db'}")
    now = datetime.now(timezone.utc).replace(microsecond=0)
    history.record_many(engine, now, {"fleet.up": 3})
    history.record_many(engine, now - timedelta(hours=25), {"fleet.up": 9})  # stale
    removed = history.prune(engine, 24, now=now)
    assert removed == 1
    pts = history.read_series(engine, ["fleet.up"], hours=24)["fleet.up"]
    assert [p["value"] for p in pts] == [3]


def test_sampler_run_once(tmp_path):
    engine = _seed(f"sqlite:///{tmp_path/'h.db'}")
    from netmon.config import HistoryConfig
    sampler = history.HistorySampler(engine, HistoryConfig(enabled=True, interval_s=300, retention_hours=24))
    written = sampler.run_once()
    assert written >= 12   # fleet(5)+alerts(2)+voip(3)+misc(2)+2 switches×2
    fleet = history.read_series(engine, ["fleet.up"])["fleet.up"]
    assert fleet and fleet[-1]["value"] == 2


def _app(conf):
    return create_app(config=load_config(conf), supervisor=Supervisor())


def test_history_api(tmp_path):
    url = f"sqlite:///{tmp_path/'h.db'}"
    engine = _seed(url)
    ts = datetime.now(timezone.utc).replace(microsecond=0)
    history.record_many(engine, ts, {"fleet.up": 2, "voip.channels_in_use": 7})
    with TestClient(_app(write_config(tmp_path, db_url=url))) as client:
        r = client.get("/api/history?series=fleet.up,voip.channels_in_use&hours=24")
        assert r.status_code == 200
        data = r.json()
        assert data["hours"] == 24
        assert data["series"]["fleet.up"][0]["value"] == 2
        assert data["series"]["voip.channels_in_use"][0]["value"] == 7


def test_history_api_requires_auth(tmp_path):
    url = f"sqlite:///{tmp_path/'h.db'}"
    _seed(url)
    conf = write_config(tmp_path, dev_bypass=False, db_url=url)
    with TestClient(_app(conf)) as client:
        assert client.get("/api/history?series=fleet.up").status_code == 401


def test_retention_capped_at_24h(tmp_path):
    # The charter exception is bounded — a >24 h retention is refused, not clamped.
    conf = write_config(tmp_path, extra_sections="[history]\nenabled = true\nretention_hours = 48\n")
    with pytest.raises(ConfigError):
        load_config(conf)


def test_history_interval_floor(tmp_path):
    conf = write_config(tmp_path, extra_sections="[history]\nenabled = true\ninterval_s = 5\n")
    with pytest.raises(ConfigError):
        load_config(conf)
