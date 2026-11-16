"""Direct SNMP switch operations (spec 26).

Weighted, like test_actions_api, towards proving what is *not* sent: every
refusal must leave the switch untouched, dry run must never call snmpset, and a
port taken down must come back even if the process dies half-way.

The switch is a fake net-snmp: a dict of numeric OIDs answering
snmpget/snmpbulkwalk/snmpset argv exactly as the real binaries are called.
"""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.actions import ActionRefused
from netmon.app import create_app
from netmon.config import ConfigError, EngineConfig, PollerConfig, SwitchOpsConfig, load_config
from netmon.supervisor import Supervisor
from netmon.switchops import live as L
from netmon.switchops import ops
from netmon.switchops import ports as P
from netmon.switchops import snmp as S
from tests.conftest import create_core_tables, write_config

IP = "192.0.2.2"
SW = 1          # devices.id of the switch
CAM_PORT = "1:12"   # copper access port, PoE, a camera on it
UPLINK = "1:49"     # SFP uplink with an EDP neighbour


# ───────────────────────── fake switch ─────────────────────────

class FakeSwitch:
    def __init__(self) -> None:
        self.oids: dict[str, str] = {}
        self.calls: list[tuple[list[str], dict[str, str]]] = []
        self.sets: list[tuple[str, int]] = []
        self.refuse_set: set[str] = set()      # oids answering notWritable
        self.silent_set: set[str] = set()      # oids answering nothing (timeout)
        self.down = False                     # whole switch unreachable
        for slot_port, ifx in ((("1", "12"), 1012), (("1", "49"), 1049), (("1", "13"), 1013)):
            idx = ".".join(slot_port)
            self.oids[f"{S.IF_ADMIN}.{ifx}"] = "INTEGER: 1"
            self.oids[f"{S.IF_OPER}.{ifx}"] = "INTEGER: 1"
            self.oids[f"{S.PETH_ADMIN}.{idx}"] = "INTEGER: 1"
            self.oids[f"{S.PETH_DETECT}.{idx}"] = "INTEGER: 3"
            self.oids[f"{S.EXT_POE_RESET}.{idx}"] = "INTEGER: 2"
            self.oids[f"{S.EXT_POE_MW}.{idx}"] = "Gauge32: 5300"
            self.oids[f"{S.IF_HC_IN}.{ifx}"] = "Counter64: 1000"
            self.oids[f"{S.IF_HC_OUT}.{ifx}"] = "Counter64: 2000"
        # FDB: camera MAC 00:0b:82:01:02:03 on bridge port 12 -> ifIndex 1012
        self.oids[f"{S.BASE_PORT_IFINDEX}.12"] = "INTEGER: 1012"
        self.oids[f"{S.FDB_PORT}.0.11.130.1.2.3"] = "INTEGER: 12"

    def _line(self, oid: str) -> str:
        v = self.oids.get(oid)
        if v is None:
            return f".{oid} = No Such Instance currently exists at this OID"
        return f".{oid} = {v}"

    async def run(self, argv: list[str], env: dict[str, str]) -> tuple[int, str, str]:
        self.calls.append((list(argv), dict(env)))
        prog = argv[0]
        if self.down:
            return 1, "", f"Timeout: No Response from {IP}"
        if prog == "snmpget":
            oids = argv[argv.index(IP) + 1:]
            return 0, "\n".join(self._line(o) for o in oids), ""
        if prog == "snmpbulkwalk":
            root = argv[-1]
            return 0, "\n".join(self._line(o) for o in sorted(self.oids)
                                if o.startswith(root + ".")), ""
        if prog == "snmpset":
            oid, _t, val = argv[-3], argv[-2], argv[-1]
            if oid in self.silent_set:
                return 1, "", f"Timeout: No Response from {IP}."
            if oid in self.refuse_set:
                return 2, "", "Error in packet.\nReason: notWritable (That object does not support modification)"
            self.sets.append((oid, int(val)))
            self.oids[oid] = f"INTEGER: {val}"
            return 0, f".{oid} = INTEGER: {val}", ""
        raise AssertionError(f"unexpected binary {prog}")

    def set_calls(self) -> list[list[str]]:
        return [a for a, _ in self.calls if a[0] == "snmpset"]


