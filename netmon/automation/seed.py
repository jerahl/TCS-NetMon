"""The default camera remediation workflow, seeded disabled and in shadow.

Spec 22 §6. This is the owner's example ("if a camera goes down ping in; if
ping is up connect to camera and restart, if ping is down cycle poe on the
camera port") corrected by what the fleet actually says — see spec 22 §2. Two
corrections are visible in the graph itself:

* the trigger is ``source_status = down``, not ping and not ``recording``.
  ICMP silence is not a camera fault here: all 211 cameras that ignore ICMP are
  recording, and ``recording`` reads ``up`` for all 2659 devices, so it is a
  constant. Ping is consulted only *after* Milestone has independently said the
  device is down, which is what the ``ping_up`` branch does;
* the PoE arm checks a *remembered* port, because a dead camera has already
  aged out of the switch forwarding tables (79% of the down cameras had no FDB
  entry at all).

The ten guards are not in the graph and cannot be put there (W4). They are
applied by the runner to every action step.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.automation import graph as gr

WORKFLOW_NAME = "camera_down_remediation"

#: Node positions are the editor's; they are carried in the same document so a
#: graph seeded here opens laid out rather than piled at the origin.
CAMERA_WORKFLOW: dict[str, Any] = {
    "nodes": [
        {"id": "trigger", "kind": "trigger", "label": "Camera down in Milestone",
         "position": {"x": 0, "y": 200},
         "config": {"dimension": "source_status", "value": "down",
                    "device_type": "camera", "min_duration_s": 900}},

        {"id": "on_network", "kind": "branch", "label": "Does it answer ping?",
         "position": {"x": 240, "y": 200},
         "config": {"predicate": "ping_up"}},

        # ── ping up: the camera is on the network, the VMS lost it ──────────
        {"id": "vms_refresh", "kind": "action", "label": "Ask Milestone to re-detect it",
         "position": {"x": 500, "y": 60},
         "config": {"action": "milestone_update_hardware"}},
        {"id": "settle", "kind": "wait", "label": "Wait 5 minutes",
         "position": {"x": 760, "y": 60},
         "config": {"seconds": 300}},
        {"id": "recheck", "kind": "branch", "label": "Still down?",
         "position": {"x": 1000, "y": 60},
         "config": {"predicate": "still_down"}},
        {"id": "reboot", "kind": "action", "label": "Reboot the camera",
         "position": {"x": 1260, "y": 0},
         "config": {"action": "camera_reboot"}},
        {"id": "recovered", "kind": "stop", "label": "Recovered",
         "position": {"x": 1260, "y": 140},
         "config": {}},

        # ── ping down: the camera is off the network entirely ───────────────
        {"id": "have_port", "kind": "branch", "label": "Confirmed port remembered?",
         "position": {"x": 500, "y": 360},
         "config": {"predicate": "port_memory_confirmed"}},
        {"id": "switch_ok", "kind": "branch", "label": "Is its switch up?",
         "position": {"x": 760, "y": 360},
         "config": {"predicate": "switch_up"}},
        {"id": "poe", "kind": "action", "label": "Cycle PoE on the remembered port",
         "position": {"x": 1000, "y": 300},
         "config": {"action": "poe_cycle"}},
        # PoE is disruptive, so the run parks at `poe` until an operator approves
        # the proposal; approval resumes it here (spec 22 §6a). The wait gives
        # the camera time to boot and Milestone time to reconnect before the
        # re-check, so a slow boot is not mistaken for a failed cycle.
        {"id": "poe_settle", "kind": "wait", "label": "Wait 5 minutes",
         "position": {"x": 1260, "y": 300},
         "config": {"seconds": 300}},
        {"id": "poe_recheck", "kind": "branch", "label": "Still down?",
         "position": {"x": 1500, "y": 300},
         "config": {"predicate": "still_down"}},
        {"id": "poe_failed", "kind": "alert", "label": "Escalate: PoE cycle did not help",
         "position": {"x": 1760, "y": 240},
         "config": {"summary": "{device} at {site} is still down 5 minutes after its PoE "
                               "port was cycled — needs a site visit"}},
        {"id": "poe_recovered", "kind": "stop", "label": "Recovered",
         "position": {"x": 1760, "y": 380},
         "config": {}},
        {"id": "no_port", "kind": "alert", "label": "Escalate: no confirmed port",
         "position": {"x": 760, "y": 500},
         "config": {"summary": "{device} at {site} is down and NetMon has no confirmed "
                               "access port for it — needs a human"}},
        {"id": "switch_down", "kind": "alert", "label": "Escalate: switch is down",
         "position": {"x": 1000, "y": 460},
         "config": {"summary": "{device} at {site} is down, and so is the switch its "
                               "port is on — the camera is probably not the fault"}},
        {"id": "end", "kind": "stop", "label": "Done",
         "position": {"x": 1260, "y": 520},
         "config": {}},
    ],
    "edges": [
        {"source": "trigger", "target": "on_network"},

        {"source": "on_network", "target": "vms_refresh", "when": "true"},
        {"source": "vms_refresh", "target": "settle"},
        {"source": "settle", "target": "recheck"},
        {"source": "recheck", "target": "reboot", "when": "true"},
        {"source": "recheck", "target": "recovered", "when": "false"},

        {"source": "on_network", "target": "have_port", "when": "false"},
        {"source": "have_port", "target": "switch_ok", "when": "true"},
        {"source": "have_port", "target": "no_port", "when": "false"},
        {"source": "switch_ok", "target": "poe", "when": "true"},
        {"source": "switch_ok", "target": "switch_down", "when": "false"},
        {"source": "poe", "target": "poe_settle"},
        {"source": "poe_settle", "target": "poe_recheck"},
        {"source": "poe_recheck", "target": "poe_failed", "when": "true"},
        {"source": "poe_recheck", "target": "poe_recovered", "when": "false"},
        {"source": "poe_failed", "target": "end"},
        {"source": "no_port", "target": "end"},
        {"source": "switch_down", "target": "end"},
    ],
}

TITLE = "Camera down — remediation"
DESCRIPTION = (
    "Milestone has reported a camera down for 15 minutes. If the camera still answers "
    "ping the VMS connection is the likely fault, so ask Milestone to re-detect it and "
    "only propose a camera reboot if that does not help. If it answers nothing, propose "
    "a PoE cycle — but only on a port that was confirmed safe while the camera was "
    "healthy, and only when that port's switch is itself up. Once the cycle is approved "
    "and run, wait 5 minutes and re-check; if the camera is still down, escalate."
)

#: SHA-256 of every default graph shipped before this one, canonicalised as
#: `_digest` does. A stored row matching one of these was never edited by the
#: owner, so `upgrade()` may replace it; anything else is theirs and is left
#: alone.
_SUPERSEDED_DIGESTS = frozenset({
    # 22.2 — PoE arm ended at the proposal, no post-cycle re-check.
    "a7f233ad552e51126f0e6fbdf07fbad2c73b42a9e8b9c6134fb10f5c9e2402c1",
})


def _digest(doc: Any) -> str:
    import hashlib
    if isinstance(doc, (str, bytes)):
        doc = json.loads(doc)
    return hashlib.sha256(
        json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def install(engine: Engine, *, actor: str = "netmon-seed") -> bool:
    """Create the workflow if it is absent. Returns True if it was created.

    Never overwrites an existing row: once the owner has edited the graph or
    flipped shadow off, a redeploy must not quietly revert either.
    """
    gr.parse(CAMERA_WORKFLOW)  # refuse to seed something that will not run
    existing = db.fetch_one(engine, "SELECT id FROM workflows WHERE name = :n",
                            {"n": WORKFLOW_NAME})
    if existing:
        return False
    db.execute(
        engine,
        "INSERT INTO workflows (name, title, description, graph, enabled, shadow, "
        " version, created_by) "
        "VALUES (:n, :t, :d, :g, 0, 1, 1, :by)",
        {"n": WORKFLOW_NAME, "t": TITLE, "d": DESCRIPTION,
         "g": json.dumps(CAMERA_WORKFLOW), "by": actor},
    )
    return True


def upgrade(engine: Engine) -> bool:
    """Bring an *unedited* seeded workflow up to the current default graph.

    Only replaces a graph whose digest matches a previously shipped default, so
    an owner's edits are never overwritten. `enabled` and `shadow` are not
    touched — a graph change must not take anything live. Returns True if the
    row was upgraded.
    """
    gr.parse(CAMERA_WORKFLOW)
    row = db.fetch_one(engine, "SELECT id, graph, version FROM workflows WHERE name = :n",
                       {"n": WORKFLOW_NAME})
    if not row:
        return False
    try:
        current = _digest(row["graph"])
    except ValueError:
        return False  # unparseable: the owner's problem to see, not ours to paper over
    if current not in _SUPERSEDED_DIGESTS:
        return False
    db.execute(
        engine,
        "UPDATE workflows SET graph = :g, description = :d, version = :v WHERE id = :id",
        {"g": json.dumps(CAMERA_WORKFLOW), "d": DESCRIPTION,
         "v": int(row.get("version") or 1) + 1, "id": row["id"]},
    )
    return True
