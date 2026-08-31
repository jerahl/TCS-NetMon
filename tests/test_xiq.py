import asyncio

from sqlalchemy import text

from netmon import db
from netmon.collectors.xiq import XiqCollector, source_state
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
    assert d.device_admin_state is None  # absent → None, not ""


def _dev(connected, admin_state=None):
    row = {"id": 1, "connected": connected}
    if admin_state is not None:
        row["device_admin_state"] = admin_state
    return XiqDevice.model_validate(row)


def test_source_state_only_trusts_connected_for_managed_devices():
    """XIQ reports connected=false for anything it isn't managing; that is
    'no opinion', not 'down' (2026-07-27 — 13 switches flagged down, 11 alive)."""
    assert source_state(_dev(True, "MANAGED")) == ("up", "ok")
    assert source_state(_dev(False, "MANAGED")) == ("down", "crit")

    # Not managed → unknown regardless of the (meaningless) connected flag.
    for admin in ("UNMANAGED", "NEW", "BOOTSTRAP", "unmanaged", " New "):
        assert source_state(_dev(False, admin)) == ("unknown", "unknown"), admin
        assert source_state(_dev(True, admin)) == ("unknown", "unknown"), admin

    # Field absent or blank → treated as managed, so the signal survives on a
    # tenant/view that omits it.
    assert source_state(_dev(True)) == ("up", "ok")
    assert source_state(_dev(False)) == ("down", "crit")
    assert source_state(_dev(False, "")) == ("down", "crit")


class FakeXiq:
    """Injected XIQ client: returns rows, or raises a configured exception."""

    def __init__(self):
        self.rows: list[dict] = []
        self.radio_entities: list[dict] = []
        self.client_rows: list[dict] = []
        self.policies: list[dict] = []
        self.policy_ssids: dict[int, list[dict]] = {}
        self.exc: Exception | None = None
        self.radio_exc: Exception | None = None
        self.rate_limit_remaining = None
        self.device_views: list[str] = []
        self.radio_id_batches: list[list[int]] = []

    async def get_devices(self, view: str = "BASIC") -> list[dict]:
        if self.exc is not None:
            raise self.exc
        self.device_views.append(view)
        return self.rows

    async def get_radio_information(self, device_ids, batch: int = 50) -> list[dict]:
        ids = [int(i) for i in device_ids]
        self.radio_id_batches.append(ids)
        if self.radio_exc is not None:
            raise self.radio_exc
        if not ids:
            return []
        return [e for e in self.radio_entities if int(e["device_id"]) in set(ids)]

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
    # Focus on the status/IP-backfill path — the detail/clients/ssids cycles
    # have their own tests.
    collector = XiqCollector(engine, fake, detail_enabled=False,
                             clients_enabled=False, ssids_enabled=False)
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


