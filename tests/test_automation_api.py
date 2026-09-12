"""Automation API (spec 22, phase 22.2).

Weighted towards the gates, like `test_actions_api.py`: this router can enable
an unattended remediation engine and can execute a proposed write, so the tests
care most about what it refuses.
"""

import json

from fastapi.testclient import TestClient
from sqlalchemy import text

from netmon import db
from netmon.app import create_app
from netmon.automation import seed as wf_seed
from netmon.config import load_config
from netmon.supervisor import Supervisor
from tests.conftest import create_core_tables, write_config


def _db_url(tmp_path) -> str:
    return f"sqlite:///{tmp_path / 'netmon.db'}"


def _seed(url: str) -> None:
    engine = db.make_engine(url)
    create_core_tables(engine)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO devices (name, site, device_type, mgmt_ip, enabled) "
            "VALUES ('MLK-CAM-1','MLK','camera','192.0.2.50',1),"
            "       ('MLK-SW-1','MLK','switch','192.0.2.2',1)"
        ))
    wf_seed.install(engine)
    engine.dispose()


def _conf(tmp_path, *, role: str = "admin"):
    extra = (
        "[automation]\nenabled = true\n\n"
        "[actions]\n\n"
        "[packetfence]\nenabled = true\nurl = https://pf.example.invalid\nuser = u\npass = p\n\n"
        "[rconfig]\nenabled = true\nurl = https://rc.example.invalid\napi_token = t\n\n"
        "[xiq]\nenabled = true\napi_token = tok\n"
    )
    conf = write_config(tmp_path, extra_sections=extra)
    if role != "admin":
        conf.write_text(conf.read_text().replace("dev_bypass_role = admin",
                                                 f"dev_bypass_role = {role}"))
    return conf


def _app(conf_path):
    return create_app(config=load_config(conf_path), supervisor=Supervisor())


def _client(tmp_path, role="admin"):
    url = _db_url(tmp_path)
    _seed(url)
    return TestClient(_app(_conf(tmp_path, role=role))), url


# ───────────────────────── metadata ─────────────────────────

def test_meta_advertises_only_runnable_pieces(tmp_path):
    """The palette is served from the code registries, so a node kind the
    engine cannot run can never appear in the editor."""
    client, _ = _client(tmp_path)
    with client as c:
        meta = c.get("/api/automation/meta").json()
    assert set(meta["node_kinds"]) == {"trigger", "branch", "action", "wait", "alert", "stop"}
    assert "recording" not in meta["trigger_dimensions"]
    by_key = {a["key"]: a for a in meta["actions"]}
    # The UI must be able to say, before wiring it, that this one will queue.
    assert by_key["poe_cycle"]["disruptive"] is True
    assert by_key["poe_cycle"]["runs_unattended"] is False
    assert by_key["milestone_update_hardware"]["runs_unattended"] is True


# ───────────────────────── workflows ─────────────────────────

def test_seeded_workflow_is_listed_off_and_in_shadow(tmp_path):
    client, _ = _client(tmp_path)
    with client as c:
        rows = c.get("/api/automation/workflows").json()
    assert len(rows) == 1
    assert rows[0]["name"] == "camera_down_remediation"
    assert rows[0]["enabled"] == 0
    assert rows[0]["shadow"] == 1
    assert rows[0]["valid"] is True
    # The list view does not draw the graph, so it must not ship it.
    assert "graph" not in rows[0]


def test_creating_a_workflow_validates_the_graph(tmp_path):
    client, _ = _client(tmp_path)
    with client as c:
        r = c.post("/api/automation/workflows", json={
            "name": "bad", "graph": {"nodes": [
                {"id": "t", "kind": "trigger",
                 "config": {"dimension": "source_status", "value": "down"}},
                {"id": "a", "kind": "action", "config": {"action": "rm_rf"}}],
                "edges": [{"source": "t", "target": "a"}]}})
    assert r.status_code == 422
    assert "not a registered action" in r.json()["detail"]


def test_a_new_workflow_is_created_off_and_in_shadow(tmp_path):
    """Whatever the caller asks: turning one on is a separate, deliberate call."""
    client, url = _client(tmp_path)
    with client as c:
        r = c.post("/api/automation/workflows", json={
            "name": "wf2", "title": "t",
            "graph": {"nodes": [{"id": "t", "kind": "trigger",
                                 "config": {"dimension": "ping", "value": "down"}}],
                      "edges": []}})
        assert r.status_code == 200
        assert r.json() == {"id": r.json()["id"], "enabled": False, "shadow": True}


