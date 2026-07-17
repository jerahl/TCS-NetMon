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
        self.client_rows: list[dict] = []
        self.policies: list[dict] = []
        self.policy_ssids: dict[int, list[dict]] = {}
        self.exc: Exception | None = None
        self.rate_limit_remaining = None
        self.device_views: list[str] = []

    async def get_devices(self, view: str = "BASIC") -> list[dict]:
        if self.exc is not None:
            raise self.exc
        self.device_views.append(view)
        return self.rows

    async def get_active_clients(self) -> list[dict]:
        return self.client_rows

    async def get_network_policies(self) -> list[dict]:
        return self.policies

    async def get_policy_ssids(self, policy_id: int) -> list[dict]:
        return self.policy_ssids.get(policy_id, [])


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


# ---- Phase 10.2 cycles (fixture-driven) -------------------------------------

def _load_fixture(name):
    import json
    from pathlib import Path
    return json.loads((Path(__file__).parent / "fixtures" / name).read_text())


def _fake_with_fixtures():
    fake = FakeXiq()
    fake.rows = _load_fixture("xiq_devices_full.json")["data"]
    fake.client_rows = _load_fixture("xiq_clients_active.json")["data"]
    ssids = _load_fixture("xiq_ssids.json")
    fake.policies = ssids["policies"]["data"]
    fake.policy_ssids = {int(k): v["data"] for k, v in ssids["ssids"].items()}
    return fake


def _db_with_chs(tmp_path):
    engine = _db(tmp_path)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, enabled, xiq_device_id) "
            "VALUES ('CHS-12-Room','CHS','ap',1,'100003')"))
    return engine


def test_xiq_detail_clients_ssid_cycles(tmp_path):
    engine = _db_with_chs(tmp_path)
    fake = _fake_with_fixtures()
    collector = XiqCollector(engine, fake)
    asyncio.run(collector.run_once())

    # The detail cycle rode the status fetch: one FULL call, not BASIC+FULL.
    assert fake.device_views == ["FULL"]

    details = {r["device_id"]: r for r in db.fetch_all(engine, "SELECT * FROM ap_details")}
    assert len(details) == 2
    assert all(r["model"] == "AP305C" for r in details.values())
    bhs = db.fetch_one(engine, "SELECT * FROM ap_details WHERE clients_total = 23")
    assert bhs["fw_version"] == "10.6.4.0" and bhs["network_policy"] == "TCS-Schools"
    assert bhs["mgmt_mac"] == "f0ab0000aa01"
    assert bhs["uptime_s"] and bhs["uptime_s"] > 0

    # Radios: band comes from the radio's own frequency field — the CHS AP
    # runs dual-5G (both radios band 5), never inferred from the index.
    radios = db.fetch_all(engine, "SELECT * FROM ap_radios ORDER BY device_id, radio")
    assert len(radios) == 4
    chs = [r for r in radios if r["band"] == "5" and r["width_mhz"] == 40]
    assert len(chs) == 2
    assert {r["radio"] for r in chs} == {"wifi0", "wifi1"}

    clients = {r["mac"]: r for r in db.fetch_all(engine, "SELECT * FROM wireless_clients")}
    assert len(clients) == 3
    c = clients["aa:bb:cc:00:01:01"]
    assert c["ssid"] == "TCS-Student" and c["band"] == "5" and c["rssi_dbm"] == -54
    assert c["username"] == "student1@example.org"
    assert c["device_id"] is not None
    assert c["connected_since"] is not None
    # Client on an AP outside the registry: kept, but unattributed.
    assert clients["aa:bb:cc:00:01:03"]["device_id"] is None

    ssids = {r["name"]: r for r in db.fetch_all(engine, "SELECT * FROM ssids")}
    assert set(ssids) == {"TCS-Student", "TCS-Staff", "TCS-IoT"}
    assert ssids["TCS-Staff"]["auth"] == "WPA2_ENTERPRISE"
    assert ssids["TCS-Staff"]["network_policy"] == "TCS-Schools"


def test_xiq_cycles_are_interval_gated_and_disableable(tmp_path):
    engine = _db_with_chs(tmp_path)
    fake = _fake_with_fixtures()
    collector = XiqCollector(engine, fake)
    asyncio.run(collector.run_once())
    # Immediately again: no cycle is due — status-only BASIC fetch, and the
    # clients/ssids fetchers aren't re-hit (rows unchanged is fine; views show
    # the fetch shape).
    asyncio.run(collector.run_once())
    assert fake.device_views == ["FULL", "BASIC"]

    # clients cycle disabled: a fresh collector persists no client rows.
    from pathlib import Path
    d2 = Path(str(tmp_path)) / "second"
    d2.mkdir(exist_ok=True)
    engine2 = _db(d2)
    c2 = XiqCollector(engine2, _fake_with_fixtures(), clients_enabled=False)
    asyncio.run(c2.run_once())
    assert db.fetch_one(engine2, "SELECT COUNT(*) AS n FROM wireless_clients")["n"] == 0
    assert db.fetch_one(engine2, "SELECT COUNT(*) AS n FROM ap_details")["n"] >= 1