# ───────────────────────── fixtures ─────────────────────────

@pytest.fixture
def engine(tmp_path):
    e = db.make_engine(f"sqlite:///{tmp_path / 'netmon.db'}")
    create_core_tables(e)
    with e.begin() as c:
        c.execute(text(
            "INSERT INTO devices (id, name, site, device_type, mgmt_ip, snmp_capable, enabled) "
            "VALUES (1,'BHS-IDF1','BHS','switch',:ip,1,1), (2,'BHS-CORE','BHS','switch','192.0.2.1',1,1),"
            "       (3,'BHS-CAM-7','BHS','camera','192.0.2.70',0,1)"), {"ip": IP})
        c.execute(text(
            "INSERT INTO switch_ports (device_id, ifindex, name, admin_up, is_sfp, poe_admin, updated_at) "
            "VALUES (1,1012,'1:12',1,0,1,CURRENT_TIMESTAMP), (1,1049,'1:49',1,1,1,CURRENT_TIMESTAMP),"
            "       (1,1013,'1:13',1,0,1,CURRENT_TIMESTAMP), (1,1000,'1:0',1,0,NULL,CURRENT_TIMESTAMP),"
            "       (1,1014,'1:14',1,0,NULL,CURRENT_TIMESTAMP), (1,2015,'1:15',1,0,1,CURRENT_TIMESTAMP)"))
        c.execute(text("INSERT INTO neighbors (device_id, local_ifindex, remote_sysname, protocol) "
                       "VALUES (1,1049,'BHS-CORE','edp'), (1,1012,'AXIS-CAM','lldp'),"
                       "       (1,1013,'BHS-CORE','lldp')"))
        c.execute(text("INSERT INTO fdb_entries (device_id, mac, ifindex, updated_at) "
                       "VALUES (1,'00:0b:82:01:02:03',1012,CURRENT_TIMESTAMP)"))
        c.execute(text("INSERT INTO alert_rules (name, dimension, device_types, `condition`, "
                       "severity, enabled, managed_by) VALUES ('switch_port_restore','switch_ops',"
                       "'switch','{\"op\":\"eq\",\"value\":\"overdue\"}','crit',1,'switch_ops')"))
    yield e
    e.dispose()


def _cfg(**kw) -> SwitchOpsConfig:
    base = dict(enabled=True, dry_run=False, v3_user="netmon-rw", v3_auth_pass="authpass123",
                v3_priv_pass="privpass123", verify_timeout_s=5, cooldown_s=120)
    base.update(kw)
    return dataclasses.replace(SwitchOpsConfig(), **base)


def _rw(cfg, sw):
    return (S.SnmpWriter(cfg, runner=sw.run),
            S.SnmpReader(PollerConfig(snmp_community="public"), cfg, runner=sw.run))


@pytest.fixture
def nosleep(monkeypatch):
    real = asyncio.sleep

    async def _fast(_s, *a, **k):
        await real(0)
    monkeypatch.setattr(ops.asyncio, "sleep", _fast)


def _run(engine, cfg, sw, action, port, *, role="operator", **kw):
    w, r = _rw(cfg, sw)
    return asyncio.run(ops.run_port_action(engine, cfg, w, r, action=action, device_id=SW,
                                           port=port, actor="tester", role=role,
                                           background_verify=False, **kw))


def _audit(engine):
    return db.fetch_all(engine, "SELECT * FROM action_audit ORDER BY id")


def _restores(engine):
    return db.fetch_all(engine, "SELECT * FROM switch_port_restores")


# ───────────────────────── index math ─────────────────────────

def test_port_name_to_slot_and_poe_index():
    assert P.parse_port_name("3:17") == (3, 17)
    assert P.parse_port_name("17") == (1, 17)          # standalone, bare port
    with pytest.raises(ActionRefused):
        P.parse_port_name("ge-0/0/1")
    with pytest.raises(ActionRefused):
        P.parse_port_name("1:257")                      # stacking-port range