def test_editing_a_workflow_is_admin_only(tmp_path):
    client, _ = _client(tmp_path, role="operator")
    with client as c:
        r = c.post("/api/automation/workflows", json={
            "name": "wf2",
            "graph": {"nodes": [{"id": "t", "kind": "trigger",
                                 "config": {"dimension": "ping", "value": "down"}}],
                      "edges": []}})
    assert r.status_code == 403


def test_a_broken_graph_still_loads_for_editing(tmp_path):
    """The editor is where a broken graph gets fixed, so refusing to load it
    would strand the owner."""
    client, url = _client(tmp_path)
    engine = db.make_engine(url)
    db.execute(engine, "UPDATE workflows SET graph = :g", {"g": '{"nodes": []}'})
    engine.dispose()
    with client as c:
        body = c.get("/api/automation/workflows/1").json()
    assert body["valid"] is False
    assert "non-empty" in body["invalid_reason"]
    assert body["graph"] == {"nodes": []}


def test_an_invalid_graph_cannot_be_taken_live(tmp_path):
    client, url = _client(tmp_path)
    engine = db.make_engine(url)
    db.execute(engine, "UPDATE workflows SET graph = :g", {"g": '{"nodes": []}'})
    engine.dispose()
    with client as c:
        r = c.post("/api/automation/workflows/1/state",
                   json={"enabled": True, "shadow": False})
    assert r.status_code == 409
    assert "must not be run live" in r.json()["detail"]


def test_shadow_can_be_turned_off_on_a_valid_graph(tmp_path):
    client, _ = _client(tmp_path)
    with client as c:
        r = c.post("/api/automation/workflows/1/state",
                   json={"enabled": True, "shadow": False})
    assert r.status_code == 200
    assert r.json() == {"id": 1, "enabled": True, "shadow": False}


def test_going_live_is_admin_only(tmp_path):
    client, _ = _client(tmp_path, role="operator")
    with client as c:
        r = c.post("/api/automation/workflows/1/state", json={"enabled": True})
    assert r.status_code == 403


# ───────────────────────── proposals ─────────────────────────

def _proposal(url, action="poe_cycle", params=None, run_id=None):
    engine = db.make_engine(url)
    if run_id is None:
        db.execute(engine, "INSERT INTO workflow_runs (workflow_id, device_id, status, "
                           "shadow) VALUES (1, 1, 'awaiting_approval', 0)")
        run_id = int(db.fetch_one(engine, "SELECT MAX(id) AS i FROM workflow_runs")["i"])
    db.execute(engine, "INSERT INTO action_proposals (run_id, workflow_id, device_id, "
                       "action, target, params, rationale, status) "
                       "VALUES (:r, 1, 1, :a, 'MLK-SW-1 port 1:14', :p, 'because', 'pending')",
               {"r": run_id, "a": action,
                "p": json.dumps(params if params is not None else
                                {"device_id": 2, "port": "1:14"})})
    pid = int(db.fetch_one(engine, "SELECT MAX(id) AS i FROM action_proposals")["i"])
    engine.dispose()
    return pid, run_id


def test_proposals_carry_what_an_operator_needs_to_decide(tmp_path):
    client, url = _client(tmp_path)
    _proposal(url)
    with client as c:
        rows = c.get("/api/automation/proposals").json()
    assert len(rows) == 1
    assert rows[0]["action"] == "poe_cycle"
    assert rows[0]["label"] == "Cycle PoE"
    assert rows[0]["disruptive"] is True
    assert rows[0]["device"] == "MLK-CAM-1"
    assert rows[0]["rationale"] == "because"


def test_dismissing_a_proposal_releases_its_run(tmp_path):
    """Without this the run stays awaiting_approval forever and W9 blocks the
    device from ever being remediated again."""
    client, url = _client(tmp_path)
    pid, run_id = _proposal(url)
    with client as c:
        r = c.post(f"/api/automation/proposals/{pid}/dismiss", json={})
    assert r.status_code == 200
    engine = db.make_engine(url)
    assert db.fetch_one(engine, "SELECT status FROM action_proposals WHERE id = :i",
                        {"i": pid})["status"] == "dismissed"
    run = db.fetch_one(engine, "SELECT status, message FROM workflow_runs WHERE id = :i",
                       {"i": run_id})
    assert run["status"] == "done"
    assert "dismissed by" in run["message"]
    engine.dispose()