def test_xiq_unmanaged_switch_is_unknown_not_down(tmp_path):
    """An UNMANAGED switch that XIQ reports disconnected must not read as down —
    the site roll-up counts a down switch as degrading its site (sites.py)."""
    engine = _db(tmp_path)
    fake = FakeXiq()
    fake.rows = [
        {"id": 100001, "connected": True, "device_admin_state": "MANAGED"},
        {"id": 100002, "connected": False, "device_admin_state": "UNMANAGED"},
    ]
    collector = XiqCollector(engine, fake, detail_enabled=False,
                             clients_enabled=False, ssids_enabled=False)
    asyncio.run(collector.run_once())

    st = _status(engine)
    assert st["100001"]["value"] == "up"
    assert st["100002"]["value"] == "unknown"
    assert st["100002"]["severity"] == "unknown"

    # And a device that later comes under management transitions honestly.
    fake.rows[1] = {"id": 100002, "connected": False, "device_admin_state": "MANAGED"}
    asyncio.run(collector.run_once())
    assert _status(engine)["100002"]["value"] == "down"
    evs = db.fetch_all(engine, "SELECT old_value,new_value FROM state_events "
                               "WHERE new_value='down' ORDER BY id")
    assert [(e["old_value"], e["new_value"]) for e in evs] == [("unknown", "down")]


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
    fake.radio_entities = _load_fixture("xiq_radio_information.json")["data"]
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
    assert all(r["model"] == "AP_305C" for r in details.values())
    bhs = db.fetch_one(engine, "SELECT * FROM ap_details WHERE clients_total = 23")
    assert bhs["fw_version"] == "10.6.4.0" and bhs["network_policy"] == "TCS-Schools"
    assert bhs["mgmt_mac"] == "f0ab0000aa01"
    assert bhs["uptime_s"] and bhs["uptime_s"] > 0

    # Radios come from /devices/radio-information, not the device payload —
    # the radios cycle asked for exactly the registry's AP ids.
    assert fake.radio_id_batches == [[100001, 100003]]

    # Band comes from the radio's own `frequency` field — the BHS AP runs
    # dual-5G (wifi0 AND wifi1 at 5 GHz), never inferred from the index.
    radios = db.fetch_all(engine, "SELECT * FROM ap_radios ORDER BY device_id, radio")
    assert len(radios) == 5           # 3 on the BHS AP, 2 on the CHS AP
    bhs_id = db.fetch_one(engine, "SELECT id FROM devices WHERE xiq_device_id='100001'")["id"]
    bhs_r = {r["radio"]: r for r in radios if r["device_id"] == bhs_id}
    assert [bhs_r[n]["band"] for n in ("wifi0", "wifi1", "wifi2")] == ["5", "5", "2.4"]
    # channel_number, not channel; MHZ_20, not "20MHz".
    assert bhs_r["wifi0"]["channel"] == 40 and bhs_r["wifi1"]["channel"] == 161
    assert all(bhs_r[n]["width_mhz"] == 20 for n in bhs_r)
    assert bhs_r["wifi0"]["tx_power_dbm"] == 13
    # clients stays NULL: radio["clients"] is an SSID list, not a client count.
    assert all(r["clients"] is None for r in radios)
    chs_id = db.fetch_one(engine, "SELECT id FROM devices WHERE xiq_device_id='100003'")["id"]
    chs_r = {r["radio"]: r for r in radios if r["device_id"] == chs_id}
    assert chs_r["wifi0"]["width_mhz"] == 80    # another published enum member
    assert chs_r["wifi0"]["tx_power_dbm"] == 0  # a real radio state, not "missing"

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


def test_stale_blind_cleared_when_xiq_no_longer_lists_device(tmp_path):
    """A device blinded during an XIQ outage that XIQ no longer lists (stale
    xiq_device_id / re-typed / removed) must not stay blind forever — a later
    successful fetch clears it to unknown so the source_blind alert resolves,
    while a device XIQ still lists gets its real up/down."""
    engine = _db(tmp_path)   # 100001 (ap), 100002 (switch), both have xiq ids
    fake = FakeXiq()

    # Outage: whole source unreachable → every XIQ device blinded.
    fake.exc = XiqAuthError("XIQ 401 — token revoked or invalid")
    asyncio.run(XiqCollector(engine, fake).run_guarded())
    st = _status(engine)
    assert st["100001"]["value"] == "blind" and st["100002"]["value"] == "blind"

    # Recovery: XIQ answers again but only 100001 is in the fleet now; 100002's
    # id is stale (re-typed switch XIQ dropped).
    fake.exc = None
    fake.rows = [{"id": 100001, "connected": True}]
    collector = XiqCollector(engine, fake, detail_enabled=False,
                             clients_enabled=False, ssids_enabled=False)
    asyncio.run(collector.run_once())

    st = _status(engine)
    assert st["100001"]["value"] == "up"          # present → real status
    assert st["100002"]["value"] == "unknown"     # stale blind cleared, no longer a problem
    assert st["100002"]["severity"] == "unknown"
    # The blind→unknown transition is recorded honestly.
    ev = db.fetch_all(engine, "SELECT new_value FROM state_events WHERE dimension='source_status' "
                              "ORDER BY id")
    assert ev[-1]["new_value"] in ("up", "unknown")


