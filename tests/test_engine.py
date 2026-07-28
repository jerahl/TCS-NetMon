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


def _source_rule(engine):
    """Add the two source_status rules the deploy VM actually runs."""
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO alert_rules (name, dimension, `condition`, severity, min_duration_s, enabled) "
            "VALUES ('device_source_down','source_status','{\"op\":\"eq\",\"value\":\"down\"}','crit',0,1)"
        ))
        conn.execute(text(
            "INSERT INTO alert_rules (name, dimension, `condition`, severity, min_duration_s, enabled) "
            "VALUES ('source_blind','source_status','{\"op\":\"eq\",\"value\":\"blind\"}','warn',0,1)"
        ))


def _set_dim(engine, device_id, dimension, value):
    db.upsert(engine, "device_state", {"device_id": device_id, "dimension": dimension},
              {"value": value, "severity": "crit", "source": "test",
               "updated_at": datetime.now(timezone.utc)})


def test_source_down_yields_to_a_native_probe(tmp_path):
    """A source's `down` is a claim; the native poller is the tiebreaker.

    Regression (2026-07-28): 4 of 55 open alerts were devices the UI showed as
    up — the engine read source_status in isolation while rollup_site applied
    the tiebreaker, so the site card said `up` next to `problems=1 crit`.
    """
    engine = _db(tmp_path)
    _source_rule(engine)
    eng = AlertEngine(engine, _cfg())

    # XIQ says down, but the device answers SNMP.
    _set_dim(engine, 1, "source_status", "down")
    _set_dim(engine, 1, "snmp", "up")
    asyncio.run(eng.run_once())
    assert db.fetch_all(engine, "SELECT * FROM alerts WHERE closed_at IS NULL") == []


def test_source_down_alerts_when_no_native_probe_contradicts(tmp_path):
    """With no native evidence, the source is all we have — it must still alert."""
    engine = _db(tmp_path)
    _source_rule(engine)
    eng = AlertEngine(engine, _cfg())

    _set_dim(engine, 1, "source_status", "down")   # no ping/snmp row at all
    asyncio.run(eng.run_once())
    open_rows = db.fetch_all(engine, "SELECT * FROM alerts WHERE closed_at IS NULL")
    assert len(open_rows) == 1


def test_ping_down_beats_snmp_up_for_alerting(tmp_path):
    """ping = down stays authoritative — the contradiction must surface."""
    engine = _db(tmp_path)
    _source_rule(engine)
    eng = AlertEngine(engine, _cfg())

    _set_dim(engine, 1, "source_status", "down")
    _set_dim(engine, 1, "snmp", "up")
    _set_dim(engine, 1, "ping", "down")
    asyncio.run(eng.run_once())
    # Both the source_down and the ping-dimension rule fire; neither is suppressed.
    assert len(db.fetch_all(engine, "SELECT * FROM alerts WHERE closed_at IS NULL")) == 2


def test_source_blind_is_not_subject_to_the_tiebreaker(tmp_path):
    """`blind` must alert on its own.

    A blind source is precisely the case where no native probe can vouch for
    anything, so gating the whole source_status dimension on device_down would
    silence the one alert that says "we cannot see".
    """
    engine = _db(tmp_path)
    _source_rule(engine)
    eng = AlertEngine(engine, _cfg())

    _set_dim(engine, 1, "source_status", "blind")
    _set_dim(engine, 1, "ping", "up")        # device is reachable...
    asyncio.run(eng.run_once())
    rows = db.fetch_all(
        engine,
        "SELECT r.name FROM alerts a JOIN alert_rules r ON r.id = a.rule_id "
        "WHERE a.closed_at IS NULL",
    )
    assert [r["name"] for r in rows] == ["source_blind"]  # ...yet still alerts


def test_disabling_a_rule_closes_its_orphaned_alerts(tmp_path):
    """_close_resolved only ran inside the enabled-rule loop, so a disabled rule
    used to leave its open alerts open forever, inflating Problems counts."""
    engine = _db(tmp_path)
    eng = AlertEngine(engine, _cfg())

    _set_state(engine, 1, "down")
    asyncio.run(eng.run_once())
    assert len(db.fetch_all(engine, "SELECT * FROM alerts WHERE closed_at IS NULL")) == 1

    db.execute(engine, "UPDATE alert_rules SET enabled = 0 WHERE name = 'device_down'")
    asyncio.run(eng.run_once())
    assert db.fetch_all(engine, "SELECT * FROM alerts WHERE closed_at IS NULL") == []


def test_deleted_rule_closes_its_orphaned_alerts(tmp_path):
    engine = _db(tmp_path)
    eng = AlertEngine(engine, _cfg())

    _set_state(engine, 1, "down")
    asyncio.run(eng.run_once())
    db.execute(engine, "DELETE FROM alert_rules WHERE name = 'device_down'")
    asyncio.run(eng.run_once())
    assert db.fetch_all(engine, "SELECT * FROM alerts WHERE closed_at IS NULL") == []


def test_contested_ip_verdict_cannot_vouch_for_a_dead_device(tmp_path):
    """A shared-address probe must not close an alert.

    Regression (2026-07-28): rows written before the poller's ambiguous-IP
    guard existed closed 15 source_down alerts, including devices named
    `oak-DEAD` and `DEAD_AP` — a live neighbour answering at the same address
    vouched for hardware that was unplugged.
    """
    from netmon.state import device_down, device_reachable

    dead = {"source_down": 1, "ping_up": 1, "has_state": 1, "ip_claimants": 2}
    assert device_down(dead) is True, "the source's down must stand"

    sole = {"source_down": 1, "ping_up": 1, "has_state": 1, "ip_claimants": 1}
    assert device_down(sole) is False, "a trustworthy ping still wins"

    # A device whose ONLY evidence is a contested probe is unknown, not up.
    only_contested = {"ping_up": 1, "has_state": 1, "ip_claimants": 2}
    assert device_reachable(only_contested) is False
    assert device_down(only_contested) is False

    # A contested ping=down must not mark a device down either — it may be the
    # neighbour that is unreachable.
    contested_down = {"ping_down": 1, "has_state": 1, "ip_claimants": 3}
    assert device_down(contested_down) is False

    # Missing column => legacy caller => trusted, so behaviour is unchanged.
    legacy = {"source_down": 1, "ping_up": 1, "has_state": 1}
    assert device_down(legacy) is False