def test_resolve_builds_both_indexes(engine):
    p = P.resolve(engine, SW, CAM_PORT)
    assert (p.ifindex, p.slot, p.port, p.poe_index) == (1012, 1, 12, "1.12")
    assert P.resolve(engine, SW, 1012).name == "1:12"   # by ifIndex too


def test_resolve_refuses_management_port_and_inconsistent_index(engine):
    with pytest.raises(ActionRefused, match="not a front-panel port"):
        P.resolve(engine, SW, "1:0")                    # ifIndex 1000 = slot mgmt port
    with pytest.raises(ActionRefused, match="refusing to guess"):
        P.resolve(engine, SW, "1:15")                   # name says 1015, ifIndex 2015


def test_resolve_refuses_non_switch(engine):
    with pytest.raises(ActionRefused, match="not a switch"):
        P.resolve(engine, 3, "1:12")


# ───────────────────────── refusal rules ─────────────────────────

def test_poe_cycle_is_never_refused_for_uplink_signals(engine):
    """Owner decision: a switch draws no PoE, so no neighbour/uplink rule for PoE."""
    p = P.resolve(engine, SW, UPLINK)                   # SFP + EDP neighbour
    assert P.check(engine, p, "snmp_poe_cycle", role="operator").allowed


def test_poe_cycle_refused_on_port_without_poe(engine):
    p = P.resolve(engine, SW, "1:14")
    v = P.check(engine, p, "snmp_poe_cycle", role="operator")
    assert not v.allowed and "no PoE" in v.reasons[0]


def test_bounce_refuses_uplinks_but_not_lldp_endpoints(engine):
    up = P.check(engine, P.resolve(engine, SW, UPLINK), "snmp_port_bounce", role="operator")
    assert not up.allowed and any("EDP" in r for r in up.reasons) and up.overridable
    # A camera sending LLDP is not a switch: allowed.
    cam = P.check(engine, P.resolve(engine, SW, CAM_PORT), "snmp_port_bounce", role="operator")
    assert cam.allowed
    # An LLDP neighbour that IS a registered switch: refused.
    sw = P.check(engine, P.resolve(engine, SW, "1:13"), "snmp_port_bounce", role="operator")
    assert not sw.allowed and "registered switch" in sw.reasons[0]


def test_bounce_refuses_fiber_link_end(engine):
    with engine.begin() as c:
        c.execute(text("INSERT INTO fiber_links (site_a_id, site_b_id, a_device_id, a_ifindex) "
                       "VALUES (1, 2, 1, 1013)"))
    v = P.check(engine, P.resolve(engine, SW, "1:13"), "snmp_port_bounce", role="operator")
    assert any("fiber link" in r for r in v.reasons)


def test_override_needs_admin_and_exact_port_name(engine):
    p = P.resolve(engine, SW, UPLINK)
    assert not P.check(engine, p, "snmp_port_bounce", role="operator",
                       override_confirm=UPLINK).allowed
    assert not P.check(engine, p, "snmp_port_bounce", role="admin",
                       override_confirm="1:4").allowed
    v = P.check(engine, p, "snmp_port_bounce", role="admin", override_confirm=UPLINK)
    assert v.allowed and v.reasons[0].startswith("admin override")


# ───────────────────────── dry run ─────────────────────────

def test_dry_run_never_calls_snmpset_and_records_the_command(engine):
    sw = FakeSwitch()
    res = _run(engine, _cfg(dry_run=True), sw, "snmp_poe_cycle", CAM_PORT)
    assert sw.set_calls() == []
    assert res["dry_run"] and res["ok"]
    assert f"{S.EXT_POE_RESET}.1.12 i 1" in res["commands"][0]
    row = _audit(engine)[-1]
    assert row["outcome"] == "ok" and row["message"].startswith("DRY RUN")
    assert _restores(engine) == []


def test_dry_run_bounce_lists_down_wait_up(engine):
    sw = FakeSwitch()
    res = _run(engine, _cfg(dry_run=True), sw, "snmp_port_bounce", CAM_PORT, down_s=7)
    assert sw.set_calls() == []
    assert res["commands"][0].endswith(f"{S.IF_ADMIN}.1012 i 2   # SNMPv3 user netmon-rw, authPriv SHA/AES")
    assert res["commands"][1] == "sleep 7" and f"{S.IF_ADMIN}.1012 i 1" in res["commands"][2]


