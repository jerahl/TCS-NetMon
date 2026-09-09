"""DDI (Micetro) API tests — docs/spec/21-micetro-ddi.md §6.

Covers the enrichment that is the point of the collector: an FDB MAC that
PacketFence has never seen still gets a name, and a MAC holding several
addresses does not multiply the port pane's rows.
"""

from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.config import load_config
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config

MICETRO_ON = """
[micetro]
enabled = true
url = https://micetro.example.org
username = netmon-ro
password = secret
"""

# A second address for the printer's MAC: `ddi_addresses.mac` is deliberately
# non-unique, and these rows prove the port pane still shows one card.
V6_ROW = (
    "INSERT INTO ddi_addresses (ip, mac, mac_origin, dns_name, state, updated_at) VALUES ('2001:db8::60', '02:00:5e:10:00:02', 'discovery', 'bhs-lib-printer3.tcs.internal', 'assigned', '2026-09-09 07:05:00')")
V6_ROW_NONAME = (
    "INSERT INTO ddi_addresses (ip, mac, mac_origin, state, updated_at) VALUES ('2001:db8::60', '02:00:5e:10:00:02', 'discovery', 'assigned', '2026-09-09 07:05:00')")


def _app(conf):
    return create_app(config=load_config(conf), supervisor=Supervisor())


def _setup(tmp_path, extra_sections: str = "", *, seed: bool = True,
           dev_bypass: bool = True, extra_rows: str = ""):
    """Seed a SQLite DB, then hand back a config pointing at it.

    Seeding happens on its own engine before the app starts — `app.state.engine`
    only exists once the lifespan has run, which `TestClient` does on __enter__.
    """
    url = f"sqlite:///{tmp_path / 'ddi.db'}"
    engine = db.make_engine(url)
    create_core_tables(engine)
    if seed:
        _seed(engine)
    if extra_rows:
        with engine.begin() as conn:
            conn.execute(text(extra_rows))
    engine.dispose()
    return write_config(tmp_path, db_url=url, dev_bypass=dev_bypass,
                        extra_sections=extra_sections)


def _seed(engine):
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (id, name, site, device_type, mgmt_ip, snmp_capable) "
            "VALUES (1, 'bhs-sw-1', 'BHS', 'switch', '192.0.2.1', 1)"))
        conn.execute(text(
            "INSERT INTO switch_ports (device_id, ifindex, name, oper_state) "
            "VALUES (1, 14, '1:14', 'up')"))
        # Three MACs on one port: one PF knows, one only Micetro knows, one
        # neither knows.
        for mac in ("02:00:5e:10:00:01", "02:00:5e:10:00:02", "02:00:5e:10:00:09"):
            conn.execute(text(
                "INSERT INTO fdb_entries (device_id, mac, ifindex) VALUES (1, :m, 14)"),
                {"m": mac})
        conn.execute(text(
            "INSERT INTO pf_nodes (mac, computername, reg_status, updated_at) "
            "VALUES ('02:00:5e:10:00:01', 'student-cb', 'reg', '2026-09-09 07:00:00')"))
        # The printer: PF has never authenticated it, Micetro names it.
        conn.execute(text(
            "INSERT INTO ddi_addresses (ip, mac, mac_origin, dns_name, dns_extra, "
            "state, updated_at) VALUES "
            "('192.0.2.60', '02:00:5e:10:00:02', 'reservation', "
            "'bhs-lib-printer3.tcs.internal', 1, 'assigned', '2026-09-09 07:05:00')"))
        conn.execute(text(
            "INSERT INTO ddi_addresses (ip, mac, mac_origin, dns_name, dns_extra, "
            "state, updated_at) VALUES "
            "('192.0.2.31', '02:00:5e:10:00:01', 'lease', "
            "'bhs-lib-chrome14.tcs.internal', 0, 'assigned', '2026-09-09 07:05:00')"))
        conn.execute(text(
            "INSERT INTO ddi_scopes (scope_ref, name, range_cidr, utilization_pct, "
            "severity, updated_at) VALUES "
            "('DHCPScopes/100', 'BHS-Data', '192.0.2.0/24', 42.0, 'ok', '2026-09-09 07:05:00'),"
            "('DHCPScopes/102', 'CHS-Wireless', '203.0.113.0/24', 97.0, 'crit', '2026-09-09 07:05:00'),"
            "('DHCPScopes/103', 'Orphan', '192.168.99.0/24', NULL, 'unknown', '2026-09-09 07:05:00')"))


# --- the enrichment ---------------------------------------------------------