def test_switch_never_gets_ap_detail_even_when_xiq_calls_it_an_ap(tmp_path):
    """Registry device_type is authoritative: a device NetMon types as a
    switch (100002) never gets AP-detail rows, even if the XIQ FULL payload
    reports its device_function as "AP" — its detail comes from the SNMP
    inventory sweep, not the AP path. The registry AP (100001) still does."""
    engine = _db(tmp_path)   # 100001 = ap, 100002 = switch
    fake = FakeXiq()
    fake.rows = [
        {"id": 100001, "connected": True, "device_function": "AP", "product_type": "AP_305C"},
        # XIQ mislabels this switch as an AP — must still be ignored by the AP path.
        {"id": 100002, "connected": True, "device_function": "AP", "product_type": "X440"},
    ]
    # …and it answers radio-information for the switch too. Also ignored.
    fake.radio_entities = [
        {"device_id": 100001,
         "radios": [{"name": "wifi0", "frequency": "5GHz", "channel_number": 36,
                     "channel_width": "MHZ_20", "power": 13}]},
        {"device_id": 100002,
         "radios": [{"name": "wifi0", "frequency": "5GHz", "channel_number": 44,
                     "channel_width": "MHZ_20", "power": 13}]},
    ]
    collector = XiqCollector(engine, fake)
    asyncio.run(collector.run_once())

    details = {r["device_id"] for r in db.fetch_all(engine, "SELECT device_id FROM ap_details")}
    ap_id = db.fetch_one(engine, "SELECT id FROM devices WHERE xiq_device_id='100001'")["id"]
    sw_id = db.fetch_one(engine, "SELECT id FROM devices WHERE xiq_device_id='100002'")["id"]
    assert ap_id in details
    assert sw_id not in details
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM ap_radios WHERE device_id=:d",
                        {"d": sw_id})["n"] == 0
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM ap_radios WHERE device_id=:d",
                        {"d": ap_id})["n"] == 1
    # The switch's id was never even asked for.
    assert fake.radio_id_batches == [[100001]]
    # …but the switch still gets up/down source_status from the fleet list.
    st = _status(engine)
    assert st["100002"]["value"] == "up"


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

    # radios cycle disabled: no radio fetch at all, and ap_radios stays empty —
    # the extra ~16 calls/cycle must be switchable off (§4.3).
    d3 = Path(str(tmp_path)) / "third"
    d3.mkdir(exist_ok=True)
    engine3 = _db(d3)
    f3 = _fake_with_fixtures()
    c3 = XiqCollector(engine3, f3, radios_enabled=False)
    asyncio.run(c3.run_once())
    assert f3.radio_id_batches == []
    assert db.fetch_one(engine3, "SELECT COUNT(*) AS n FROM ap_radios")["n"] == 0
    assert db.fetch_one(engine3, "SELECT COUNT(*) AS n FROM ap_details")["n"] >= 1

    # The radios cycle is interval-gated like the others: due once, then not.
    f4 = _fake_with_fixtures()
    c4 = XiqCollector(engine3, f4)
    asyncio.run(c4.run_once())
    asyncio.run(c4.run_once())
    assert len(f4.radio_id_batches) == 1


# ---- ap_radios: the radio-information endpoint (task #18) -------------------

