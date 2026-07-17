"""SNMP inventory sweeps: pure-parser tests + a full fixture-driven run_once.

No binaries required — the subprocess walk is injected with fixture text
(spec 10 §4.8: fixtures + parse tests before live).
"""

import asyncio
import json
from pathlib import Path

from netmon import db
from netmon.config import PollerConfig, SnmpInventoryConfig
from netmon.poller import snmp_inventory as si
from tests.conftest import create_core_tables

FIXTURE = (Path(__file__).parent / "fixtures" / "snmp_exos_stack.txt").read_text()
POE_FIXTURE = (Path(__file__).parent / "fixtures" / "snmp_exos_poe.txt").read_text()
ENTITY_FIXTURE = (Path(__file__).parent / "fixtures" / "snmp_exos_entity.txt").read_text()
ALL_FIXTURES = FIXTURE + "\n" + POE_FIXTURE + "\n" + ENTITY_FIXTURE


def _walks(keys):
    """Parse the combined fixture for a set of OID keys (mimics _walk_keys)."""
    return {k: si.parse_walk(FIXTURE, si.OID[k]) for k in keys}


# ---- pure parsers ----------------------------------------------------------

def test_parse_walk_strips_root_and_types():
    w = si.parse_walk(FIXTURE, si.OID["if_oper"])
    assert w == {"1001": "up(1)", "1002": "down(2)"}
    names = si.parse_walk(FIXTURE, si.OID["if_name"])
    assert names["1001"] == "1:1"  # quotes stripped


def test_build_ports():
    rows = {r["ifindex"]: r for r in si.build_ports(_walks(si._SWEEP_OIDS["ports"][2]))}
    assert set(rows) == {1001, 1002}
    p = rows[1001]
    assert p["oper_state"] == "up" and p["member"] == 1 and p["name"] == "1:1"
    assert p["admin_up"] == 1 and p["speed_mbps"] == 1000 and p["duplex"] == "full"
    assert p["in_octets"] == 1000000 and p["err_in"] == 5
    assert rows[1002]["oper_state"] == "down" and rows[1002]["duplex"] == "half"


def test_is_physical_port_exos_semantics():
    """Owner-supplied EXOS ifIndex rules (2026-07-16): VLAN interfaces
    (>=1M), slot mgmt ports (x000), stacking ports (x2xx) are not
    front-panel ports."""
    assert si.is_physical_port(1001)          # slot 1 port 1
    assert si.is_physical_port(2048)          # slot 2 port 48
    assert si.is_physical_port(1199)          # top of the front-panel range
    assert not si.is_physical_port(1000)      # slot 1 mgmt
    assert not si.is_physical_port(2000)      # slot 2 mgmt
    assert not si.is_physical_port(1257)      # stacking
    assert not si.is_physical_port(2258)      # stacking
    assert not si.is_physical_port(1000001)   # VLAN interface
    assert not si.is_physical_port(1203960)   # VLAN interface


def test_build_ports_drops_non_physical_interfaces():
    oper_root = si.OID["if_oper"]
    text = "\n".join(
        f".{oper_root}.{idx} = INTEGER: up(1)"
        for idx in (1001, 1000, 1257, 1000001)
    )
    walks = {"if_oper": si.parse_walk(text, oper_root)}
    rows = si.build_ports(walks)
    assert [r["ifindex"] for r in rows] == [1001]


def test_build_fdb_maps_mac_to_ifindex():
    w = _walks(si._SWEEP_OIDS["fdb"][2])
    rows = si.build_fdb(w["fdb_port"], w["base_port_ifindex"])
    macs = {r["mac"]: r["ifindex"] for r in rows}
    assert macs == {"00:0b:82:01:02:03": 1001, "aa:bb:cc:dd:ee:ff": 1001}


def test_mac_from_fdb_suffix():
    assert si.mac_from_fdb_suffix("0.11.130.1.2.3") == "00:0b:82:01:02:03"
    assert si.mac_from_fdb_suffix("1.2.3") is None  # wrong length


def test_build_edp():
    rows = si.build_edp(_walks(si._SWEEP_OIDS["edp"][2]))
    assert len(rows) == 1
    n = rows[0]
    assert n["local_ifindex"] == 1001        # table indexed by local ifIndex (1001.0)
    assert n["remote_sysname"] == "CHS-CORE-MDF"
    assert n["remote_port"] == "1:50"        # neighbor slot:port
    assert n["remote_sysdesc"] == "31.7.1.4"  # neighbor EXOS version
    assert n["protocol"] == "edp" and n["age_s"] == 12
    assert n["remote_chassis"] is None       # EDP carries no chassis MAC


