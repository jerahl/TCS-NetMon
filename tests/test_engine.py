import asyncio
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from netmon import db
from netmon.config import EngineConfig
from netmon.engine.engine import AlertEngine
from netmon.engine.rules import evaluate
from tests.conftest import create_core_tables


def test_rule_evaluate_ops():
    assert evaluate('{"op":"eq","value":"down"}', "down") is True
    assert evaluate('{"op":"eq","value":"down"}', "up") is False
    assert evaluate('{"op":"ne","value":"up"}', "down") is True
    assert evaluate({"op": "in", "value": ["down", "blind"]}, "blind") is True
    assert evaluate('{"op":"contains","value":"err"}', "errors") is True
    assert evaluate('{"bogus":true}', "down") is False  # fail closed


def _db(tmp_path):
    e = db.make_engine(f"sqlite:///{tmp_path / 'engine.db'}")
    create_core_tables(e)
    with e.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, enabled) VALUES ('SW1','BHS','switch',1)"
        ))
        conn.execute(text(
            "INSERT INTO alert_rules (name, dimension, `condition`, severity, min_duration_s, enabled) "
            "VALUES ('device_down','ping','{\"op\":\"eq\",\"value\":\"down\"}','crit',0,1)"
        ))
    return e


def _set_state(engine, device_id, value, changed_ago_s=0):
    now = datetime.now(timezone.utc)
    db.upsert(engine, "device_state", {"device_id": device_id, "dimension": "ping"},
              {"value": value, "severity": "crit", "source": "poller", "updated_at": now})
    # One transition into the current value (clear prior events so MAX(occurred_at)
    # reflects when *this* value began — as it would in real operation).
    db.execute(engine, "DELETE FROM state_events WHERE device_id = :d AND dimension = 'ping'",
               {"d": device_id})
    db.execute(engine,
               "INSERT INTO state_events (device_id, dimension, old_value, new_value, severity, source, occurred_at) "
               "VALUES (:d,'ping','up',:v,'crit','poller',:t)",
               {"d": device_id, "v": value, "t": now - timedelta(seconds=changed_ago_s)})


def _cfg():
    return EngineConfig(enabled=True, interval_s=30, shadow=True)


def test_engine_opens_dedupes_and_closes(tmp_path):
    engine = _db(tmp_path)
    eng = AlertEngine(engine, _cfg())

    _set_state(engine, 1, "down")
    assert asyncio.run(eng.run_once()) == 1  # opened + 1 shadow notification
    opens = db.fetch_all(engine, "SELECT * FROM alerts WHERE closed_at IS NULL")
    assert len(opens) == 1
    notes = db.fetch_all(engine, "SELECT * FROM notifications")
    assert len(notes) == 1 and notes[0]["shadow"] == 1  # shadow, not sent

    # Second cycle, still down → refire (no new alert, no new notification).
    assert asyncio.run(eng.run_once()) == 0
    assert len(db.fetch_all(engine, "SELECT * FROM alerts WHERE closed_at IS NULL")) == 1
    assert len(db.fetch_all(engine, "SELECT * FROM notifications")) == 1

    # Device recovers → alert closes.
    _set_state(engine, 1, "up")
    asyncio.run(eng.run_once())
    assert len(db.fetch_all(engine, "SELECT * FROM alerts WHERE closed_at IS NULL")) == 0


def test_engine_min_duration_gate(tmp_path):
    engine = _db(tmp_path)
    # Raise the rule's min_duration to 300s.
    db.execute(engine, "UPDATE alert_rules SET min_duration_s = 300 WHERE name='device_down'")
    eng = AlertEngine(engine, _cfg())

    _set_state(engine, 1, "down", changed_ago_s=10)   # only down 10s
    assert asyncio.run(eng.run_once()) == 0            # gated — not yet
    assert len(db.fetch_all(engine, "SELECT * FROM alerts")) == 0

    _set_state(engine, 1, "down", changed_ago_s=600)   # down 10 min
    assert asyncio.run(eng.run_once()) == 1            # now fires


def test_engine_maintenance_suppresses_notification(tmp_path):
    engine = _db(tmp_path)
    eng = AlertEngine(engine, _cfg())
    now = datetime.now(timezone.utc)
    db.execute(engine,
               "INSERT INTO maintenance_windows (scope_type, scope_value, starts_at, ends_at, created_by) "
               "VALUES ('site','BHS',:s,:e,'op')",
               {"s": now - timedelta(hours=1), "e": now + timedelta(hours=1)})

    _set_state(engine, 1, "down")
    asyncio.run(eng.run_once())
    # Alert still opens (recording), but the notification is suppressed (shadow=1 + note).
    assert len(db.fetch_all(engine, "SELECT * FROM alerts WHERE closed_at IS NULL")) == 1
    note = db.fetch_one(engine, "SELECT * FROM notifications")
    assert note["shadow"] == 1
    assert "suppressed: maintenance" in (note["payload_summary"] or "")