def test_width_mhz_parses_the_MHZ_20_enum_and_flags_junk():
    """``XiqRadio.channel_width`` is the enum MHZ_20|MHZ_40|MHZ_80|MHZ_160|MHZ_320
    — digits at the END. The old leading-anchored regex returned None for every
    one of them, and the live fleet is 100% MHZ_20, so the column would have been
    entirely NULL. Both spellings must parse."""
    from collections import Counter

    from netmon.collectors.xiq import _width_mhz

    assert _width_mhz("MHZ_20") == 20
    assert _width_mhz("MHZ_40") == 40
    assert _width_mhz("MHZ_80") == 80
    assert _width_mhz("MHZ_160") == 160
    assert _width_mhz("MHZ_320") == 320
    # …and the shapes the collector already accepted.
    assert _width_mhz("20") == 20
    assert _width_mhz("20MHz") == 20
    assert _width_mhz(40) == 40
    assert _width_mhz("mhz_80") == 80

    # Absent is not an error: XIQ said nothing.
    tally: Counter = Counter()
    assert _width_mhz(None, tally) is None
    assert _width_mhz("", tally) is None
    assert _width_mhz("   ", tally) is None
    assert tally == Counter()

    # Present but unparseable must be LOUD, not a silent NULL (§4.5).
    assert _width_mhz("WIDE", tally) is None
    assert tally == Counter({"radios[].channel_width='WIDE'": 1})


def test_build_radio_rows_uses_the_real_radio_information_shape():
    """Field-for-field against the sanitized live payload: channel_number (not
    channel), MHZ_20 (not "20MHz"), frequency for the band, and clients left
    NULL because radio["clients"] is an SSID list, not a client count."""
    from datetime import datetime, timezone

    from netmon.collectors.xiq import build_radio_rows

    ents = _load_fixture("xiq_radio_information.json")["data"]
    now = datetime(2026, 7, 28, 12, 0, tzinfo=timezone.utc)
    # 100001 → device 1 (ap), 100003 → device 3 (ap), 100002 → device 2 (switch)
    xiq_to_dev = {"100001": 1, "100002": 2, "100003": 3}

    rows = build_radio_rows(ents, xiq_to_dev, now, ap_ids={1, 3})
    assert len(rows) == 5
    by_key = {(r["device_id"], r["radio"]): r for r in rows}
    assert set(by_key) == {(1, "wifi0"), (1, "wifi1"), (1, "wifi2"),
                           (3, "wifi0"), (3, "wifi1")}

    w0 = by_key[(1, "wifi0")]
    assert w0["band"] == "5"            # from frequency "5GHz"
    assert w0["channel"] == 40          # from channel_number
    assert w0["width_mhz"] == 20        # from "MHZ_20"
    assert w0["tx_power_dbm"] == 13
    assert w0["clients"] is None
    assert w0["updated_at"] == now

    # Dual-5G is the norm on this fleet: band never comes from the radio index.
    assert by_key[(1, "wifi0")]["band"] == by_key[(1, "wifi1")]["band"] == "5"
    assert by_key[(1, "wifi2")]["band"] == "2.4"
    assert by_key[(3, "wifi0")]["width_mhz"] == 80

    # A radio with an empty clients[] is still a real radio.
    assert by_key[(1, "wifi2")]["channel"] == 11

    # The switch answered too, and is excluded by registry device_type.
    assert not any(r["device_id"] == 2 for r in rows)

    # Without ap_ids nothing is filtered (legacy behaviour), but an unknown XIQ
    # id is still dropped — we never invent a device_id.
    assert len(build_radio_rows(ents, xiq_to_dev, now)) == 6
    assert build_radio_rows(ents, {}, now) == []


def test_radio_clients_array_is_never_counted_as_clients():
    """The trap this task had to avoid. ``XiqRadio.clients`` is an array of
    ``XiqWirelessClient`` — network_policy_name/ssid/ssid_status/
    ssid_security_type, no client identity at all. Live: its ssid set matched
    ``wlans[]`` on 1,574/1,574 radios and the per-AP total was only ever 3 or 6,
    while XIQ's own active_clients for those APs ran 1..30+. len() would stamp a
    fabricated "3" on every radio in the fleet (§4.5)."""
    from datetime import datetime, timezone

    from netmon.collectors.xiq import build_radio_rows

    ssid_descriptor = {"network_policy_name": "TCS-Schools", "ssid": "TCS-Student",
                       "ssid_status": "OPEN", "ssid_security_type": "TYPE_802DOT1X"}
    ents = [{"device_id": 100001, "radios": [{
        "name": "wifi0", "frequency": "5GHz", "channel_number": 36,
        "channel_width": "MHZ_20", "power": 13,
        # three SSIDs, and there is no client anywhere in sight
        "clients": [dict(ssid_descriptor, ssid=s) for s in ("A", "B", "C")],
    }]}]
    rows = build_radio_rows(ents, {"100001": 1}, datetime.now(timezone.utc))
    assert len(rows) == 1
    assert rows[0]["clients"] is None, "an SSID list must never become a client count"