EDP_FIXTURE = (Path(__file__).parent / "fixtures" / "snmp_exos_edp.txt").read_text()


def test_build_edp_real_walk_multi_octet_index():
    """Real extremeEdpTable index is <localIfIndex>.<neighbor MAC octets>; the
    local ifIndex is the first component verbatim (1049 = 1:49), never
    slot*1000+port."""
    walks = {k: si.parse_walk(EDP_FIXTURE, si.OID[k]) for k in si._SWEEP_OIDS["edp"][2]}
    rows = {r["local_ifindex"]: r for r in si.build_edp(walks)}
    assert set(rows) == {1049, 1050, 2051}
    assert rows[1049]["remote_sysname"] == "EMS-MDF-CORE"
    assert rows[1049]["remote_port"] == "1:50"        # neighbor slot 1 port 50
    assert rows[1050]["remote_sysname"] == "BHS_G109" and rows[1050]["remote_port"] == "1:49"
    assert rows[2051]["age_s"] == 24


def test_build_vlans():
    rows = {r["vlan_id"]: r for r in si.build_vlans(_walks(si._SWEEP_OIDS["vlans"][2]))}
    assert set(rows) == {100, 200}
    assert rows[100]["name"] == "Data" and rows[100]["admin_up"] == 1


def test_build_poe_ports():
    walks = {k: si.parse_walk(POE_FIXTURE, si.OID[k]) for k in si._SWEEP_OIDS["poe"][2]}
    rows = {r["ifindex"]: r for r in si.build_poe_ports(walks)}
    # 2:2 reads detection status 0 -> not PoE-capable -> skipped entirely.
    assert set(rows) == {1001, 1002}
    p = rows[1001]  # delivering: real values from the owner's walk
    assert p["poe_delivering"] == 1 and p["poe_admin"] == 1
    assert p["poe_class"] == "class3"       # enum 4 -> IEEE class 3
    assert p["poe_watts"] == 5.3            # 5300 mW
    q = rows[1002]  # searching
    assert q["poe_delivering"] == 0 and q["poe_class"] == "class0"
    assert q["poe_watts"] == 0


def test_build_poe_slots():
    walks = {k: si.parse_walk(POE_FIXTURE, si.OID[k]) for k in si._SWEEP_OIDS["poe"][2]}
    rows = {r["slot"]: r for r in si.build_poe_slots(walks)}
    assert set(rows) == {1, 2}
    s1 = rows[1]
    assert s1["poe_status"] == "operational"
    assert s1["poe_budget_w"] == 380 and s1["poe_avail_w"] == 380
    assert s1["poe_capacity_w"] == 720
    assert s1["poe_alloc_w"] == 45 and s1["poe_measured_w"] == 39
    assert rows[2]["poe_status"] == "notOperational"


def test_build_entity_slots():
    walks = {k: si.parse_walk(ENTITY_FIXTURE, si.OID[k]) for k in si._SWEEP_OIDS["entity"][2]}
    rows = {r["slot"]: r for r in si.build_entity_slots(walks)}
    assert set(rows) == {1, 2}
    s1 = rows[1]
    assert s1["model"] == "X465-48P"          # module descr, not the part number
    assert s1["serial"] == "0000F-00001"
    assert s1["fw_version"] == "33.5.1.6"
    assert s1["fans"] == ["FanTray 1", "FanTray 2"]
    assert s1["psus"] == ["bay 1: PowerSupply-Internal"]
    s2 = rows[2]
    assert s2["serial"] == "0000F-00002" and s2["fans"] == ["FanTray 1"]
    # The VIM option module (class 9 in an "Option Slot" container) must not
    # have overwritten any slot's identity.
    assert all(r["model"] == "X465-48P" for r in rows.values())


SFP_FIXTURE = (Path(__file__).parent / "fixtures" / "snmp_exos_sfp.txt").read_text()


def test_build_sfp_ports_real_x465_walk():
    """Verified against the owner's live X465-48P ENTITY-MIB walk: the 1 Gbps
    base ports are copper (0); the 10/40 Gbps uplinks are SFP+/QSFP cages (1),
    flagged from the port speed descr + entAliasMappingTable."""
    keys = ["ent_descr", "ent_contained", "ent_class", "ent_alias"]
    walks = {k: si.parse_walk(SFP_FIXTURE, si.OID[k]) for k in keys}
    rows = {r["ifindex"]: r["is_sfp"] for r in si.build_sfp_ports(walks)}
    assert rows == {1001: 0, 1002: 0, 1048: 0, 1049: 1, 1050: 1, 1053: 1}


