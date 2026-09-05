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


def test_blind_ping_sweep_is_a_failure_not_a_success(tmp_path):
    """0 verdicts for a non-empty target list = the probe never ran.

    Regression: fping without CAP_NET_RAW exits instantly with "can't create
    socket", the parser finds no lines, and this recorded as success/0 rows —
    so a poller that had never once worked looked healthy for eleven days.
    """
    engine = _make_db(tmp_path)
    cfg = PollerConfig(enabled=True)

    async def no_verdicts(ips, _cfg):
        assert ips, "target list should be non-empty"
        return {}

    poller = Poller(engine, cfg, ping_sweep=no_verdicts)
    asyncio.run(poller.run_ping())

    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='poller_ping'")
    assert h["consecutive_failures"] == 1
    assert h["last_success"] is None
    assert "0 verdicts" in (h["last_error"] or "")
    assert "CAP_NET_RAW" in (h["last_error"] or "")
    # Blind must not fabricate state.
    assert db.fetch_one(engine, "SELECT * FROM device_state") is None


def test_all_targets_down_is_still_a_success(tmp_path):
    """The guard must not fire on a real outage — down targets have verdicts."""
    engine = _make_db(tmp_path)
    cfg = PollerConfig(enabled=True, fail_threshold=1)

    async def all_down(ips, _cfg):
        return {ip: False for ip in ips}

    poller = Poller(engine, cfg, ping_sweep=all_down)
    asyncio.run(poller.run_ping())

    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='poller_ping'")
    assert h["consecutive_failures"] == 0
    assert h["last_success"] is not None and h["records_written"] == 1
    assert db.fetch_one(engine, "SELECT value FROM device_state")["value"] == "down"


def test_no_targets_is_not_a_blind_sweep(tmp_path):
    """An empty registry is legitimately nothing to do, not a failure."""
    engine = db.make_engine(f"sqlite:///{tmp_path / 'empty.db'}")
    create_core_tables(engine)  # no devices inserted
    cfg = PollerConfig(enabled=True)

    async def never_called(ips, _cfg):
        return {}

    poller = Poller(engine, cfg, ping_sweep=never_called)
    asyncio.run(poller.run_ping())

    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='poller_ping'")
    assert h["consecutive_failures"] == 0
    assert h["last_success"] is not None and h["records_written"] == 0


def test_shared_mgmt_ip_gets_no_verdict(tmp_path):
    """One probe cannot say WHICH device answered at a shared address.

    Regression (2026-07-28): verdicts are keyed by IP and were written to every
    enabled row claiming it, so a decommissioned switch read `up` because its
    replacement answers at the same address — 34 rows across 17 duplicated IPs
    were affected in production.
    """
    engine = _make_db(tmp_path)
    with engine.begin() as conn:
        # A second enabled device claiming the SAME address as the fixture's.
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, mgmt_ip, snmp_capable, enabled) "
            "VALUES ('BHS-DEAD-AP','BHS','ap','192.0.2.11',0,1)"
        ))
        # …and one unambiguous device, which must still be written.
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, mgmt_ip, snmp_capable, enabled) "
            "VALUES ('BHS-56-Office','BHS','ap','192.0.2.12',0,1)"
        ))
    cfg = PollerConfig(enabled=True)

    async def all_alive(ips, _cfg):
        return {ip: True for ip in ips}

    poller = Poller(engine, cfg, ping_sweep=all_alive)
    written = asyncio.run(poller.sweep_ping())

    assert written == 1, "only the unambiguous device should be written"
    rows = db.fetch_all(engine, "SELECT d.name, s.value FROM device_state s "
                                "JOIN devices d ON d.id = s.device_id")
    assert [(r["name"], r["value"]) for r in rows] == [("BHS-56-Office", "up")]
    # The contested address produced no state at all — not a guess either way.
    assert not any(r["name"] in ("BHS-56-Hallway", "BHS-DEAD-AP") for r in rows)


def test_shared_ip_still_counts_as_a_non_blind_sweep(tmp_path):
    """Refusing ambiguous verdicts must not look like a blind probe.

    If every target were ambiguous, `written` is 0 — but fping DID return
    verdicts, so this is not SweepBlindError territory and must not be
    recorded as a failure.
    """
    engine = _make_db(tmp_path)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, mgmt_ip, snmp_capable, enabled) "
            "VALUES ('BHS-DEAD-AP','BHS','ap','192.0.2.11',0,1)"
        ))
    cfg = PollerConfig(enabled=True)

    async def all_alive(ips, _cfg):
        return {ip: True for ip in ips}

    poller = Poller(engine, cfg, ping_sweep=all_alive)
    asyncio.run(poller.run_ping())

    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='poller_ping'")
    assert h["consecutive_failures"] == 0
    assert h["last_success"] is not None and h["records_written"] == 0
    assert db.fetch_one(engine, "SELECT * FROM device_state") is None


def test_disabled_device_does_not_make_an_ip_ambiguous(tmp_path):
    """Only *enabled* rows contend — disabling the stale duplicate is the fix,
    and it must restore verdicts for the surviving device."""
    engine = _make_db(tmp_path)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, mgmt_ip, snmp_capable, enabled) "
            "VALUES ('BHS-DEAD-AP','BHS','ap','192.0.2.11',0,0)"   # enabled = 0
        ))
    cfg = PollerConfig(enabled=True)

    async def all_alive(ips, _cfg):
        return {ip: True for ip in ips}

    poller = Poller(engine, cfg, ping_sweep=all_alive)
    assert asyncio.run(poller.sweep_ping()) == 1
    assert db.fetch_one(engine, "SELECT value FROM device_state")["value"] == "up"


def test_ambiguous_ips_counts_physical_devices_not_rows():
    """Camera rows of one device are not rivals for its address.

    Milestone models a camera as a channel of a hardware record, and 61 devices
    on this estate carry more than one — an AXIS M3007 panoramic carries eleven,
    all behind a single network interface. Counting rows made those eleven look
    like eleven claimants and refused a verdict that was never in doubt,
    stranding 239 cameras at unknown.
    """
    from netmon.poller.poller import Poller

    eleven_channels = [{"id": i, "mgmt_ip": "10.88.18.190", "hardware_id": "HW1"}
                       for i in range(1, 12)]
    assert Poller._ambiguous_ips(eleven_channels) == set()

    # Two *different* devices on one address is the case the guard exists for
    # (oak-DEAD / DEAD_AP, 2026-07-28) and must still be refused.
    two_devices = [{"id": 1, "mgmt_ip": "10.0.0.9", "hardware_id": None},
                   {"id": 2, "mgmt_ip": "10.0.0.9", "hardware_id": None}]
    assert Poller._ambiguous_ips(two_devices) == {"10.0.0.9"}

    # Two different cameras on one address — the live 10.132.18.209 case, where
    # a Bosch 5000i and 5100i are both registered. Still ambiguous.
    two_cameras = [{"id": 3, "mgmt_ip": "10.132.18.209", "hardware_id": "HWa"},
                   {"id": 4, "mgmt_ip": "10.132.18.209", "hardware_id": "HWb"}]
    assert Poller._ambiguous_ips(two_cameras) == {"10.132.18.209"}

    # A camera sharing an address with a switch is a genuine conflict too.
    mixed = [{"id": 5, "mgmt_ip": "10.0.0.5", "hardware_id": "HW1"},
             {"id": 6, "mgmt_ip": "10.0.0.5", "hardware_id": None}]
    assert Poller._ambiguous_ips(mixed) == {"10.0.0.5"}