def test_radios_cycle_populates_ap_radios_and_keeps_stale_rows_on_failure(tmp_path):
    """The actual production bug: ap_radios had 0 rows because build_ap_rows read
    a `radios` key that GET /devices?views=FULL does not have. Radios now come
    from their own endpoint — and if that fetch fails, the previous rows stay
    visible-and-stale rather than being wiped (§4.5)."""
    engine = _db_with_chs(tmp_path)
    fake = _fake_with_fixtures()

    # The device payload no longer pretends to carry radios…
    assert all("radios" not in r for r in fake.rows)
    # …yet ap_radios fills anyway.
    asyncio.run(XiqCollector(engine, fake).run_once())
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM ap_radios")["n"] == 5
    bands = {r["band"]: r["c"] for r in db.fetch_all(
        engine, "SELECT band, COUNT(*) AS c FROM ap_radios GROUP BY band")}
    assert bands == {"5": 4, "2.4": 1}
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM ap_radios "
                                "WHERE width_mhz IS NULL")["n"] == 0

    # A later cycle whose radio fetch fails must raise (so collector_health
    # records it) and must NOT leave ap_radios empty.
    f2 = _fake_with_fixtures()
    f2.radio_exc = XiqRateLimitError("XIQ 429 — rate limit exceeded")
    c2 = XiqCollector(engine, f2)
    try:
        asyncio.run(c2.run_once())
        raise AssertionError("a failed radio fetch must not pass silently")
    except XiqRateLimitError:
        pass
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM ap_radios")["n"] == 5


# ---- client radio_type: the integer band enum (task #15) ---------------------

def test_client_band_maps_the_integer_radio_type_enum():
    """``/clients/active`` returns ``radio_type`` as an INT, not a band string —
    the whole reason ``wireless_clients.band`` was NULL for every client until
    2026-07-28. Codes are verbatim from the tenant's own published schema
    (ExtremeCloud IQ API 25.11.1-3): 1=2.4G, 2=5G, 3=WIRED, 4=6G, 5=THREAD."""
    from netmon.collectors.xiq import _client_band

    assert _client_band(1) == "2.4"
    assert _client_band(2) == "5"
    assert _client_band(3) == "wired"     # /clients/active carries wired clients too
    assert _client_band(4) == "6"
    assert _client_band(5) == "thread"
    # Numeric strings are the same enum.
    assert _client_band("2") == "5"
    # Legacy/textual tenants (or a ``fields=RADIO_TYPE`` view) still work.
    assert _client_band("5G") == "5"
    assert _client_band("2.4GHz") == "2.4"
    # Nothing said → nothing claimed (and no false alarm).
    tally = __import__("collections").Counter()
    assert _client_band(None, tally) is None
    assert _client_band("", tally) is None
    assert tally == {}


def test_unmapped_radio_type_is_loud_not_silently_null(caplog):
    """§4.5: an enum value the map doesn't cover must be visible. It still
    yields NULL (never a guessed band) but it is logged and counted."""
    import logging
    from collections import Counter

    from netmon.collectors import xiq as xiq_mod

    xiq_mod._unmapped_last_warn.clear()
    tally: Counter = Counter()
    with caplog.at_level(logging.WARNING, logger="netmon.collectors.xiq"):
        assert xiq_mod._client_band(9, tally) is None          # hypothetical new band
        assert xiq_mod._client_band(9, tally) is None          # counted twice…
        assert xiq_mod._band("7GHz", tally) is None            # AP radio path too
    assert tally["clients.radio_type=9"] == 2
    assert tally["radios[].frequency='7GHz'"] == 1
    # …but warned about once per value per window, not once per row.
    warnings = [r for r in caplog.records if "unmapped value" in r.message]
    assert len(warnings) == 2
    assert all(r.levelno == logging.WARNING for r in warnings)