def test_a_proposal_can_only_be_decided_once(tmp_path):
    client, url = _client(tmp_path)
    pid, _ = _proposal(url)
    with client as c:
        assert c.post(f"/api/automation/proposals/{pid}/dismiss", json={}).status_code == 200
        r = c.post(f"/api/automation/proposals/{pid}/dismiss", json={})
    assert r.status_code == 409
    assert "already dismissed" in r.json()["detail"]


def test_viewers_cannot_decide_proposals(tmp_path):
    client, url = _client(tmp_path, role="viewer")
    pid, _ = _proposal(url)
    with client as c:
        assert c.post(f"/api/automation/proposals/{pid}/dismiss", json={}).status_code == 403
        assert c.post(f"/api/automation/proposals/{pid}/approve", json={}).status_code == 403


def test_viewers_can_read_the_trail(tmp_path):
    """Who bounced what is operational history, not a secret — same call the
    action audit makes."""
    client, url = _client(tmp_path, role="viewer")
    _proposal(url)
    with client as c:
        assert c.get("/api/automation/proposals").status_code == 200
        assert c.get("/api/automation/runs").status_code == 200
        assert c.get("/api/automation/shadow-report").status_code == 200


def test_approving_an_unimplemented_action_refuses_honestly(tmp_path):
    """camera_reboot is registered and audited but not implemented until 22.4.
    Reporting an execution that never happened would be the worst outcome."""
    client, url = _client(tmp_path)
    pid, _ = _proposal(url, action="camera_reboot", params={"device_id": 1})
    with client as c:
        r = c.post(f"/api/automation/proposals/{pid}/approve", json={})
    assert r.status_code == 409
    assert "cannot be executed from NetMon yet" in r.json()["detail"]
    engine = db.make_engine(url)
    # Marked failed, not executed.
    assert db.fetch_one(engine, "SELECT status FROM action_proposals WHERE id = :i",
                        {"i": pid})["status"] == "failed"
    assert db.fetch_all(engine, "SELECT id FROM action_audit") == []
    engine.dispose()


def test_approving_a_proposal_with_no_target_refuses(tmp_path):
    client, url = _client(tmp_path)
    pid, _ = _proposal(url, action="poe_cycle", params={})
    with client as c:
        r = c.post(f"/api/automation/proposals/{pid}/approve", json={})
    assert r.status_code == 409
    assert "no switch/port" in r.json()["detail"]


# ───────────────────────── runs and the shadow report ─────────────────────────

def test_shadow_report_groups_refusals_by_guard(tmp_path):
    """The grouping that matters: one guard dominating for a week means the
    threshold is wrong, not that the engine is working."""
    client, url = _client(tmp_path)
    engine = db.make_engine(url)
    db.execute(engine, "INSERT INTO workflow_runs (workflow_id, device_id, status, shadow) "
                       "VALUES (1, 1, 'done', 1)")
    for detail in ("[G4] site-wide", "[G4] site-wide", "[G5] no port"):
        db.execute(engine, "INSERT INTO workflow_run_steps (run_id, seq, node_id, "
                           "node_kind, decision, detail) "
                           "VALUES (1, 1, 'poe', 'action', 'refused', :d)", {"d": detail})
    db.execute(engine, "INSERT INTO workflow_run_steps (run_id, seq, node_id, node_kind, "
                       "decision, detail) VALUES (1, 2, 'poe', 'action', 'would_run', 'x')")
    engine.dispose()
    with client as c:
        report = c.get("/api/automation/shadow-report").json()
    assert report["refused_by_guard"][0] == {"guard": "G4", "count": 2}
    assert {"guard": "G5", "count": 1} in report["refused_by_guard"]
    assert report["would_run"] == [{"node_id": "poe", "count": 1}]


def test_run_detail_returns_its_steps(tmp_path):
    client, url = _client(tmp_path)
    engine = db.make_engine(url)
    db.execute(engine, "INSERT INTO workflow_runs (workflow_id, device_id, status, shadow) "
                       "VALUES (1, 1, 'done', 1)")
    db.execute(engine, "INSERT INTO workflow_run_steps (run_id, seq, node_id, node_kind, "
                       "decision, detail) VALUES (1, 1, 'trigger', 'trigger', 'taken', 'x')")
    engine.dispose()
    with client as c:
        body = c.get("/api/automation/runs/1").json()
    assert body["device"] == "MLK-CAM-1"
    assert len(body["steps"]) == 1
    assert body["steps"][0]["node_id"] == "trigger"