# Synthetic walk exercising the secondary DOM/containment path: a 1 Gbps port
# with an "SFP … Sensor" child, and a sensor nested under a transceiver under a
# port — both must resolve up to the port even though the port descr is 1 Gbps.
_SFP_DOM_WALK = """
.1.3.6.1.2.1.47.1.1.1.1.2.10 = STRING: "1 Gbps Ethernet Port"
.1.3.6.1.2.1.47.1.1.1.1.5.10 = INTEGER: 10
.1.3.6.1.2.1.47.1.3.2.1.2.10.0 = OID: .1.3.6.1.2.1.2.2.1.1.1010
.1.3.6.1.2.1.47.1.1.1.1.2.11 = STRING: "SFP RX Power Sensor"
.1.3.6.1.2.1.47.1.1.1.1.5.11 = INTEGER: 8
.1.3.6.1.2.1.47.1.1.1.1.4.11 = INTEGER: 10
.1.3.6.1.2.1.47.1.1.1.1.2.20 = STRING: "1 Gbps Ethernet Port"
.1.3.6.1.2.1.47.1.1.1.1.5.20 = INTEGER: 10
.1.3.6.1.2.1.47.1.3.2.1.2.20.0 = OID: .1.3.6.1.2.1.2.2.1.1.1020
.1.3.6.1.2.1.47.1.1.1.1.2.21 = STRING: "10GBASE-SR Transceiver"
.1.3.6.1.2.1.47.1.1.1.1.5.21 = INTEGER: 9
.1.3.6.1.2.1.47.1.1.1.1.4.21 = INTEGER: 20
.1.3.6.1.2.1.47.1.1.1.1.2.22 = STRING: "SFP TX Power Sensor"
.1.3.6.1.2.1.47.1.1.1.1.5.22 = INTEGER: 8
.1.3.6.1.2.1.47.1.1.1.1.4.22 = INTEGER: 21
.1.3.6.1.2.1.47.1.1.1.1.2.30 = STRING: "1 Gbps Ethernet Port"
.1.3.6.1.2.1.47.1.1.1.1.5.30 = INTEGER: 10
.1.3.6.1.2.1.47.1.3.2.1.2.30.0 = OID: .1.3.6.1.2.1.2.2.1.1.1030
"""


def test_build_sfp_ports_dom_containment():
    keys = ["ent_descr", "ent_contained", "ent_class", "ent_alias"]
    walks = {k: si.parse_walk(_SFP_DOM_WALK, si.OID[k]) for k in keys}
    rows = {r["ifindex"]: r["is_sfp"] for r in si.build_sfp_ports(walks)}
    # 1010: 1 Gbps port with a direct SFP DOM-sensor child → 1
    # 1020: 1 Gbps port with sensor→transceiver→port nesting → 1 (walk-up)
    # 1030: plain 1 Gbps copper port → 0
    assert rows == {1010: 1, 1020: 1, 1030: 0}


def test_build_sfp_ports_empty_without_entity_alias():
    # No entAliasMappingTable → nothing can be tied to an ifIndex → no rows
    # (honest: leaves is_sfp NULL rather than guessing).
    assert si.build_sfp_ports({"ent_descr": {}, "ent_class": {}, "ent_alias": {}}) == []


def test_build_stack():
    rows = si.build_stack(_walks(si._SWEEP_OIDS["stack"][2]))
    assert len(rows) == 1
    s = rows[0]
    assert s["slot"] == 1 and s["cpu_pct"] == 12 and s["temp_c"] == 38
    assert s["mem_pct"] == 40.0  # (1_000_000 - 600_000) / 1_000_000 * 100
    assert s["status"] == "up"  # extremeStackMemberOperStatus 1 → up


def test_build_stack_status_decode():
    """The Extreme oper-status enum is decoded to a readable label; a code we
    don't have a label for falls through to its raw value rather than blanking."""
    def one(raw):
        return si.build_stack({"stack_status": {"1": raw}})[0]["status"]
    assert one("0") == "unknown"
    assert one("1") == "up"
    assert one("2") == "down"
    assert one("3") == "mismatch"
    assert one("up(1)") == "up"      # MIB-translated form
    assert one("7") == "7"           # unrecognised code preserved


