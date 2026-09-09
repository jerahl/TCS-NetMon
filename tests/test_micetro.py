"""Micetro DDI collector + client tests (docs/spec/21-micetro-ddi.md).

Fixture-based parse tests per CLAUDE.md §4.8. The fixtures are shaped from the
published 26.1.0 OpenAPI schema, not from a live appliance (spec 21 Q1), so
these assert the mapping rules — not that production speaks exactly this.
"""

import asyncio
import json

import pytest

from netmon import db
from netmon.collectors.micetro import (
    MicetroCollector,
    build_address_rows,
    build_scope_rows,
    classify_utilization,
    is_empty_record,
)
from netmon.collectors.micetro_client import MicetroClient, MicetroError
from netmon.snapshots import read_snapshot
from tests.conftest import FIXTURES, create_core_tables

IPAM = json.loads((FIXTURES / "micetro_ipam_records.json").read_text())["ipamRecords"]
RANGES_FIXTURE = json.loads((FIXTURES / "micetro_ranges.json").read_text())
RANGES = RANGES_FIXTURE["ranges"]
SCOPES = RANGES_FIXTURE["dhcpScopes"]


class FakeMicetro:
    """Stands in for MicetroClient. Records calls so fan-out can be asserted."""

    def __init__(self):
        self.ranges_data = list(RANGES)
        self.records_by_ref = {"Ranges/10": list(IPAM)}
        self.scopes_data = list(SCOPES)
        self.fail = None
        self.ipam_calls = []

    async def ranges(self, limit_total=None):
        if self.fail:
            raise self.fail
        return self.ranges_data

    async def ipam_records(self, range_ref, limit_total=None):
        if self.fail:
            raise self.fail
        self.ipam_calls.append(range_ref)
        return self.records_by_ref.get(range_ref, [])

    async def dhcp_scopes(self, limit_total=None):
        if self.fail:
            raise self.fail
        return self.scopes_data


def _engine(tmp_path):
    e = db.make_engine(f"sqlite:///{tmp_path / 'micetro.db'}")
    create_core_tables(e)
    return e


def _collector(engine, client=None, **kw):
    return MicetroCollector(engine, client or FakeMicetro(), **kw)


# --- record filtering (the sweep bound, spec 21 §4) --------------------------


def test_free_and_empty_records_are_dropped():
    by_ip = {r["address"]: r for r in IPAM}
    # The bulk of any range: unallocated, nothing attached.
    assert is_empty_record(by_ip["192.0.2.150"]) is True
    # No state string at all is treated the same as Free.
    assert is_empty_record(by_ip["192.0.2.151"]) is True


def test_held_record_is_kept_even_with_no_mac_or_name():
    # Held is not Free: the address is not available, which is worth knowing.
    assert is_empty_record({"address": "192.0.2.160", "state": "Held"}) is False


def test_record_with_only_a_dns_name_is_kept():
    assert is_empty_record(
        {"address": "192.0.2.90", "state": "Free",
         "dnsHosts": [{"dnsRecord": {"name": "ntp1.tcs.internal"}}]}) is False


def test_build_address_rows_drops_the_empty_ones():
    rows = build_address_rows(IPAM, "192.0.2.0/24")
    ips = {r["ip"] for r in rows}
    assert "192.0.2.150" not in ips and "192.0.2.151" not in ips
    assert "192.0.2.160" in ips  # Held survives
    assert len(rows) == 6


# --- MAC precedence ---------------------------------------------------------


def test_lease_mac_wins_and_is_canonicalised():
    row = {r["ip"]: r for r in build_address_rows(IPAM, "r")}["192.0.2.31"]
    assert row["mac"] == "02:00:5e:10:00:01"
    assert row["mac_origin"] == "lease"


def test_reservation_mac_used_when_no_lease_despite_dash_separators():
    row = {r["ip"]: r for r in build_address_rows(IPAM, "r")}["192.0.2.60"]
    assert row["mac"] == "02:00:5e:10:00:02"
    assert row["mac_origin"] == "reservation"
    assert row["reservation"] == "bhs-lib-printer3"