def test_dry_run_works_without_credentials(engine):
    sw = FakeSwitch()
    res = _run(engine, _cfg(dry_run=True, v3_user="", v3_auth_pass="", v3_priv_pass=""),
               sw, "snmp_poe_cycle", CAM_PORT)
    assert res["ok"] and "<unset>" in res["commands"][0]


# ───────────────────────── PoE cycle ─────────────────────────

def test_poe_reset_is_one_set_and_secrets_never_on_argv(engine, nosleep):
    sw = FakeSwitch()
    res = _run(engine, _cfg(), sw, "snmp_poe_cycle", CAM_PORT)
    assert res["ok"] and res["method"] == "reset"
    assert sw.sets == [(f"{S.EXT_POE_RESET}.1.12", 1)]
    argv, env = [c for c in sw.calls if c[0][0] == "snmpset"][0]
    assert "authpass123" not in " ".join(argv) and "privpass123" not in " ".join(argv)
    assert "-r" in argv and argv[argv.index("-r") + 1] == "0"     # never retry a SET
    conf = open(env["SNMPCONFPATH"] + "/snmp.conf").read()
    assert "defSecurityLevel authPriv" in conf and "defAuthPassphrase authpass123" in conf
    import os
    assert oct(os.stat(env["SNMPCONFPATH"] + "/snmp.conf").st_mode & 0o777) == "0o600"
    assert _audit(engine)[-1]["outcome"] == "ok"


def test_poe_falls_back_to_admin_off_on_when_reset_refused(engine, nosleep):
    sw = FakeSwitch()
    sw.refuse_set.add(f"{S.EXT_POE_RESET}.1.12")
    res = _run(engine, _cfg(), sw, "snmp_poe_cycle", CAM_PORT)
    assert res["ok"] and res["method"] == "admin_off_on"
    assert sw.sets == [(f"{S.PETH_ADMIN}.1.12", 2), (f"{S.PETH_ADMIN}.1.12", 1)]
    assert _restores(engine) == []                     # restored, ledger cleared


def test_unanswered_reset_does_not_fall_back(engine, nosleep):
    """It may have landed; a second cycle would cut power twice."""
    sw = FakeSwitch()
    sw.silent_set.add(f"{S.EXT_POE_RESET}.1.12")
    res = _run(engine, _cfg(), sw, "snmp_poe_cycle", CAM_PORT)
    assert not res["ok"] and "not falling back" in res["message"]
    assert sw.sets == []
    assert _audit(engine)[-1]["outcome"] == "failed"


def test_switch_without_poe_object_is_refused_before_any_set(engine):
    sw = FakeSwitch()
    del sw.oids[f"{S.EXT_POE_RESET}.1.12"], sw.oids[f"{S.PETH_ADMIN}.1.12"]
    with pytest.raises(P.Unavailable, match="no PoE object"):
        _run(engine, _cfg(), sw, "snmp_poe_cycle", CAM_PORT)
    assert sw.set_calls() == []
    assert _audit(engine)[-1]["outcome"] == "refused"


def test_poe_admin_off_port_is_not_turned_on(engine):
    sw = FakeSwitch()
    sw.oids[f"{S.PETH_ADMIN}.1.12"] = "INTEGER: 2"
    with pytest.raises(ActionRefused, match="administratively off"):
        _run(engine, _cfg(), sw, "snmp_poe_cycle", CAM_PORT)
    assert sw.set_calls() == []


# ───────────────────────── bounce ─────────────────────────

def test_bounce_downs_then_ups_and_clears_ledger(engine, nosleep):
    sw = FakeSwitch()
    res = _run(engine, _cfg(), sw, "snmp_port_bounce", CAM_PORT, down_s=5)
    assert res["ok"]
    assert sw.sets == [(f"{S.IF_ADMIN}.1012", 2), (f"{S.IF_ADMIN}.1012", 1)]
    assert _restores(engine) == []