def test_build_stack_honors_custom_status_map():
    """An owner-edited decode map overrides the default labels."""
    walks = {"stack_status": {"1": "1"}}
    custom = {"1": "online"}
    assert si.build_stack(walks, custom)[0]["status"] == "online"
    # a code missing from the custom map falls through to the raw value
    assert si.build_stack({"stack_status": {"1": "2"}}, custom)[0]["status"] == "2"


# ---- rate computation ------------------------------------------------------

def test_compute_rates_first_sample_is_null():
    row = {"in_octets": 1000, "out_octets": 2000, "err_in": 5, "err_out": 0,
           "disc_in": 0, "disc_out": 0, "speed_mbps": 1000}
    out = si.compute_rates(row, None, now_ts=100.0)
    assert out["in_kbps"] is None and out["util_pct"] is None
    prev = json.loads(out["prev_counters"])
    assert prev["in_octets"] == 1000 and prev["ts"] == 100.0


def test_compute_rates_second_sample():
    prev = {"in_octets": 0, "out_octets": 0, "err_in": 2, "err_out": 0,
            "disc_in": 0, "disc_out": 0, "ts": 100.0}
    row = {"in_octets": 1_000_000, "out_octets": 500_000, "err_in": 5, "err_out": 1,
           "disc_in": 0, "disc_out": 0, "speed_mbps": 1000}
    out = si.compute_rates(row, prev, now_ts=108.0)  # 8s elapsed
    assert out["in_kbps"] == 1000  # 1e6 octets * 8 / 1000 / 8s
    assert out["out_kbps"] == 500
    assert out["err_in_delta"] == 3 and out["err_out_delta"] == 1
    assert out["util_pct"] == 0.1  # 1000 kbps of a 1_000_000 kbps link


def test_compute_rates_counter_reset_is_null():
    prev = {"in_octets": 9_000_000, "ts": 100.0}
    row = {"in_octets": 10, "speed_mbps": 1000}  # counter reset/rollover
    out = si.compute_rates(row, prev, now_ts=110.0)
    assert out["in_kbps"] is None


# ---- full run_once against the fixture -------------------------------------

def _engine_with_switch(tmp_path):
    engine = db.make_engine(f"sqlite:///{tmp_path/'inv.db'}")
    create_core_tables(engine)
    from sqlalchemy import text
    with engine.begin() as c:
        c.execute(text("INSERT INTO devices (name, site, device_type, mgmt_ip, snmp_capable, enabled) "
                       "VALUES ('BHS-Core-1','BHS','switch','192.0.2.2',1,1)"))
        # a non-switch and a non-snmp switch that must be skipped
        c.execute(text("INSERT INTO devices (name, device_type, mgmt_ip, snmp_capable, enabled) "
                       "VALUES ('BHS-AP-1','ap','192.0.2.3',0,1)"))
    return engine


def _collector(engine):
    cfg = SnmpInventoryConfig(enabled=True)

    async def fake_walk(host, roots):
        assert host == "192.0.2.2"  # only the snmp-capable switch is swept
        # parse_walk filters by root, so serving the combined text for every
        # root mimics a real device answering all tables.
        return {root: ALL_FIXTURES for root in roots}

    c = si.SnmpInventory(engine, cfg, PollerConfig(snmp_community="test-ro"), walk_fn=fake_walk)
    c._force_all = True
    return c


def test_run_once_populates_all_tables(tmp_path):
    engine = _engine_with_switch(tmp_path)
    c = _collector(engine)
    written = asyncio.run(c.run_once())
    # ports + fdb + edp + vlans + stack + poe (2 ports + 2 slots)
    # + entity (2 slots)
    assert written == 2 + 2 + 1 + 2 + 1 + 4 + 2

    ports = db.fetch_all(engine, "SELECT * FROM switch_ports WHERE device_id=1 ORDER BY ifindex")
    assert [p["oper_state"] for p in ports] == ["up", "down"]
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM fdb_entries")["n"] == 2
    edp = db.fetch_one(engine, "SELECT remote_sysname, protocol FROM neighbors WHERE local_ifindex=1001")
    assert edp["remote_sysname"] == "CHS-CORE-MDF" and edp["protocol"] == "edp"
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM switch_vlans")["n"] == 2
    stack = db.fetch_one(engine, "SELECT * FROM stack_members WHERE slot=1")
    assert stack["mem_pct"] == 40.0

    # First sweep leaves rates NULL (no prior sample) but stores prev_counters.
    assert ports[0]["in_kbps"] is None
    assert json.loads(ports[0]["prev_counters"])["in_octets"] == 1000000

    # PoE landed on the port rows (1:1 delivering 5.3 W) and the stack slot.
    assert ports[0]["poe_delivering"] == 1 and ports[0]["poe_watts"] == 5.3
    assert ports[0]["poe_class"] == "class3"
    assert ports[1]["poe_delivering"] == 0
    assert stack["poe_status"] == "operational" and stack["poe_budget_w"] == 380
    assert stack["poe_measured_w"] == 39

    # Entity inventory landed on the same slot row.
    assert stack["model"] == "X465-48P" and stack["serial"] == "0000F-00001"
    assert stack["fw_version"] == "33.5.1.6"
    assert json.loads(stack["fans"]) == ["FanTray 1", "FanTray 2"]
    assert json.loads(stack["psus"]) == ["bay 1: PowerSupply-Internal"]


