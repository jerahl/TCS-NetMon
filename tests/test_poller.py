import asyncio

from sqlalchemy import text

from netmon import db
from netmon.config import PollerConfig
from netmon.poller.poller import Poller
from tests.conftest import create_core_tables


def _make_db(tmp_path):
    engine = db.make_engine(f"sqlite:///{tmp_path / 'poll.db'}")
    create_core_tables(engine)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, mgmt_ip, snmp_capable, enabled) "
            "VALUES ('BHS-56-Hallway','BHS','ap','192.0.2.11',0,1)"
        ))
    return engine


def _events(engine):
    return db.fetch_all(
        engine,
        "SELECT old_value, new_value, severity FROM state_events "
        "WHERE dimension='ping' ORDER BY id",
    )


def test_poller_down_up_cycle_and_health(tmp_path):
    engine = _make_db(tmp_path)
    cfg = PollerConfig(enabled=True, fail_threshold=3, ok_threshold=2)

    alive = {"v": True}

    async def fake_ping(ips, _cfg):
        return {ip: alive["v"] for ip in ips}

    poller = Poller(engine, cfg, ping_sweep=fake_ping)

    async def scenario():
        await poller.run_ping()            # unknown -> up (immediate)
        alive["v"] = False
        await poller.run_ping()            # fail 1 (still up)
        await poller.run_ping()            # fail 2 (still up)
        await poller.run_ping()            # fail 3 -> down
        alive["v"] = True
        await poller.run_ping()            # ok 1 (still down)
        await poller.run_ping()            # ok 2 -> up

    asyncio.run(scenario())

    # device_state settled back to up/ok.
    st = db.fetch_one(
        engine,
        "SELECT value, severity, source FROM device_state WHERE dimension='ping'",
    )
    assert st["value"] == "up" and st["severity"] == "ok" and st["source"] == "poller"

    # Exactly three transitions were logged (transients damped).
    evs = _events(engine)
    assert [(e["old_value"], e["new_value"]) for e in evs] == [
        ("unknown", "up"),
        ("up", "down"),
        ("down", "up"),
    ]
    assert evs[1]["severity"] == "crit"  # ping down is critical

    # Heartbeat recorded success.
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='poller_ping'")
    assert h["records_written"] == 1
    assert h["consecutive_failures"] == 0
    assert h["last_success"] is not None


def test_poller_error_is_recorded_loud(tmp_path):
    engine = _make_db(tmp_path)
    cfg = PollerConfig(enabled=True)

    async def boom(ips, _cfg):
        raise RuntimeError("fping exploded")

    poller = Poller(engine, cfg, ping_sweep=boom)
    asyncio.run(poller.run_ping())

    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='poller_ping'")
    assert h["consecutive_failures"] == 1
    assert "fping exploded" in (h["last_error"] or "")
    # Prior state was not fabricated.
    assert db.fetch_one(engine, "SELECT * FROM device_state") is None


def test_snmp_sweep_skips_without_community(tmp_path):
    engine = _make_db(tmp_path)
    cfg = PollerConfig(enabled=True, snmp_community="")  # unset
    called = {"n": 0}

    async def fake_snmp(ips, _cfg):
        called["n"] += 1
        return {ip: True for ip in ips}

    poller = Poller(engine, cfg, snmp_sweep=fake_snmp)
    n = asyncio.run(poller.sweep_snmp())
    assert n == 0 and called["n"] == 0  # skipped, prober never invoked