def test_bounce_of_admin_down_port_refused(engine):
    sw = FakeSwitch()
    sw.oids[f"{S.IF_ADMIN}.1012"] = "INTEGER: 2"
    with pytest.raises(ActionRefused, match="administratively down"):
        _run(engine, _cfg(), sw, "snmp_port_bounce", CAM_PORT)
    assert sw.set_calls() == []


def test_bounce_refused_on_uplink_sends_nothing(engine):
    sw = FakeSwitch()
    with pytest.raises(ActionRefused, match="EDP neighbor"):
        _run(engine, _cfg(), sw, "snmp_port_bounce", UPLINK)
    assert sw.calls == []                               # not even the pre-read


def test_down_s_is_clamped_to_bounce_max(engine, nosleep):
    sw = FakeSwitch()
    res = _run(engine, _cfg(dry_run=True, bounce_max_s=10), sw, "snmp_port_bounce", CAM_PORT,
               down_s=30)
    assert res["commands"][1] == "sleep 10"


# ───────────────────────── never leave a port down ─────────────────────────

def test_crash_between_down_and_up_is_restored_by_the_sweep(engine, monkeypatch):
    """The web process dies after ifAdminStatus=down. The ledger row survives,
    and the sweep (a different process in production) brings the port back,
    opens an alert, records a notification, and closes the alert once clear."""
    sw = FakeSwitch()

    async def crash(_s, *a, **k):
        raise RuntimeError("netmon.service killed")
    monkeypatch.setattr(ops.asyncio, "sleep", crash)
    with pytest.raises(RuntimeError):
        _run(engine, _cfg(), sw, "snmp_port_bounce", CAM_PORT)
    assert sw.sets == [(f"{S.IF_ADMIN}.1012", 2)]
    assert sw.oids[f"{S.IF_ADMIN}.1012"] == "INTEGER: 2"           # port left down
    rows = _restores(engine)
    assert len(rows) == 1 and rows[0]["restore_oid"] == f"{S.IF_ADMIN}.1012"
    assert _audit(engine)[-1]["outcome"] == "failed"

    w, _ = _rw(_cfg(), sw)
    # Not yet overdue: the sweep leaves an in-progress cycle alone.
    assert asyncio.run(ops.restore_sweep(engine, _cfg(), w, EngineConfig())) == 0
    db.execute(engine, "UPDATE switch_port_restores SET deadline = :t",
               {"t": datetime.now(timezone.utc) - timedelta(seconds=1)})
    assert asyncio.run(ops.restore_sweep(engine, _cfg(), w, EngineConfig())) == 1
    assert sw.oids[f"{S.IF_ADMIN}.1012"] == "INTEGER: 1"           # back up
    assert _restores(engine) == []
    alert = db.fetch_one(engine, "SELECT * FROM alerts")
    assert alert is not None and alert["closed_at"] is not None     # raised, then cleared
    note = db.fetch_one(engine, "SELECT * FROM notifications")
    assert "restored BHS-IDF1 1:12" in note["payload_summary"]


def test_sweep_restores_even_when_feature_now_off_or_dry_run(engine):
    sw = FakeSwitch()
    sw.oids[f"{S.IF_ADMIN}.1012"] = "INTEGER: 2"
    p = P.resolve(engine, SW, CAM_PORT)
    ops.add_restore(engine, p, action="snmp_port_bounce", oid=f"{S.IF_ADMIN}.1012", value=1,
                    deadline=datetime.now(timezone.utc) - timedelta(seconds=1),
                    actor="tester", audit_id=None)
    cfg = _cfg(enabled=False, dry_run=True)
    w, _ = _rw(cfg, sw)
    asyncio.run(ops.restore_sweep(engine, cfg, w, EngineConfig()))
    assert sw.oids[f"{S.IF_ADMIN}.1012"] == "INTEGER: 1"