def test_poe_update_never_bumps_owning_sweep_freshness(tmp_path):
    """The PoE pass partially updates rows the ports sweep owns — it must not
    refresh updated_at, or a stalled ports sweep would look fresh (§4.5)."""
    engine = _engine_with_switch(tmp_path)
    asyncio.run(_collector(engine).run_once())
    before = db.fetch_one(
        engine, "SELECT updated_at, poe_watts FROM switch_ports WHERE ifindex = 1001")
    c2 = _collector(engine)
    c2._write_poe(1, [{"ifindex": 1001, "poe_admin": 1, "poe_delivering": 1,
                       "poe_class": "class3", "poe_watts": 7.7}], [])
    after = db.fetch_one(
        engine, "SELECT updated_at, poe_watts FROM switch_ports WHERE ifindex = 1001")
    assert after["poe_watts"] == 7.7            # PoE data refreshed…
    assert after["updated_at"] == before["updated_at"]  # …freshness untouched


def test_run_once_prunes_disappeared_rows(tmp_path):
    engine = _engine_with_switch(tmp_path)
    # Pre-seed a stale port + fdb that the sweep will NOT see → must be pruned.
    db.upsert(engine, "switch_ports", {"device_id": 1, "ifindex": 9999},
              {"oper_state": "up"})
    db.upsert(engine, "fdb_entries", {"device_id": 1, "mac": "de:ad:be:ef:00:00"}, {"ifindex": 1})
    asyncio.run(_collector(engine).run_once())
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM switch_ports WHERE ifindex=9999")["n"] == 0
    assert db.fetch_one(engine,
        "SELECT COUNT(*) AS n FROM fdb_entries WHERE mac='de:ad:be:ef:00:00'")["n"] == 0


def test_second_pass_computes_rates_via_batched_prev(tmp_path):
    """Two consecutive ports passes: the second must produce rates from the
    first pass's prev_counters (read in one per-switch query, not per port)."""
    engine = _engine_with_switch(tmp_path)
    c = _collector(engine)
    asyncio.run(c.run_once())
    c._force_all = True  # make everything due again immediately
    asyncio.run(c.run_once())
    p = db.fetch_one(
        engine, "SELECT in_kbps, err_in_delta FROM switch_ports WHERE ifindex = 1001"
    )
    # Same fixture counters twice -> zero deltas/rates, but NOT NULL: the
    # previous sample was found and used.
    assert p["in_kbps"] == 0 and p["err_in_delta"] == 0


def test_run_once_records_collector_health(tmp_path):
    engine = _engine_with_switch(tmp_path)
    asyncio.run(_collector(engine).run_guarded())
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='snmp_inventory'")
    assert h is not None and h["consecutive_failures"] == 0 and h["last_success"] is not None


def test_all_switches_failing_records_error(tmp_path):
    engine = _engine_with_switch(tmp_path)
    cfg = SnmpInventoryConfig(enabled=True)

    async def boom(host, roots):
        raise RuntimeError("timeout")

    c = si.SnmpInventory(engine, cfg, PollerConfig(snmp_community="test-ro"), walk_fn=boom)
    c._force_all = True
    asyncio.run(c.run_guarded())  # guarded: records error, does not raise
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='snmp_inventory'")
    assert h["consecutive_failures"] == 1 and "timeout" in (h["last_error"] or "")