def test_port_detail_names_a_mac_packetfence_never_saw(tmp_path):
    """The whole point of spec 21: the printer used to render as bare hex."""
    with TestClient(_app(_setup(tmp_path))) as client:
        macs = {m["mac"]: m for m in
                client.get("/api/switches/1/ports/14").json()["macs"]}

    printer = macs["02:00:5e:10:00:02"]
    assert printer["computername"] is None            # PF knows nothing
    assert printer["ddi_dns_name"] == "bhs-lib-printer3.tcs.internal"
    assert printer["ddi_ip"] == "192.0.2.60"
    assert printer["ddi_mac_origin"] == "reservation"


def test_port_detail_keeps_both_identities_when_both_sources_know(tmp_path):
    with TestClient(_app(_setup(tmp_path))) as client:
        macs = {m["mac"]: m for m in
                client.get("/api/switches/1/ports/14").json()["macs"]}

    chromebook = macs["02:00:5e:10:00:01"]
    assert chromebook["computername"] == "student-cb"
    assert chromebook["ddi_dns_name"] == "bhs-lib-chrome14.tcs.internal"


def test_port_detail_still_renders_a_mac_no_source_knows(tmp_path):
    """LEFT JOIN throughout — an unknown MAC must not vanish from the pane."""
    with TestClient(_app(_setup(tmp_path))) as client:
        macs = {m["mac"]: m for m in
                client.get("/api/switches/1/ports/14").json()["macs"]}

    assert "02:00:5e:10:00:09" in macs
    orphan = macs["02:00:5e:10:00:09"]
    assert orphan["computername"] is None and orphan["ddi_dns_name"] is None


def test_a_mac_with_several_addresses_yields_one_row_not_several(tmp_path):
    """`ddi_addresses.mac` is non-unique; the join must not duplicate cards."""
    # Same MAC, a second (v6) address and a weaker origin.
    conf = _setup(tmp_path, extra_rows=V6_ROW)
    with TestClient(_app(conf)) as client:
        macs = client.get("/api/switches/1/ports/14").json()["macs"]
    assert [m["mac"] for m in macs].count("02:00:5e:10:00:02") == 1
    # And the strongest claim is the one shown.
    printer = next(m for m in macs if m["mac"] == "02:00:5e:10:00:02")
    assert printer["ddi_mac_origin"] == "reservation"
    assert printer["ddi_ip"] == "192.0.2.60"


def test_fdb_tab_is_enriched_without_duplicating_rows(tmp_path):
    with TestClient(_app(_setup(tmp_path))) as client:
        rows = client.get("/api/switches/1/fdb").json()
    assert len(rows) == 3
    named = {r["mac"]: r["ddi_dns_name"] for r in rows}
    assert named["02:00:5e:10:00:02"] == "bhs-lib-printer3.tcs.internal"
    assert named["02:00:5e:10:00:09"] is None


# --- /api/ddi ---------------------------------------------------------------


def test_summary_reports_not_enabled_when_unconfigured_and_empty(tmp_path):
    with TestClient(_app(_setup(tmp_path, seed=False))) as client:
        assert client.get("/api/ddi").json() == {"enabled": False}


def test_summary_counts_coverage(tmp_path):
    with TestClient(_app(_setup(tmp_path, MICETRO_ON))) as client:
        body = client.get("/api/ddi").json()
    assert body["enabled"] is True
    assert body["addresses"]["total"] == 2
    assert body["addresses"]["with_dns"] == 2
    assert body["addresses"]["by_mac_origin"] == {"lease": 1, "reservation": 1}
    assert body["scopes"]["by_severity"] == {"ok": 1, "crit": 1, "unknown": 1}


def test_summary_fdb_coverage_counts_distinct_macs(tmp_path):
    """Coverage must never exceed 100% because a MAC holds two addresses."""
    conf = _setup(tmp_path, MICETRO_ON, extra_rows=V6_ROW_NONAME)
    with TestClient(_app(conf)) as client:
        coverage = client.get("/api/ddi").json()["fdb_coverage"]
    assert coverage["macs"] == 3          # three MACs in the FDB
    assert coverage["resolved"] == 2      # two of them are named
    assert coverage["resolved"] <= coverage["macs"]


def test_summary_enabled_with_zero_rows_is_not_reported_as_disabled(tmp_path):
    """An enabled source that swept nothing is a fault, not an absence."""
    with TestClient(_app(_setup(tmp_path, MICETRO_ON, seed=False))) as client:
        assert client.get("/api/ddi").json()["enabled"] is True


# --- /api/ddi/addresses -----------------------------------------------------