def test_discovery_mac_is_last_resort_and_accepts_cisco_dot_notation():
    row = {r["ip"]: r for r in build_address_rows(IPAM, "r")}["192.0.2.77"]
    assert row["mac"] == "02:00:5e:10:00:03"
    assert row["mac_origin"] == "discovery"
    # Micetro's own device/interface labels are carried through.
    assert row["device_name"] == "av-projector-b12"
    assert row["interface_name"] == "eth0"


def test_lease_beats_a_conflicting_discovery_mac():
    """A lease is the DHCP server's own record; ARP can be a scan interval old."""
    rows = build_address_rows([{
        "address": "192.0.2.5",
        "state": "Assigned",
        "lastKnownClientIdentifier": "02:00:5e:99:99:99",
        "dhcpLeases": [{"mac": "02:00:5e:10:00:07"}],
    }], "r")
    assert rows[0]["mac"] == "02:00:5e:10:00:07"
    assert rows[0]["mac_origin"] == "lease"


def test_dhcpv6_lease_yields_no_mac_but_keeps_the_name():
    """DHCPv6 carries duid/iaid, not a MAC (spec 21 Q5) — name-only identity."""
    row = {r["ip"]: r for r in build_address_rows(IPAM, "r")}["2001:db8::31"]
    assert row["mac"] is None
    assert row["mac_origin"] is None
    assert row["dns_name"] == "bhs-lib-chrome14.tcs.internal"


def test_a_garbage_mac_is_rejected_not_stored():
    rows = build_address_rows([{
        "address": "192.0.2.6", "state": "Assigned",
        "dhcpLeases": [{"mac": "not-a-mac"}],
        "dnsHosts": [{"dnsRecord": {"name": "x.tcs.internal"}}],
    }], "r")
    assert rows[0]["mac"] is None and rows[0]["mac_origin"] is None


# --- DNS names --------------------------------------------------------------


def test_primary_dns_name_plus_extra_count():
    row = {r["ip"]: r for r in build_address_rows(IPAM, "r")}["192.0.2.60"]
    assert row["dns_name"] == "bhs-lib-printer3.tcs.internal"
    assert row["dns_extra"] == 1  # print-lib.tcs.internal counted, not stored


def test_single_name_has_no_extras():
    row = {r["ip"]: r for r in build_address_rows(IPAM, "r")}["192.0.2.90"]
    assert row["dns_name"] == "ntp1.tcs.internal"
    assert row["dns_extra"] == 0


# --- field mapping ----------------------------------------------------------


def test_unrecognised_state_becomes_unknown_not_a_guess():
    rows = build_address_rows(
        [{"address": "192.0.2.7", "state": "Quarantined",
          "dnsHosts": [{"dnsRecord": {"name": "q.tcs.internal"}}]}], "r")
    assert rows[0]["state"] == "unknown"


def test_known_states_are_lowercased_to_the_enum():
    rows = build_address_rows(
        [{"address": "192.0.2.8", "state": "Assigned",
          "dnsHosts": [{"dnsRecord": {"name": "a.tcs.internal"}}]}], "r")
    assert rows[0]["state"] == "assigned"


def test_lease_timestamps_and_state_are_parsed():
    row = {r["ip"]: r for r in build_address_rows(IPAM, "r")}["192.0.2.31"]
    assert row["lease_state"] == "active"
    assert row["lease_expires"] is not None
    assert row["lease_expires"].year == 2026
    assert row["last_seen"] is not None


def test_blank_strings_become_null_not_empty():
    rows = build_address_rows(
        [{"address": "192.0.2.9", "state": "Assigned", "device": "  ",
          "dnsHosts": [{"dnsRecord": {"name": "b.tcs.internal"}}]}], "r")
    assert rows[0]["device_name"] is None


def test_duplicate_addresses_within_a_range_collapse_to_one_row():
    rows = build_address_rows(
        [{"address": "192.0.2.9", "state": "Assigned",
          "dhcpLeases": [{"mac": "02:00:5e:10:00:aa"}]},
         {"address": "192.0.2.9", "state": "Held"}], "r")
    assert len(rows) == 1
    assert rows[0]["mac"] == "02:00:5e:10:00:aa"


