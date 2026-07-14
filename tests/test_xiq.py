import asyncio

from sqlalchemy import text

from netmon import db
from netmon.collectors.xiq import XiqCollector
from netmon.collectors.xiq_client import XiqAuthError, XiqRateLimitError
from netmon.models.xiq import XiqDevice
from tests.conftest import create_core_tables


def test_xiqdevice_parse_and_mac_normalization():
    d = XiqDevice.model_validate({
        "id": 100001, "hostname": "BHS-56-Hallway", "connected": True,
        "ip_address": "192.0.2.11", "mac_address": "aabbcc000011",
        "product_type": "AP305C", "unexpected_field": "ignored",
    })
    assert d.id == 100001
    assert d.connected is True
    assert d.mac_address == "AA:BB:CC:00:00:11"  # G3 colon-normalized
    assert d.ip_address == "192.0.2.11"


class FakeXiq:
    """Injected XIQ client: returns rows, or raises a configured exception."""

    def __init__(self):
        self.rows: list[dict] = []
        self.exc: Exception | None = None
        self.rate_limit_remaining = None

    async def get_devices(self, view: str = "BASIC") -> list[dict]:
        if self.exc is not None:
            raise self.exc
        return self.rows


def _db(tmp_path):
    engine = db.make_engine(f"sqlite:///{tmp_path / 'xiq.db'}")
    create_core_tables(engine)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, mgmt_ip, snmp_capable, enabled, xiq_device_id) "
            "VALUES ('BHS-56-Hallway','BHS','ap','',0,1,'100001'),"
            "       ('BHS-Core-1','BHS','switch','192.0.2.2',1,1,'100002')"
        ))
    return engine


def _status(engine):
    return {
        r["xiq_device_id"]: r
        for r in db.fetch_all(
            engine,
            "SELECT d.xiq_device_id, s.value, s.severity FROM devices d "
            "JOIN device_state s ON s.device_id = d.id AND s.dimension='source_status'",
        )
    }


def test_xiq_collector_writes_source_status_and_backfills_ip(tmp_path):
    engine = _db(tmp_path)
    fake = FakeXiq()
    fake.rows = [
        {"id": 100001, "connected": True, "ip_address": "192.0.2.11"},
        {"id": 100002, "connected": False},
    ]
    collector = XiqCollector(engine, fake)
    n = asyncio.run(collector.run_once())
    assert n == 2

    st = _status(engine)
    assert st["100001"]["value"] == "up" and st["100001"]["severity"] == "ok"
    assert st["100002"]["value"] == "down" and st["100002"]["severity"] == "crit"

    # First observations recorded as transitions from unknown.
    evs = db.fetch_all(engine, "SELECT old_value,new_value FROM state_events ORDER BY id")
    assert {(e["old_value"], e["new_value"]) for e in evs} == {("unknown", "up"), ("unknown", "down")}

    # mgmt_ip backfilled from XIQ where empty; existing value untouched.
    ips = {r["xiq_device_id"]: r["mgmt_ip"] for r in db.fetch_all(engine, "SELECT xiq_device_id, mgmt_ip FROM devices")}
    assert ips["100001"] == "192.0.2.11"
    assert ips["100002"] == "192.0.2.2"


def test_xiq_token_revocation_marks_blind_loud(tmp_path):
    engine = _db(tmp_path)
    fake = FakeXiq()
    fake.rows = [{"id": 100001, "connected": True}, {"id": 100002, "connected": True}]
    collector = XiqCollector(engine, fake)
    asyncio.run(collector.run_once())  # both up

    # Token revoked → 401 on the next cycle.
    fake.exc = XiqAuthError("XIQ 401 — token revoked or invalid")
    asyncio.run(collector.run_guarded())  # guarded: records health, does not raise out

    st = _status(engine)
    # No stale-as-fresh: previously-up devices are now blind, not up.
    assert st["100001"]["value"] == "blind" and st["100001"]["severity"] == "warn"
    assert st["100002"]["value"] == "blind"
    evs = db.fetch_all(engine, "SELECT new_value FROM state_events WHERE new_value='blind'")
    assert len(evs) == 2  # up→blind for both

    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='xiq'")
    assert h["consecutive_failures"] == 1
    assert "401" in (h["last_error"] or "")


def test_xiq_rate_limit_does_not_blind(tmp_path):
    engine = _db(tmp_path)
    fake = FakeXiq()
    fake.rows = [{"id": 100001, "connected": True}, {"id": 100002, "connected": True}]
    collector = XiqCollector(engine, fake)
    asyncio.run(collector.run_once())  # both up

    fake.exc = XiqRateLimitError("XIQ 429 — rate limit exceeded")
    asyncio.run(collector.run_guarded())

    st = _status(engine)
    # Throttled ≠ blind: healthy state preserved.
    assert st["100001"]["value"] == "up"
    assert st["100002"]["value"] == "up"
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='xiq'")
    assert h["consecutive_failures"] == 1  # recorded as an error, but no blinding