def test_addresses_are_paged_and_carry_freshness(tmp_path):
    with TestClient(_app(_setup(tmp_path, MICETRO_ON))) as client:
        body = client.get("/api/ddi/addresses?limit=1").json()
    assert body["total"] == 2 and len(body["addresses"]) == 1
    assert body["updated_at"] is not None
    assert body["addresses"][0]["updated_at"] is not None


def test_addresses_q_matches_ip_prefix(tmp_path):
    with TestClient(_app(_setup(tmp_path, MICETRO_ON))) as client:
        body = client.get("/api/ddi/addresses?q=192.0.2.6").json()
    assert [a["ip"] for a in body["addresses"]] == ["192.0.2.60"]


def test_addresses_q_matches_a_hostname_fragment(tmp_path):
    with TestClient(_app(_setup(tmp_path, MICETRO_ON))) as client:
        body = client.get("/api/ddi/addresses?q=printer3").json()
    assert [a["ip"] for a in body["addresses"]] == ["192.0.2.60"]


def test_addresses_q_matches_a_separatorless_mac(tmp_path):
    """Operators paste what is on the label."""
    with TestClient(_app(_setup(tmp_path, MICETRO_ON))) as client:
        body = client.get("/api/ddi/addresses?q=02005e100002").json()
    assert [a["ip"] for a in body["addresses"]] == ["192.0.2.60"]


def test_addresses_mac_filter_accepts_any_separator_style(tmp_path):
    with TestClient(_app(_setup(tmp_path, MICETRO_ON))) as client:
        for style in ("02-00-5E-10-00-02", "02:00:5e:10:00:02", "02005e100002"):
            body = client.get(f"/api/ddi/addresses?mac={style}").json()
            assert [a["ip"] for a in body["addresses"]] == ["192.0.2.60"], style


def test_addresses_mac_filter_rejects_a_hostname(tmp_path):
    with TestClient(_app(_setup(tmp_path, MICETRO_ON, seed=False))) as client:
        assert client.get("/api/ddi/addresses?mac=not-a-mac").status_code == 400


def test_addresses_state_filter(tmp_path):
    with TestClient(_app(_setup(tmp_path, MICETRO_ON))) as client:
        assert client.get("/api/ddi/addresses?state=assigned").json()["total"] == 2
        assert client.get("/api/ddi/addresses?state=held").json()["total"] == 0


# --- /api/ddi/lookup --------------------------------------------------------


def test_lookup_returns_every_address_a_mac_holds_strongest_first(tmp_path):
    conf = _setup(tmp_path, MICETRO_ON, extra_rows=V6_ROW_NONAME)
    with TestClient(_app(conf)) as client:
        body = client.get("/api/ddi/lookup/02005e100002").json()
    assert body["mac"] == "02:00:5e:10:00:02"
    assert [a["ip"] for a in body["addresses"]] == ["192.0.2.60", "2001:db8::60"]


def test_lookup_rejects_a_partial_mac(tmp_path):
    with TestClient(_app(_setup(tmp_path, MICETRO_ON, seed=False))) as client:
        assert client.get("/api/ddi/lookup/02005e").status_code == 400


def test_lookup_of_an_unknown_mac_is_an_empty_list_not_404(tmp_path):
    with TestClient(_app(_setup(tmp_path, MICETRO_ON))) as client:
        body = client.get("/api/ddi/lookup/02005e1000ff").json()
    assert body["addresses"] == []


# --- /api/ddi/scopes --------------------------------------------------------


def test_scopes_sort_worst_first_with_unknown_above_ok(tmp_path):
    """A scope with no utilization figure is an open question, not a healthy one."""
    with TestClient(_app(_setup(tmp_path, MICETRO_ON))) as client:
        rows = client.get("/api/ddi/scopes").json()["scopes"]
    assert [r["severity"] for r in rows] == ["crit", "unknown", "ok"]


def test_scopes_severity_filter(tmp_path):
    with TestClient(_app(_setup(tmp_path, MICETRO_ON))) as client:
        rows = client.get("/api/ddi/scopes?severity=crit").json()["scopes"]
    assert [r["name"] for r in rows] == ["CHS-Wireless"]


# --- auth -------------------------------------------------------------------


def test_ddi_endpoints_require_auth(tmp_path):
    conf = _setup(tmp_path, MICETRO_ON, dev_bypass=False)
    with TestClient(_app(conf)) as client:
        for path in ("/api/ddi", "/api/ddi/addresses", "/api/ddi/scopes",
                     "/api/ddi/lookup/02005e100002"):
            assert client.get(path).status_code in (401, 403), path