def test_failed_restore_keeps_row_and_alert_open(engine, nosleep):
    sw = FakeSwitch()
    sw.silent_set.add(f"{S.IF_ADMIN}.1012")   # down SET unanswered (maybe landed), up never answered
    res = _run(engine, _cfg(), sw, "snmp_port_bounce", CAM_PORT)
    assert not res["ok"] and "restore sweep will retry" in res["message"]
    db.execute(engine, "UPDATE switch_port_restores SET deadline = :t",
               {"t": datetime.now(timezone.utc) - timedelta(seconds=1)})
    w, _ = _rw(_cfg(), sw)
    asyncio.run(ops.restore_sweep(engine, _cfg(), w, EngineConfig()))
    row = _restores(engine)[0]
    assert row["attempts"] >= 2 and "Timeout" in row["last_error"]
    alert = db.fetch_one(engine, "SELECT * FROM alerts")
    assert alert["closed_at"] is None
    assert "may still be DOWN" in db.fetch_one(engine, "SELECT * FROM notifications")["payload_summary"]


def test_outstanding_restore_blocks_new_action_on_port(engine):
    sw = FakeSwitch()
    p = P.resolve(engine, SW, CAM_PORT)
    ops.add_restore(engine, p, action="snmp_port_bounce", oid=f"{S.IF_ADMIN}.1012", value=1,
                    deadline=datetime.now(timezone.utc) + timedelta(seconds=60),
                    actor="someone", audit_id=None)
    with pytest.raises(ActionRefused, match="outstanding restore"):
        _run(engine, _cfg(), sw, "snmp_poe_cycle", CAM_PORT)
    assert sw.set_calls() == []


# ───────────────────────── rate limits / gates ─────────────────────────

def test_cooldown_refuses_second_action_on_same_port(engine, nosleep):
    sw = FakeSwitch()
    _run(engine, _cfg(), sw, "snmp_poe_cycle", CAM_PORT)
    with pytest.raises(ActionRefused, match="cooldown"):
        _run(engine, _cfg(), sw, "snmp_port_bounce", CAM_PORT)
    assert len(sw.sets) == 1
    # A different port on the same switch is fine.
    _run(engine, _cfg(), sw, "snmp_poe_cycle", UPLINK)


def test_cooldown_counts_the_rconfig_path_too(engine):
    with engine.begin() as c:
        c.execute(text("INSERT INTO action_audit (requested_at, actor, actor_role, action, source, "
                       "device_id, target, outcome) VALUES (:t,'x','operator','poe_cycle','rconfig',"
                       "1,'port 1:12','ok')"), {"t": datetime.now(timezone.utc)})
    with pytest.raises(ActionRefused, match="cooldown"):
        _run(engine, _cfg(), FakeSwitch(), "snmp_poe_cycle", CAM_PORT)


def test_pending_write_on_switch_blocks_another(engine):
    with engine.begin() as c:
        c.execute(text("INSERT INTO action_audit (requested_at, actor, actor_role, action, source, "
                       "device_id, target, outcome) VALUES (:t,'other','operator','snmp_port_bounce',"
                       "'switch',1,'port 1:13','pending')"), {"t": datetime.now(timezone.utc)})
    sw = FakeSwitch()
    with pytest.raises(ActionRefused, match="in flight"):
        _run(engine, _cfg(), sw, "snmp_poe_cycle", CAM_PORT)
    assert sw.set_calls() == []


def test_disabled_feature_and_missing_credentials_are_unavailable(engine):
    with pytest.raises(P.Unavailable, match="disabled"):
        _run(engine, _cfg(enabled=False), FakeSwitch(), "snmp_poe_cycle", CAM_PORT)
    with pytest.raises(P.Unavailable, match="credentials"):
        _run(engine, _cfg(v3_priv_pass=""), FakeSwitch(), "snmp_poe_cycle", CAM_PORT)
    with pytest.raises(P.Unavailable, match="disabled in"):
        _run(engine, _cfg(port_bounce=False), FakeSwitch(), "snmp_port_bounce", CAM_PORT)
    assert {r["outcome"] for r in _audit(engine)} == {"refused"}


# ───────────────────────── verification ─────────────────────────

def test_verification_records_power_link_and_mac_return(engine, nosleep):
    sw = FakeSwitch()
    _run(engine, _cfg(), sw, "snmp_poe_cycle", CAM_PORT)
    msg = _audit(engine)[-1]["message"]
    assert "verified: power" in msg and "link" in msg and "MAC back" in msg
    assert _audit(engine)[-1]["outcome"] == "ok"