def test_client_bands_persist_and_unmapped_values_reach_snapshot_cache(tmp_path):
    """End to end: the fixture's int radio_types land as real bands, and a value
    the map doesn't cover is published to ``snapshot_cache`` (ok=0 + counts) so
    a future enum change cannot go unnoticed again."""
    from netmon.collectors.xiq import UNMAPPED_SNAPSHOT_KEY
    from netmon.snapshots import read_snapshot

    engine = _db_with_chs(tmp_path)
    fake = _fake_with_fixtures()
    asyncio.run(XiqCollector(engine, fake).run_once())

    bands = {r["mac"]: r["band"] for r in
             db.fetch_all(engine, "SELECT mac, band FROM wireless_clients")}
    assert bands["aa:bb:cc:00:01:01"] == "5"      # radio_type 2
    assert bands["aa:bb:cc:00:01:02"] == "2.4"    # radio_type 1
    assert None not in bands.values()

    snap = read_snapshot(engine, UNMAPPED_SNAPSHOT_KEY)
    assert snap["ok"] is True and snap["payload"]["total"] == 0

    # Now XIQ ships a code we don't know: the row is kept with a NULL band, and
    # the anomaly is flagged, counted and queryable.
    from pathlib import Path
    d2 = Path(str(tmp_path)) / "unmapped"
    d2.mkdir(exist_ok=True)
    engine2 = _db_with_chs(d2)
    fake2 = _fake_with_fixtures()
    fake2.client_rows = [dict(r, radio_type=42) for r in fake2.client_rows]
    asyncio.run(XiqCollector(engine2, fake2).run_once())

    rows = db.fetch_all(engine2, "SELECT mac, band FROM wireless_clients")
    assert rows and all(r["band"] is None for r in rows)
    snap2 = read_snapshot(engine2, UNMAPPED_SNAPSHOT_KEY)
    assert snap2["ok"] is False
    assert snap2["payload"]["total"] == len(rows)
    assert snap2["payload"]["counts"] == {"clients.radio_type=42": len(rows)}


def test_radio_name_parses_only_radio_interfaces():
    """``interface_name`` names a radio *or* a switch port; only one is a radio.

    Live shapes (7,423 active clients, 2026-08-31): every wireless client is
    ``wifi0.N``/``wifi1.N`` and every wired one is slot:port. Coercing the
    switch form into a radio would repeat the mistake build_radio_rows exists
    to avoid — inventing an association the payload never asserted.
    """
    from netmon.collectors.xiq import _radio_name

    assert _radio_name("wifi0.3") == "wifi0"
    assert _radio_name("wifi1.1") == "wifi1"
    assert _radio_name("WIFI0.2") == "wifi0"        # case-folded
    assert _radio_name("1:51") is None              # switch slot:port
    assert _radio_name("5:6") is None
    assert _radio_name("") is None
    assert _radio_name(None) is None
    assert _radio_name("eth0") is None              # not a radio interface


def test_clients_cycle_records_the_radio_and_leaves_wired_null(tmp_path):
    """The per-radio count is derivable only if the association is stored."""
    engine = _db_with_chs(tmp_path)
    fake = _fake_with_fixtures()
    asyncio.run(XiqCollector(engine, fake).run_once())

    rows = db.fetch_all(engine, "SELECT mac, band, radio FROM wireless_clients")
    assert rows, "fixture should produce clients"
    for r in rows:
        if r["band"] == "wired":
            assert r["radio"] is None, "a wired client is not on a radio"
        else:
            assert r["radio"] in ("wifi0", "wifi1")
