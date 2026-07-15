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


def test_build_fdb_maps_mac_to_ifindex():
    w = _walks(si._SWEEP_OIDS["fdb"][2])
    rows = si.build_fdb(w["fdb_port"], w["base_port_ifindex"])
    macs = {r["mac"]: r["ifindex"] for r in rows}
    assert macs == {"00:0b:82:01:02:03": 1001, "aa:bb:cc:dd:ee:ff": 1001}


def test_mac_from_fdb_suffix():
    assert si.mac_from_fdb_suffix("0.11.130.1.2.3") == "00:0b:82:01:02:03"
    assert si.mac_from_fdb_suffix("1.2.3") is None  # wrong length


def test_build_lldp():
    rows = si.build_lldp(_walks(si._SWEEP_OIDS["lldp"][2]))
    assert len(rows) == 1
    n = rows[0]
    assert n["local_ifindex"] == 1001 and n["remote_sysname"] == "core-1"
    assert n["remote_port"] == "Uplink to distribution"
    assert n["remote_chassis"] == "00:04:96:aa:bb:cc"


def test_build_vlans():
    rows = {r["vlan_id"]: r for r in si.build_vlans(_walks(si._SWEEP_OIDS["vlans"][2]))}
    assert set(rows) == {100, 200}
    assert rows[100]["name"] == "Data" and rows[100]["admin_up"] == 1


def test_build_stack():
    rows = si.build_stack(_walks(si._SWEEP_OIDS["stack"][2]))
    assert len(rows) == 1
    s = rows[0]
    assert s["slot"] == 1 and s["cpu_pct"] == 12 and s["temp_c"] == 38
    assert s["mem_pct"] == 40.0  # (1_000_000 - 600_000) / 1_000_000 * 100


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
        return {root: FIXTURE for root in roots}

    c = si.SnmpInventory(engine, cfg, PollerConfig(), walk_fn=fake_walk)
    c._force_all = True
    return c


def test_run_once_populates_all_tables(tmp_path):
    engine = _engine_with_switch(tmp_path)
    c = _collector(engine)
    written = asyncio.run(c.run_once())
    assert written == 2 + 2 + 1 + 2 + 1  # ports + fdb + lldp + vlans + stack

    ports = db.fetch_all(engine, "SELECT * FROM switch_ports WHERE device_id=1 ORDER BY ifindex")
    assert [p["oper_state"] for p in ports] == ["up", "down"]
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM fdb_entries")["n"] == 2
    lldp = db.fetch_one(engine, "SELECT remote_sysname FROM lldp_neighbors WHERE local_ifindex=1001")
    assert lldp["remote_sysname"] == "core-1"
    assert db.fetch_one(engine, "SELECT COUNT(*) AS n FROM switch_vlans")["n"] == 2
    stack = db.fetch_one(engine, "SELECT * FROM stack_members WHERE slot=1")
    assert stack["mem_pct"] == 40.0

    # First sweep leaves rates NULL (no prior sample) but stores prev_counters.
    assert ports[0]["in_kbps"] is None
    assert json.loads(ports[0]["prev_counters"])["in_octets"] == 1000000


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

    c = si.SnmpInventory(engine, cfg, PollerConfig(), walk_fn=boom)
    c._force_all = True
    asyncio.run(c.run_guarded())  # guarded: records error, does not raise
    h = db.fetch_one(engine, "SELECT * FROM collector_health WHERE name='snmp_inventory'")
    assert h["consecutive_failures"] == 1 and "timeout" in (h["last_error"] or "")