def test_non_dict_records_are_skipped_not_fatal():
    rows = build_address_rows(["nonsense", None, {"address": "192.0.2.11",
                                                  "state": "Held"}], "r")
    assert [r["ip"] for r in rows] == ["192.0.2.11"]


# --- scope utilization ------------------------------------------------------


def test_classify_utilization_thresholds_are_inclusive():
    assert classify_utilization(84.9, 85, 95) == "ok"
    assert classify_utilization(85, 85, 95) == "warn"
    assert classify_utilization(94.9, 85, 95) == "warn"
    assert classify_utilization(95, 85, 95) == "crit"


def test_missing_utilization_is_unknown_never_ok():
    """No figure is not evidence of health (§4.5)."""
    assert classify_utilization(None, 85, 95) == "unknown"


def test_scope_rows_join_utilization_from_the_owning_range():
    by_ref = {r["ref"]: r for r in RANGES}
    rows = {r["scope_ref"]: r for r in build_scope_rows(SCOPES, by_ref, 85, 95)}
    # utilizationPercentage lives on Range, not DHCPScope.
    assert rows["DHCPScopes/100"]["utilization_pct"] == 42.0
    assert rows["DHCPScopes/100"]["severity"] == "ok"
    assert rows["DHCPScopes/101"]["severity"] == "warn"
    assert rows["DHCPScopes/102"]["severity"] == "crit"
    # from/to come from the range too.
    assert rows["DHCPScopes/102"]["from_addr"] == "203.0.113.0"
    assert rows["DHCPScopes/102"]["available"] == 7


def test_scope_with_a_missing_range_stays_unknown():
    by_ref = {r["ref"]: r for r in RANGES}
    rows = {r["scope_ref"]: r for r in build_scope_rows(SCOPES, by_ref, 85, 95)}
    orphan = rows["DHCPScopes/103"]
    assert orphan["utilization_pct"] is None
    assert orphan["severity"] == "unknown"
    assert orphan["enabled"] == 0
    # The scope's own `range` field still gives the CIDR.
    assert orphan["range_cidr"] == "192.168.99.0/24"


def test_scope_enabled_none_stays_none():
    rows = build_scope_rows([{"ref": "S/1", "name": "n"}], {}, 85, 95)
    assert rows[0]["enabled"] is None


def test_non_numeric_utilization_does_not_crash_the_sweep():
    rows = build_scope_rows(
        [{"ref": "S/1", "rangeRef": "R/1"}],
        {"R/1": {"ref": "R/1", "utilizationPercentage": "n/a"}}, 85, 95)
    assert rows[0]["utilization_pct"] is None
    assert rows[0]["severity"] == "unknown"


# --- full cycle -------------------------------------------------------------


def test_run_once_writes_both_tables(tmp_path):
    engine = _engine(tmp_path)
    fake = FakeMicetro()
    asyncio.run(_collector(engine, fake).run_once())

    addrs = db.fetch_all(engine, "SELECT ip, mac, dns_name, range_cidr FROM ddi_addresses")
    assert len(addrs) == 6
    assert {a["range_cidr"] for a in addrs} == {"192.0.2.0/24"}
    scopes = db.fetch_all(engine, "SELECT scope_ref, severity FROM ddi_scopes")
    assert len(scopes) == 4


def test_only_subnet_ranges_are_swept(tmp_path):
    """The /16 container holds 65k addresses and must never be walked."""
    engine = _engine(tmp_path)
    fake = FakeMicetro()
    asyncio.run(_collector(engine, fake).run_once())
    assert "Ranges/1" not in fake.ipam_calls          # the container
    assert set(fake.ipam_calls) == {"Ranges/10", "Ranges/11", "Ranges/12", "Ranges/13"}