def test_verification_failure_marks_audit_failed(engine, nosleep):
    sw = FakeSwitch()
    sw.oids[f"{S.PETH_DETECT}.1.12"] = "INTEGER: 2"     # stuck "searching" after the reset
    del sw.oids[f"{S.FDB_PORT}.0.11.130.1.2.3"]
    _run(engine, _cfg(verify_timeout_s=5), sw, "snmp_poe_cycle", CAM_PORT)
    row = _audit(engine)[-1]
    assert row["outcome"] == "failed" and "verification FAILED: no power" in row["message"]


# ───────────────────────── live port view ─────────────────────────

class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _hub(sw, clock, **kw):
    cfg = _cfg(live_port=True, **kw)
    return L.LivePortHub(cfg, S.SnmpReader(PollerConfig(snmp_community="public"), cfg,
                                           runner=sw.run), clock=clock)


def test_live_viewers_share_one_poll_and_rates_come_from_deltas(engine):
    sw, clock = FakeSwitch(), Clock()
    hub = _hub(sw, clock)
    p = P.resolve(engine, SW, CAM_PORT)
    first = asyncio.run(hub.read(p))
    assert first["sample"]["oper"] == "up" and first["sample"]["poe"]["watts"] == 5.3
    assert first["sample"]["rates"] is None                      # nothing to diff yet
    assert first["fdb"]["macs"] == ["00:0b:82:01:02:03"]
    gets = sum(1 for a, _ in sw.calls if a[0] == "snmpget")
    clock.t += 2
    asyncio.run(hub.read(p))                                      # second viewer, within interval
    assert sum(1 for a, _ in sw.calls if a[0] == "snmpget") == gets
    clock.t += 5
    sw.oids[f"{S.IF_HC_IN}.1012"] = "Counter64: 876000"          # +875,000 bytes over 7s
    third = asyncio.run(hub.read(p))
    assert third["sample"]["rates"]["in_kbps"] == 1000.0


def test_live_counter_going_backwards_gives_no_rate(engine):
    sw, clock = FakeSwitch(), Clock()
    hub = _hub(sw, clock)
    p = P.resolve(engine, SW, CAM_PORT)
    asyncio.run(hub.read(p))
    clock.t += 6
    sw.oids[f"{S.IF_HC_IN}.1012"] = "Counter64: 10"               # switch rebooted
    assert asyncio.run(hub.read(p))["sample"]["rates"]["in_kbps"] is None


def test_live_cap_and_ttl(engine):
    sw, clock = FakeSwitch(), Clock()
    hub = _hub(sw, clock, live_max_ports=1, live_ttl_s=30)
    a, b = P.resolve(engine, SW, CAM_PORT), P.resolve(engine, SW, "1:13")
    asyncio.run(hub.read(a))
    with pytest.raises(L.LiveCapReached):
        asyncio.run(hub.read(b))
    clock.t += 31                                                 # a's viewer went away
    asyncio.run(hub.read(b))
    assert hub.active() == 1


def test_live_unreachable_switch_reports_error_not_stale_as_fresh(engine):
    sw, clock = FakeSwitch(), Clock()
    sw.down = True
    out = asyncio.run(_hub(sw, clock).read(P.resolve(engine, SW, CAM_PORT)))
    assert out["sample"] is None and "Timeout" in out["error"]


# ───────────────────────── config ─────────────────────────

def test_config_defaults_off_and_dry_run(tmp_path):
    cfg = load_config(write_config(tmp_path))
    assert cfg.switch_ops.enabled is False and cfg.switch_ops.dry_run is True
    assert cfg.switch_ops.live_port is False


def test_config_rejects_credentials_in_file_and_long_bounce(tmp_path):
    with pytest.raises(ConfigError, match="netmon.env"):
        load_config(write_config(tmp_path, extra_sections="[switch_ops]\nauth_pass = x\n"))
    with pytest.raises(ConfigError, match="bounce_max_s"):
        load_config(write_config(tmp_path, extra_sections="[switch_ops]\nbounce_max_s = 60\n"))


