"""Automation workflow engine tests (spec 22).

The cases that matter here are not "does the graph walk work" — they are the
three things measured on the live fleet on 2026-09-11 that would have made the
naive implementation destructive:

  * 211 cameras ignore ICMP and are all recording, so ping-down must not mean
    "remediate";
  * 79% of genuinely-down cameras have no FDB entry, so the port must come from
    memory, recorded while the device was healthy;
  * failures cluster 11-to-a-site, so a site-wide outage must refuse.

Every one of those has a test below that fails if the guard is removed.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest
import sqlalchemy

from netmon import db
from netmon.automation import graph as gr
from netmon.automation import seed
from netmon.automation.context import Context
from netmon.automation.guards import (
    check_all, g1_source_not_blind, g2_state_fresh, g3_native_agrees,
    g4_blast_radius, g5_port_confidence, g6_upstream_alive, g7_cooldown,
    g8_rate_limit, g9_maintenance, g10_action_enabled,
)
from netmon.automation.runner import WorkflowRunner
from netmon.config import AutomationConfig
from tests.conftest import create_core_tables

# Real "now", not a frozen instant: the runner builds its own Context from the
# wall clock, so a fixed NOW would make every state row look stale to G2 and
# every test would fail for the wrong reason.
NOW = datetime.now(timezone.utc)


@pytest.fixture()
def engine():
    eng = sqlalchemy.create_engine("sqlite://")
    create_core_tables(eng)
    return eng


def add_device(engine, name, *, device_type="camera", site="MLK", mgmt_ip=None):
    db.execute(engine, "INSERT INTO devices (name, site, device_type, mgmt_ip) "
                       "VALUES (:n, :s, :t, :ip)",
               {"n": name, "s": site, "t": device_type, "ip": mgmt_ip})
    return int(db.fetch_one(engine, "SELECT id FROM devices WHERE name = :n",
                            {"n": name})["id"])


def set_state(engine, device_id, dimension, value, *, age_s=0, source="test"):
    db.execute(engine, "INSERT INTO device_state (device_id, dimension, value, severity, "
                       "source, updated_at) VALUES (:d, :dim, :v, 'crit', :src, :at)",
               {"d": device_id, "dim": dimension, "v": value, "src": source,
                "at": NOW - timedelta(seconds=age_s)})


def remember_port(engine, device_id, switch_id, *, safe=1, age_s=0, port="1:14"):
    db.execute(engine, "INSERT INTO device_port_memory (device_id, switch_device_id, "
                       "ifindex, port, poe_cycle_safe, why, macs_on_port, mac, confirmed_at) "
                       "VALUES (:d, :sw, 14, :p, :safe, 'fewest MACs on port, PoE-delivering "
                       "copper', 1, 'aabbccddeeff', :at)",
               {"d": device_id, "sw": switch_id, "p": port, "safe": safe,
                "at": NOW - timedelta(seconds=age_s)})


def ctx_for(engine, device_id, *, cfg=None, action="poe_cycle", enabled=True):
    c = Context.build(engine, cfg or AutomationConfig(), workflow_id=1,
                      workflow_name="wf", device_id=device_id,
                      trigger_dimension="source_status", now=NOW)
    c.action_key = action
    c.action_enabled = lambda key: enabled
    return c


# ───────────────────────── graph validation (W5) ─────────────────────────

def test_seeded_camera_workflow_is_valid():
    g = gr.parse(seed.CAMERA_WORKFLOW)
    assert g.trigger.config["dimension"] == "source_status"
    # The correction from spec 22 §2a, asserted so it cannot silently regress.
    assert g.trigger.config["dimension"] != "ping"
    assert g.next_ids("on_network", when="true") == ["vms_refresh"]
    assert g.next_ids("on_network", when="false") == ["have_port"]


def test_graph_rejects_unregistered_action():
    doc = {"nodes": [{"id": "t", "kind": "trigger",
                      "config": {"dimension": "ping", "value": "down"}},
                     {"id": "a", "kind": "action", "config": {"action": "rm_minus_rf"}}],
           "edges": [{"source": "t", "target": "a"}]}
    with pytest.raises(gr.GraphError, match="not a registered action"):
        gr.parse(doc)


def test_graph_rejects_recording_trigger():
    """`recording` reads 'up' for all 2659 devices — a trigger on it is a trap."""
    doc = {"nodes": [{"id": "t", "kind": "trigger",
                      "config": {"dimension": "recording", "value": "down"}}],
           "edges": []}
    with pytest.raises(gr.GraphError, match="not one NetMon will watch"):
        gr.parse(doc)


def test_graph_rejects_cycles():
    doc = {"nodes": [{"id": "t", "kind": "trigger",
                      "config": {"dimension": "ping", "value": "down"}},
                     {"id": "a", "kind": "alert", "config": {"summary": "x"}},
                     {"id": "b", "kind": "alert", "config": {"summary": "y"}}],
           "edges": [{"source": "t", "target": "a"}, {"source": "a", "target": "b"},
                     {"source": "b", "target": "a"}]}
    with pytest.raises(gr.GraphError, match="loop"):
        gr.parse(doc)


def test_graph_needs_exactly_one_trigger():
    doc = {"nodes": [{"id": "a", "kind": "alert", "config": {"summary": "x"}}],
           "edges": []}
    with pytest.raises(gr.GraphError, match="exactly one trigger"):
        gr.parse(doc)


# ───────────────────────── the three measured failure modes ─────────────────────────

def test_g1_refuses_when_the_source_is_blind(engine):
    """147 cameras sit behind a blind Milestone. That is a fact about the
    source, not 147 camera faults."""
    dev = add_device(engine, "cam-blind")
    set_state(engine, dev, "source_status", "blind")
    set_state(engine, dev, "ping", "down")
    r = g1_source_not_blind(ctx_for(engine, dev))
    assert r is not None and r.code == "G1"


def test_g3_refuses_a_camera_that_answers_ping(engine):
    """The 211-camera case: Milestone says down, ICMP says otherwise."""
    dev = add_device(engine, "cam-alive")
    set_state(engine, dev, "source_status", "down")
    set_state(engine, dev, "ping", "up")
    r = g3_native_agrees(ctx_for(engine, dev))
    assert r is not None and r.code == "G3"
    assert "still reaches" in r.reason


def test_g4_refuses_a_site_wide_outage(engine):
    """11 cameras down at MLK is a closet, not 11 camera faults."""
    cfg = AutomationConfig()
    ids = [add_device(engine, f"cam-mlk-{i}") for i in range(11)]
    for i in ids:
        set_state(engine, i, "source_status", "down")
    r = g4_blast_radius(ctx_for(engine, ids[0], cfg=cfg))
    assert r is not None and r.code == "G4"
    assert "upstream fault" in r.reason


def test_g4_allows_a_lone_failure(engine):
    dev = add_device(engine, "cam-alone")
    set_state(engine, dev, "source_status", "down")
    assert g4_blast_radius(ctx_for(engine, dev)) is None


def test_g5_refuses_when_no_port_was_ever_remembered(engine):
    """79% of down cameras have no FDB entry. Without a memory there is no
    port, and guessing one bounces a 10G uplink."""
    dev = add_device(engine, "cam-forgotten")
    set_state(engine, dev, "source_status", "down")
    r = g5_port_confidence(ctx_for(engine, dev))
    assert r is not None and r.code == "G5"
    assert "aged out" in r.reason


def test_g5_refuses_an_unconfirmed_port(engine):
    dev = add_device(engine, "cam-unsafe")
    sw = add_device(engine, "sw-1", device_type="switch")
    remember_port(engine, dev, sw, safe=0)
    r = g5_port_confidence(ctx_for(engine, dev))
    assert r is not None and r.code == "G5"


def test_g5_refuses_a_stale_port(engine):
    dev = add_device(engine, "cam-stale")
    sw = add_device(engine, "sw-1", device_type="switch")
    remember_port(engine, dev, sw, safe=1, age_s=3 * 86400)
    r = g5_port_confidence(ctx_for(engine, dev))
    assert r is not None and r.code == "G5"
    assert "too old" in r.reason


def test_g5_allows_a_fresh_confirmed_port(engine):
    dev = add_device(engine, "cam-good")
    sw = add_device(engine, "sw-1", device_type="switch")
    remember_port(engine, dev, sw, safe=1, age_s=3600)
    assert g5_port_confidence(ctx_for(engine, dev)) is None


def test_g5_does_not_apply_to_non_port_actions(engine):
    dev = add_device(engine, "cam-noport")
    assert g5_port_confidence(ctx_for(engine, dev, action="camera_reboot")) is None


# ───────────────────────── the remaining guards ─────────────────────────

def test_g2_refuses_stale_state(engine):
    dev = add_device(engine, "cam-stalestate")
    set_state(engine, dev, "source_status", "down", age_s=7200)
    r = g2_state_fresh(ctx_for(engine, dev))
    assert r is not None and r.code == "G2"


def test_g6_refuses_when_the_switch_is_down(engine):
    dev = add_device(engine, "cam-behind-dead-switch")
    sw = add_device(engine, "sw-dead", device_type="switch")
    set_state(engine, sw, "ping", "down")
    remember_port(engine, dev, sw)
    r = g6_upstream_alive(ctx_for(engine, dev))
    assert r is not None and r.code == "G6"


def test_g7_cooldown_blocks_a_repeat(engine):
    dev = add_device(engine, "cam-repeat")
    db.execute(engine, "INSERT INTO workflow_runs (workflow_id, device_id, status, "
                       "shadow, started_at) VALUES (1, :d, 'done', 0, :at)",
               {"d": dev, "at": NOW - timedelta(minutes=30)})
    r = g7_cooldown(ctx_for(engine, dev))
    assert r is not None and r.code == "G7"


def test_g7_ignores_shadow_runs(engine):
    """A shadow run sent nothing, so it must not consume the cooldown."""
    dev = add_device(engine, "cam-shadowed")
    db.execute(engine, "INSERT INTO workflow_runs (workflow_id, device_id, status, "
                       "shadow, started_at) VALUES (1, :d, 'done', 1, :at)",
               {"d": dev, "at": NOW - timedelta(minutes=30)})
    assert g7_cooldown(ctx_for(engine, dev)) is None


def test_g8_rate_limit(engine):
    dev = add_device(engine, "cam-ratelimited")
    for _ in range(6):
        db.execute(engine, "INSERT INTO workflow_runs (workflow_id, device_id, status, "
                           "shadow, started_at) VALUES (1, :d, 'done', 0, :at)",
                   {"d": dev, "at": NOW - timedelta(minutes=10)})
    r = g8_rate_limit(ctx_for(engine, dev))
    assert r is not None and r.code == "G8"


def test_g9_maintenance_window(engine):
    dev = add_device(engine, "cam-maint", site="MLK")
    db.execute(engine, "INSERT INTO maintenance_windows (scope_type, scope_value, "
                       "starts_at, ends_at, created_by) "
                       "VALUES ('site', 'MLK', :a, :b, 'test')",
               {"a": NOW - timedelta(hours=1), "b": NOW + timedelta(hours=1)})
    r = g9_maintenance(ctx_for(engine, dev))
    assert r is not None and r.code == "G9"


def test_g10_refuses_a_disabled_action(engine):
    dev = add_device(engine, "cam-disabled")
    r = g10_action_enabled(ctx_for(engine, dev, enabled=False))
    assert r is not None and r.code == "G10"


def test_g10_refuses_an_unregistered_action(engine):
    dev = add_device(engine, "cam-unknown-action")
    r = g10_action_enabled(ctx_for(engine, dev, action="nope"))
    assert r is not None and r.code == "G10"


# ───────────────────────── the runner ─────────────────────────

def install_workflow(engine, *, enabled=1, shadow=1, doc=None):
    db.execute(engine, "INSERT INTO workflows (name, title, graph, enabled, shadow, "
                       "version) VALUES ('camera_down_remediation', 't', :g, :e, :s, 1)",
               {"g": json.dumps(doc or seed.CAMERA_WORKFLOW), "e": enabled, "s": shadow})
    return int(db.fetch_one(engine, "SELECT id FROM workflows")["id"])


def a_broken_camera(engine, name="cam-broken", site="MLK"):
    """A camera the seeded workflow will actually pick up.

    The state is aged 20 minutes on purpose: the trigger requires the down
    verdict to have been *held* for 15 (a camera that dropped 30 seconds ago is
    not yet a remediation candidate), while G2 refuses anything older than 30.
    Twenty minutes sits in that window.
    """
    dev = add_device(engine, name, site=site)
    set_state(engine, dev, "source_status", "down", age_s=1200)
    set_state(engine, dev, "ping", "down", age_s=1200)
    return dev


def test_shadow_run_records_would_run_and_sends_nothing(engine):
    wf = install_workflow(engine, shadow=1)
    dev = a_broken_camera(engine)
    sw = add_device(engine, "sw-1", device_type="switch")
    set_state(engine, sw, "ping", "up")
    remember_port(engine, dev, sw, age_s=3600)

    runner = WorkflowRunner(engine, AutomationConfig(), action_enabled=lambda k: True)
    assert asyncio.run(runner.run_once()) == 1

    steps = db.fetch_all(engine, "SELECT node_id, decision, detail FROM workflow_run_steps "
                                 "ORDER BY seq")
    decisions = {s["node_id"]: s["decision"] for s in steps}
    assert decisions["poe"] == "would_run"
    assert "would propose" in [s for s in steps if s["node_id"] == "poe"][0]["detail"]
    # Shadow sends nothing and queues nothing.
    assert db.fetch_all(engine, "SELECT * FROM action_proposals") == []
    assert db.fetch_all(engine, "SELECT * FROM action_audit") == []


def test_live_run_proposes_rather_than_firing_a_disruptive_action(engine):
    """Spec 22 W2: nothing that cuts power happens unattended, live or not."""
    install_workflow(engine, shadow=0)
    dev = a_broken_camera(engine)
    sw = add_device(engine, "sw-1", device_type="switch")
    set_state(engine, sw, "ping", "up")
    remember_port(engine, dev, sw, age_s=3600)

    runner = WorkflowRunner(engine, AutomationConfig(), action_enabled=lambda k: True)
    asyncio.run(runner.run_once())

    proposals = db.fetch_all(engine, "SELECT * FROM action_proposals")
    assert len(proposals) == 1
    assert proposals[0]["action"] == "poe_cycle"
    assert proposals[0]["status"] == "pending"
    assert "PoE-delivering copper" in proposals[0]["rationale"]
    # Still nothing sent.
    assert db.fetch_all(engine, "SELECT * FROM action_audit") == []
    run = db.fetch_one(engine, "SELECT status FROM workflow_runs")
    assert run["status"] == "awaiting_approval"


def test_a_camera_that_answers_ping_takes_the_vms_arm(engine):
    """The 211-camera correction, end to end: it must not reach the PoE node."""
    install_workflow(engine, shadow=1)
    dev = add_device(engine, "cam-pingable")
    set_state(engine, dev, "source_status", "down", age_s=1200)
    set_state(engine, dev, "ping", "up", age_s=1200)

    runner = WorkflowRunner(engine, AutomationConfig(), action_enabled=lambda k: True)
    asyncio.run(runner.run_once())

    visited = [s["node_id"] for s in db.fetch_all(
        engine, "SELECT node_id FROM workflow_run_steps ORDER BY seq")]
    assert "vms_refresh" in visited
    assert "poe" not in visited


def test_site_wide_outage_refuses_at_the_action(engine):
    install_workflow(engine, shadow=1)
    sw = add_device(engine, "sw-1", device_type="switch")
    set_state(engine, sw, "ping", "up")
    devs = []
    for i in range(11):
        d = a_broken_camera(engine, f"cam-mlk-{i}")
        remember_port(engine, d, sw, age_s=3600, port=f"1:{i}")
        devs.append(d)

    runner = WorkflowRunner(engine, AutomationConfig(), action_enabled=lambda k: True)
    asyncio.run(runner.run_once())

    poe_steps = db.fetch_all(engine, "SELECT decision, detail FROM workflow_run_steps "
                                     "WHERE node_id = 'poe'")
    assert poe_steps, "the PoE node should have been reached and then refused"
    assert all(s["decision"] == "refused" for s in poe_steps)
    assert all("[G4]" in s["detail"] for s in poe_steps)


def test_one_run_per_device_at_a_time(engine):
    """Spec 22 W9 — without this a 5-minute loop queues 12 proposals an hour."""
    install_workflow(engine, shadow=0)
    dev = a_broken_camera(engine)
    sw = add_device(engine, "sw-1", device_type="switch")
    set_state(engine, sw, "ping", "up")
    remember_port(engine, dev, sw, age_s=3600)

    runner = WorkflowRunner(engine, AutomationConfig(), action_enabled=lambda k: True)
    asyncio.run(runner.run_once())
    asyncio.run(runner.run_once())
    asyncio.run(runner.run_once())

    assert len(db.fetch_all(engine, "SELECT id FROM action_proposals")) == 1


def test_a_disabled_workflow_does_nothing(engine):
    install_workflow(engine, enabled=0)
    a_broken_camera(engine)
    runner = WorkflowRunner(engine, AutomationConfig(), action_enabled=lambda k: True)
    assert asyncio.run(runner.run_once()) == 0


def test_an_invalid_graph_is_skipped_loudly_not_run(engine):
    db.execute(engine, "INSERT INTO workflows (name, title, graph, enabled, shadow) "
                       "VALUES ('broken', 't', :g, 1, 1)", {"g": '{"nodes": []}'})
    runner = WorkflowRunner(engine, AutomationConfig(), action_enabled=lambda k: True)
    assert asyncio.run(runner.run_once()) == 0
    assert db.fetch_all(engine, "SELECT * FROM workflow_runs") == []


def test_seed_install_is_idempotent(engine):
    assert seed.install(engine) is True
    assert seed.install(engine) is False
    row = db.fetch_one(engine, "SELECT enabled, shadow FROM workflows")
    # Seeded off and in shadow (W3): two flags stand between it and the fleet.
    assert row["enabled"] == 0
    assert row["shadow"] == 1