def test_addresses_replace_on_refresh(tmp_path):
    engine = _engine(tmp_path)
    fake = FakeMicetro()
    collector = _collector(engine, fake)
    asyncio.run(collector.run_once())

    # Next sweep: the printer is gone from Micetro, a new host appears.
    fake.records_by_ref["Ranges/10"] = [
        {"address": "192.0.2.31", "state": "Assigned",
         "dhcpLeases": [{"mac": "02:00:5e:10:00:01"}]},
        {"address": "192.0.2.99", "state": "Assigned",
         "dnsHosts": [{"dnsRecord": {"name": "new-host.tcs.internal"}}]},
    ]
    asyncio.run(collector.run_once())
    ips = {r["ip"] for r in db.fetch_all(engine, "SELECT ip FROM ddi_addresses")}
    assert ips == {"192.0.2.31", "192.0.2.99"}


def test_addresses_deduplicate_across_overlapping_ranges(tmp_path):
    """Nested Micetro ranges can return the same address twice; `ip` is the PK."""
    engine = _engine(tmp_path)
    fake = FakeMicetro()
    shared = [{"address": "192.0.2.31", "state": "Assigned",
               "dhcpLeases": [{"mac": "02:00:5e:10:00:01"}]}]
    fake.records_by_ref = {"Ranges/10": shared, "Ranges/13": list(shared)}
    asyncio.run(_collector(engine, fake).run_once())
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM ddi_addresses")["n"] == 1


def test_a_failed_fetch_leaves_prior_rows_intact(tmp_path):
    """Fail loud, never stale-as-fresh (§4.5): nothing is half-replaced."""
    engine = _engine(tmp_path)
    fake = FakeMicetro()
    collector = _collector(engine, fake)
    asyncio.run(collector.run_once())
    before = db.fetch_all(engine, "SELECT ip FROM ddi_addresses")

    fake.fail = MicetroError("micetro HTTP 503 on /ranges")
    with pytest.raises(MicetroError):
        asyncio.run(collector.run_once())
    assert db.fetch_all(engine, "SELECT ip FROM ddi_addresses") == before


def test_run_guarded_records_the_failure_in_collector_health(tmp_path):
    engine = _engine(tmp_path)
    fake = FakeMicetro()
    fake.fail = MicetroError("micetro HTTP 401 on /ranges")
    asyncio.run(_collector(engine, fake).run_guarded())
    row = db.fetch_one(engine, "SELECT last_error, consecutive_failures "
                               "FROM collector_health WHERE name = 'micetro'")
    assert "401" in row["last_error"]
    assert row["consecutive_failures"] == 1


def test_max_records_raises_rather_than_truncating(tmp_path):
    """A half-mirror that looks complete is the fabrication §4.5 forbids."""
    engine = _engine(tmp_path)
    fake = FakeMicetro()
    with pytest.raises(MicetroError, match="max_records"):
        asyncio.run(_collector(engine, fake, max_records=2).run_once())
    # Nothing written — not even the rows that fit.
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM ddi_addresses")["n"] == 0


def test_max_ranges_raises(tmp_path):
    engine = _engine(tmp_path)
    with pytest.raises(MicetroError, match="max_ranges"):
        asyncio.run(_collector(engine, FakeMicetro(), max_ranges=2).run_once())


def test_sweeps_are_independently_disableable(tmp_path):
    """Per-step reversibility (§4.3)."""
    engine = _engine(tmp_path)
    asyncio.run(_collector(engine, FakeMicetro(), sweep_addresses=False).run_once())
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM ddi_addresses")["n"] == 0
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM ddi_scopes")["n"] == 4

    second = tmp_path / "b"
    second.mkdir()
    engine2 = _engine(second)
    asyncio.run(_collector(engine2, FakeMicetro(), sweep_scopes=False).run_once())
    assert db.fetch_one(engine2, "SELECT COUNT(*) AS n FROM ddi_scopes")["n"] == 0
    assert db.fetch_one(engine2, "SELECT COUNT(*) AS n FROM ddi_addresses")["n"] == 6


def test_both_sweeps_off_makes_no_calls(tmp_path):
    engine = _engine(tmp_path)
    fake = FakeMicetro()
    written = asyncio.run(
        _collector(engine, fake, sweep_addresses=False, sweep_scopes=False).run_once())
    assert written == 0
    assert fake.ipam_calls == []