def test_run_once_logs_pass_progress_and_verbose_detail(tmp_path, caplog):
    """INFO = per-sweep pass progress (default CLI); DEBUG = per-switch rows."""
    import logging as _logging
    engine = _engine_with_switch(tmp_path)
    with caplog.at_level(_logging.DEBUG, logger="netmon.snmp_inventory"):
        asyncio.run(_collector(engine).run_once())
    info = [r.message for r in caplog.records if r.levelno == _logging.INFO]
    debug = [r.message for r in caplog.records if r.levelno == _logging.DEBUG]
    assert any(m.startswith("run: sweep(s) due:") for m in info)
    assert any(m.startswith("sweep ports done:") for m in info)
    # -v detail: per-switch line names the switch and its row count.
    assert any("BHS-Core-1" in m and "row(s)" in m for m in debug)


def test_empty_community_fails_loud_before_sweeping(tmp_path):
    """An empty community can only produce fleet-wide silent timeouts — the
    run must refuse with a pointed error, not burn a pass and report the
    switches as unreachable (field regression)."""
    engine = _engine_with_switch(tmp_path)
    cfg = SnmpInventoryConfig(enabled=True)
    walked = []

    async def fake_walk(host, roots):
        walked.append(host)
        return {root: FIXTURE for root in roots}

    c = si.SnmpInventory(engine, cfg, PollerConfig(), walk_fn=fake_walk)  # no community
    c._force_all = True
    asyncio.run(c.run_guarded())
    assert walked == []  # refused before touching any switch
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='snmp_inventory'")
    assert "snmp_community is empty" in (h["last_error"] or "")


def test_quoted_community_warns_and_fingerprint_logged(tmp_path, caplog):
    import logging as _logging
    engine = _engine_with_switch(tmp_path)
    cfg = SnmpInventoryConfig(enabled=True)

    async def fake_walk(host, roots):
        return {root: FIXTURE for root in roots}

    c = si.SnmpInventory(engine, cfg, PollerConfig(snmp_community='"secret"'),
                         walk_fn=fake_walk)
    c._force_all = True
    with caplog.at_level(_logging.DEBUG, logger="netmon.snmp_inventory"):
        asyncio.run(c.run_once())
    messages = [r.message for r in caplog.records]
    assert any("looks quoted or padded" in m for m in messages)
    # The -v fingerprint names length + sha256 prefix — never the value.
    fp = [m for m in messages if m.startswith("snmp credentials:")]
    assert fp and "len=8" in fp[0] and "secret" not in fp[0]


# ---- run budget / cancellation (the 120s-timeout regression) ----------------

def test_run_timeout_decoupled_from_fastest_interval():
    """The supervised timeout is the run budget, never the fastest interval —
    the first full-fleet run (all sweeps due) legitimately outlives 120s."""
    cfg = SnmpInventoryConfig(enabled=True)  # ports_interval_s=120, run_timeout_s=900
    c = si.SnmpInventory(None, cfg, PollerConfig(), walk_fn=lambda h, r: None)
    assert c.interval_s == 120.0
    assert c.timeout_s == 900.0
    # A budget below the fastest interval is nonsense — the interval wins.
    small = SnmpInventoryConfig(enabled=True, run_timeout_s=60)
    c2 = si.SnmpInventory(None, small, PollerConfig(), walk_fn=lambda h, r: None)
    assert c2.timeout_s == c2.interval_s == 120.0


def test_cancelled_run_keeps_completed_sweeps_and_records_health(tmp_path):
    """Cancellation mid-run (the supervisor budget) must (a) keep _last_run
    for sweeps whose fleet pass finished — no all-due retry loop — and
    (b) land in collector_health as an error, never a silently green pill."""
    engine = _engine_with_switch(tmp_path)
    cfg = SnmpInventoryConfig(enabled=True)

    async def walk_until_fdb(host, roots):
        # ports and stack pass normally; the heavy fdb pass gets "cancelled"
        # exactly as asyncio.wait_for would cancel the awaited walk.
        if si.OID["fdb_port"] in roots:
            raise asyncio.CancelledError()
        return {root: FIXTURE for root in roots}

    c = si.SnmpInventory(engine, cfg, PollerConfig(snmp_community="test-ro"), walk_fn=walk_until_fdb)
    c._force_all = True

    import pytest
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(c.run_guarded())

    # ports + stack fleet passes completed before the cancel → marked done;
    # fdb (and the passes after it) did not.
    assert "ports" in c._last_run and "stack" in c._last_run
    assert "fdb" not in c._last_run and "edp" not in c._last_run
    # The completed passes' data is in the DB.
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM switch_ports")["n"] == 2
    # And the cancellation is loud in collector_health (§4.5).
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='snmp_inventory'")
    assert h["consecutive_failures"] == 1
    assert "cancelled" in (h["last_error"] or "")