def test_config_reads_secrets_from_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("NETMON_SNMP_RW_USER", "netmon-rw")
    monkeypatch.setenv("NETMON_SNMP_RW_AUTH", "a" * 12)
    monkeypatch.setenv("NETMON_SNMP_RW_PRIV", "b" * 12)
    so = load_config(write_config(tmp_path)).switch_ops
    assert so.has_credentials and "a" * 12 not in repr(so)


# ───────────────────────── API ─────────────────────────

def _app(tmp_path, extra: str, role: str = "admin"):
    conf = write_config(tmp_path, extra_sections=extra)
    if role != "admin":
        conf.write_text(conf.read_text().replace("dev_bypass_role = admin",
                                                 f"dev_bypass_role = {role}"))
    return create_app(config=load_config(conf), supervisor=Supervisor())


def test_api_bulk_cap_for_operator(tmp_path, engine):
    app = _app(tmp_path, "[switch_ops]\nenabled = true\n", role="operator")
    with TestClient(app) as c:
        r = c.post("/api/switch-ops/poe-cycle",
                   json={"device_id": 1, "ports": [f"1:{n}" for n in range(1, 10)]})
        assert r.status_code == 403 and "limit of 8" in r.json()["detail"]


def test_api_viewer_cannot_write(tmp_path, engine):
    app = _app(tmp_path, "[switch_ops]\nenabled = true\n", role="viewer")
    with TestClient(app) as c:
        r = c.post("/api/switch-ops/poe-cycle", json={"device_id": 1, "ports": ["1:12"]})
        assert r.status_code == 403


def test_api_dry_run_end_to_end_and_capabilities(tmp_path, engine):
    app = _app(tmp_path, "[switch_ops]\nenabled = true\n")
    sw = FakeSwitch()
    with TestClient(app) as c:
        app.state.switch_writer, app.state.switch_reader = _rw(app.state.config.switch_ops, sw)
        cap = c.get("/api/switch-ops").json()
        assert cap["enabled"] and cap["dry_run"] and cap["actions"]["snmp_poe_cycle"]
        r = c.post("/api/switch-ops/poe-cycle", json={"device_id": 1, "ports": ["1:12"]})
        assert r.status_code == 200, r.text
        assert r.json()["results"][0]["dry_run"] is True
        # Not advertised among the rConfig/PF/XIQ row actions.
        assert "snmp_poe_cycle" not in {a["key"] for a in c.get("/api/actions").json()["actions"]}
        chk = c.get("/api/switch-ops/check/1/1049", params={"action": "snmp_port_bounce"}).json()
        assert chk["allowed"] is False and chk["overridable"] is True
    assert sw.set_calls() == []


def test_api_refusal_is_409_and_audited(tmp_path, engine):
    app = _app(tmp_path, "[switch_ops]\nenabled = true\n")
    with TestClient(app) as c:
        app.state.switch_writer, app.state.switch_reader = _rw(app.state.config.switch_ops,
                                                               FakeSwitch())
        r = c.post("/api/switch-ops/port-bounce", json={"device_id": 1, "ports": ["1:49"]})
        assert r.status_code == 409 and "EDP" in r.json()["detail"]
    assert _audit(engine)[-1]["outcome"] == "refused"


def test_api_live_port_disabled_by_default(tmp_path, engine):
    with TestClient(_app(tmp_path, "")) as c:
        assert c.get("/api/switch-ops/live/1/1012").status_code == 404


def test_api_live_port_joins_packetfence_identity(tmp_path, engine):
    with engine.begin() as cn:
        cn.execute(text("INSERT INTO pf_nodes (mac, computername, updated_at) "
                        "VALUES ('00:0b:82:01:02:03','CAM-GYM-1',CURRENT_TIMESTAMP)"))
    app = _app(tmp_path, "[switch_ops]\nlive_port = true\n")
    sw = FakeSwitch()
    with TestClient(app) as c:
        _, app.state.switch_reader = _rw(app.state.config.switch_ops, sw)
        r = c.get("/api/switch-ops/live/1/1012")
        assert r.status_code == 200, r.text
        assert r.json()["fdb"]["macs"][0]["computername"] == "CAM-GYM-1"