def test_snapshots_record_coverage(tmp_path):
    engine = _engine(tmp_path)
    asyncio.run(_collector(engine, FakeMicetro()).run_once())
    addr = read_snapshot(engine, "micetro.addresses")
    assert addr["ok"] is True
    assert addr["payload"]["subnets"] == 4
    assert addr["payload"]["with_mac"] == 3
    dhcp = read_snapshot(engine, "micetro.dhcp")
    assert dhcp["payload"]["by_severity"]["crit"] == 1


# --- client -----------------------------------------------------------------


def test_client_refuses_plaintext_http():
    """Basic auth puts the credential on every request."""
    with pytest.raises(MicetroError, match="https"):
        MicetroClient("http://micetro.example.org", "u", "p")


def test_client_requires_credentials():
    with pytest.raises(MicetroError, match="username and password"):
        MicetroClient("https://micetro.example.org", "u", "")


def test_client_requires_a_url():
    with pytest.raises(MicetroError, match="url is required"):
        MicetroClient("", "u", "p")


def test_client_has_no_non_get_method():
    """Read-only is structural, not a flag (CLAUDE.md §4.1).

    If this fails, someone added a write path to a source NetMon is only
    authorised to read — that needs owner sign-off, not a passing test.
    """
    import ast
    import inspect

    from netmon.collectors import micetro_client

    # Parse rather than grep: the module docstring legitimately names the
    # POST /micetro/sessions call it explains NetMon does *not* make, so a
    # substring search would either fail here or force the prose to be vague.
    tree = ast.parse(inspect.getsource(micetro_client))
    called = {
        node.func.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    for verb in ("post", "put", "patch", "delete"):
        assert verb not in called, f"micetro_client must never call .{verb}()"
    assert "get" in called, "sanity: the client should still make GETs"


def test_client_builds_the_v2_base_path():
    client = MicetroClient("https://micetro.example.org/", "u", "p")
    assert client._base == "https://micetro.example.org/mmws/api/v2"


def test_client_pages_until_short_page():
    """`_drain` walks offset/limit and stops on a short page."""
    calls = []

    class Paged(MicetroClient):
        async def _get(self, path, params=None):
            calls.append(params["offset"])
            offset = params["offset"]
            rows = [{"ref": f"R/{offset + i}"} for i in range(min(2, 5 - offset))]
            return {"ranges": rows, "totalResults": 5}

    client = Paged("https://micetro.example.org", "u", "p", page_size=2)
    rows = asyncio.run(client.ranges())
    assert len(rows) == 5
    assert calls == [0, 2, 4]


def test_client_stops_when_total_results_reached():
    """A server that keeps answering full pages must not loop forever."""

    class Endless(MicetroClient):
        async def _get(self, path, params=None):
            return {"ranges": [{"ref": "R/1"}, {"ref": "R/2"}], "totalResults": 2}

    client = Endless("https://micetro.example.org", "u", "p", page_size=2)
    assert len(asyncio.run(client.ranges())) == 2


def test_client_raises_on_a_runaway_pager():
    """A server ignoring `offset` must fail loud, not silently truncate."""

    class Ignores(MicetroClient):
        async def _get(self, path, params=None):
            return {"ranges": [{"ref": "R/1"}, {"ref": "R/2"}]}

    client = Ignores("https://micetro.example.org", "u", "p", page_size=2)
    with pytest.raises(MicetroError, match="exceeded"):
        asyncio.run(client.ranges())


def test_client_missing_collection_is_an_empty_result():
    class Empty(MicetroClient):
        async def _get(self, path, params=None):
            return {"totalResults": 0}

    client = Empty("https://micetro.example.org", "u", "p")
    assert asyncio.run(client.ranges()) == []


def test_client_rejects_a_wrong_shaped_collection():
    class Wrong(MicetroClient):
        async def _get(self, path, params=None):
            return {"ranges": "nope"}

    client = Wrong("https://micetro.example.org", "u", "p")
    with pytest.raises(MicetroError, match="expected list"):
        asyncio.run(client.ranges())


def test_ipam_records_needs_a_range_ref():
    client = MicetroClient("https://micetro.example.org", "u", "p")
    with pytest.raises(MicetroError, match="range ref"):
        asyncio.run(client.ipam_records(""))
