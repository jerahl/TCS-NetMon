"""Automation workflow endpoints (spec 22, phase 22.2).

Read surface is viewer-wide on purpose: what the engine decided, and why, is
operational history in the same way `action_audit` is. Hiding it would defeat
the point of a shadow trail nobody can read.

The write surface is narrow and deliberately shaped:

* **Editing a graph is admin-only**, and every write revalidates against the
  closed node registry (`automation.graph.parse`). A graph that would not run
  cannot be saved, so "it validated when I saved it" is a real guarantee rather
  than a hope.
* **Enabling or un-shadowing a workflow is its own endpoint**, separate from
  editing the graph. Flipping an automation live is a different decision from
  rearranging its boxes and deserves its own audit line and its own click.
* **Approving a proposal executes the action through
  `netmon.actions.AuditedAction`** — the same chokepoint the operator buttons
  use, with the approving human as the actor. The engine proposed it; a person
  owns it.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.engine import Engine

from netmon import db
from netmon.actions import ACTIONS, ActionRefused, action_or_refuse
from netmon.api.deps import current_user, get_engine, require_role
from netmon.automation import graph as gr
from netmon.automation import seed as wf_seed
from netmon.config import Config
from netmon.models.schemas import Role

log = logging.getLogger("netmon.api.automation")

router = APIRouter(prefix="/api/automation", tags=["automation"])


def _cfg(request: Request) -> Config:
    return request.app.state.config


def _actor(user) -> str:
    return getattr(user, "username", None) or "unknown"


def _role(user) -> str:
    role = getattr(user, "role", None)
    return getattr(role, "value", None) or str(role or "unknown")


class GraphBody(BaseModel):
    nodes: list[dict[str, Any]]
    edges: list[dict[str, Any]] = Field(default_factory=list)


class WorkflowBody(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    title: str | None = None
    description: str | None = None
    graph: GraphBody


class ToggleBody(BaseModel):
    enabled: bool | None = None
    shadow: bool | None = None


class DecisionBody(BaseModel):
    note: str | None = Field(default=None, max_length=500)


# ───────────────────────── metadata ─────────────────────────

@router.get("/meta")
def meta(request: Request, _user=Depends(require_role(Role.viewer))) -> dict:
    """What the editor is allowed to build with.

    Served from the code registries rather than duplicated in the frontend, so
    a node kind the engine cannot run can never appear in the palette.
    """
    cfg = _cfg(request)
    return {
        "enabled": bool(cfg.automation.enabled),
        "node_kinds": list(gr.NODE_KINDS),
        "predicates": [{"key": k, "question": v} for k, v in sorted(gr.PREDICATES.items())],
        "trigger_dimensions": list(gr.TRIGGER_DIMENSIONS),
        "actions": [
            {"key": k, "label": s.label, "source": s.source, "effect": s.effect,
             "disruptive": s.disruptive,
             # The UI shows this so an operator understands, before wiring it,
             # that a disruptive step will queue rather than run.
             "runs_unattended": not s.disruptive}
            for k, s in sorted(ACTIONS.items())
        ],
        "guards": {
            "max_state_age_s": cfg.automation.max_state_age_s,
            "site_cluster_max": cfg.automation.site_cluster_max,
            "switch_cluster_max": cfg.automation.switch_cluster_max,
            "require_port_confirmed_within_s": cfg.automation.require_port_confirmed_within_s,
            "per_device_cooldown_s": cfg.automation.per_device_cooldown_s,
            "fleet_rate_limit": cfg.automation.fleet_rate_limit,
        },
    }


# ───────────────────────── workflows ─────────────────────────

@router.get("/workflows")
def list_workflows(engine: Engine = Depends(get_engine),
                   _user=Depends(require_role(Role.viewer))) -> list[dict]:
    rows = db.fetch_all(
        engine,
        "SELECT w.id, w.name, w.title, w.description, w.enabled, w.shadow, w.version, "
        "       w.updated_at, w.graph, "
        "  (SELECT COUNT(*) FROM workflow_runs r WHERE r.workflow_id = w.id) AS runs, "
        "  (SELECT MAX(r.started_at) FROM workflow_runs r WHERE r.workflow_id = w.id) "
        "     AS last_run_at, "
        "  (SELECT COUNT(*) FROM action_proposals p "
        "    WHERE p.workflow_id = w.id AND p.status = 'pending') AS pending "
        "FROM workflows w ORDER BY w.name",
    )
    out = []
    for row in rows:
        item = dict(row)
        # Report the graph's validity rather than assuming it. A row edited
        # directly in the database is exactly the case worth surfacing, and it
        # is the runner's behaviour too — it skips such a workflow and logs.
        # The graph itself is dropped from the list payload; it is large and the
        # list view does not draw it.
        raw = item.pop("graph", None)
        try:
            gr.parse(raw)
            item["valid"], item["invalid_reason"] = True, None
        except (gr.GraphError, ValueError) as exc:
            item["valid"], item["invalid_reason"] = False, str(exc)
        out.append(item)
    return out


@router.get("/workflows/{workflow_id}")
def get_workflow(workflow_id: int, engine: Engine = Depends(get_engine),
                 _user=Depends(require_role(Role.viewer))) -> dict:
    row = db.fetch_one(engine, "SELECT * FROM workflows WHERE id = :id", {"id": workflow_id})
    if not row:
        raise HTTPException(status_code=404, detail="no such workflow")
    item = dict(row)
    raw = item.pop("graph", None)
    try:
        gr.parse(raw)
        item["graph"] = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
        item["valid"], item["invalid_reason"] = True, None
    except (gr.GraphError, ValueError) as exc:
        # Hand back the raw document anyway: the editor is where a broken graph
        # gets fixed, so refusing to load it would strand the owner.
        try:
            item["graph"] = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
        except ValueError:
            item["graph"] = {"nodes": [], "edges": []}
        item["valid"], item["invalid_reason"] = False, str(exc)
    return item


@router.post("/workflows")
def create_workflow(body: WorkflowBody, engine: Engine = Depends(get_engine),
                    user=Depends(require_role(Role.admin))) -> dict:
    doc = {"nodes": body.graph.nodes, "edges": body.graph.edges}
    _validate_or_422(doc)
    if db.fetch_one(engine, "SELECT id FROM workflows WHERE name = :n", {"n": body.name}):
        raise HTTPException(status_code=409, detail=f"a workflow named {body.name!r} exists")
    db.execute(
        engine,
        "INSERT INTO workflows (name, title, description, graph, enabled, shadow, "
        " version, created_by) VALUES (:n, :t, :d, :g, 0, 1, 1, :by)",
        {"n": body.name, "t": body.title, "d": body.description,
         "g": json.dumps(doc), "by": _actor(user)},
    )
    row = db.fetch_one(engine, "SELECT id FROM workflows WHERE name = :n", {"n": body.name})
    log.info("workflow %r created by %s (disabled, shadow)", body.name, _actor(user))
    # Created off and in shadow whatever the caller asked: turning it on is a
    # separate, deliberate call.
    return {"id": int(row["id"]), "enabled": False, "shadow": True}


@router.put("/workflows/{workflow_id}")
def update_workflow(workflow_id: int, body: WorkflowBody,
                    engine: Engine = Depends(get_engine),
                    user=Depends(require_role(Role.admin))) -> dict:
    doc = {"nodes": body.graph.nodes, "edges": body.graph.edges}
    _validate_or_422(doc)
    existing = db.fetch_one(engine, "SELECT version FROM workflows WHERE id = :id",
                            {"id": workflow_id})
    if not existing:
        raise HTTPException(status_code=404, detail="no such workflow")
    version = int(existing["version"] or 1) + 1
    db.execute(
        engine,
        "UPDATE workflows SET title = :t, description = :d, graph = :g, version = :v "
        "WHERE id = :id",
        {"t": body.title, "d": body.description, "g": json.dumps(doc),
         "v": version, "id": workflow_id},
    )
    log.info("workflow %s edited by %s (now version %d)", workflow_id, _actor(user), version)
    return {"id": workflow_id, "version": version}


@router.post("/workflows/{workflow_id}/state")
def set_workflow_state(workflow_id: int, body: ToggleBody,
                       engine: Engine = Depends(get_engine),
                       user=Depends(require_role(Role.admin))) -> dict:
    """Enable/disable, or take a workflow out of shadow.

    Separate from editing the graph because it is a different decision:
    rearranging boxes is not the same as pointing an unattended remediation
    engine at 2,659 cameras. Refuses to un-shadow a graph that does not
    validate — the one moment that check is load-bearing.
    """
    row = db.fetch_one(engine, "SELECT graph, enabled, shadow FROM workflows WHERE id = :id",
                       {"id": workflow_id})
    if not row:
        raise HTTPException(status_code=404, detail="no such workflow")
    enabled = row["enabled"] if body.enabled is None else int(bool(body.enabled))
    shadow = row["shadow"] if body.shadow is None else int(bool(body.shadow))
    if enabled and not shadow:
        try:
            gr.parse(row["graph"])
        except gr.GraphError as exc:
            raise HTTPException(
                status_code=409,
                detail=f"this graph does not validate, so it must not be run live: {exc}",
            ) from exc
    db.execute(engine, "UPDATE workflows SET enabled = :e, shadow = :s WHERE id = :id",
               {"e": enabled, "s": shadow, "id": workflow_id})
    log.warning("workflow %s set enabled=%s shadow=%s by %s",
                workflow_id, bool(enabled), bool(shadow), _actor(user))
    return {"id": workflow_id, "enabled": bool(enabled), "shadow": bool(shadow)}


@router.post("/seed")
def seed_default(engine: Engine = Depends(get_engine),
                 user=Depends(require_role(Role.admin))) -> dict:
    created = wf_seed.install(engine, actor=_actor(user))
    return {"created": created, "name": wf_seed.WORKFLOW_NAME}


# ───────────────────────── runs ─────────────────────────

@router.get("/runs")
def list_runs(limit: int = 100, workflow_id: int | None = None,
              device_id: int | None = None, status: str | None = None,
              engine: Engine = Depends(get_engine),
              _user=Depends(require_role(Role.viewer))) -> list[dict]:
    limit = max(1, min(int(limit), 500))
    sql = ("SELECT r.id, r.workflow_id, w.name AS workflow, r.device_id, d.name AS device, "
           "       d.site AS site, r.trigger_reason, r.status, r.shadow, r.message, "
           "       r.started_at, r.finished_at, r.resume_at, r.resume_node "
           "FROM workflow_runs r "
           "LEFT JOIN workflows w ON w.id = r.workflow_id "
           "LEFT JOIN devices d ON d.id = r.device_id WHERE 1 = 1")
    params: dict[str, Any] = {}
    if workflow_id is not None:
        sql += " AND r.workflow_id = :w"
        params["w"] = workflow_id
    if device_id is not None:
        sql += " AND r.device_id = :d"
        params["d"] = device_id
    if status:
        sql += " AND r.status = :s"
        params["s"] = status
    sql += f" ORDER BY r.id DESC LIMIT {limit}"
    return db.fetch_all(engine, sql, params)


@router.get("/runs/{run_id}")
def get_run(run_id: int, engine: Engine = Depends(get_engine),
            _user=Depends(require_role(Role.viewer))) -> dict:
    row = db.fetch_one(
        engine,
        "SELECT r.*, w.name AS workflow, d.name AS device, d.site AS site "
        "FROM workflow_runs r LEFT JOIN workflows w ON w.id = r.workflow_id "
        "LEFT JOIN devices d ON d.id = r.device_id WHERE r.id = :id",
        {"id": run_id},
    )
    if not row:
        raise HTTPException(status_code=404, detail="no such run")
    item = dict(row)
    item["steps"] = db.fetch_all(
        engine,
        "SELECT seq, node_id, node_kind, label, decision, detail, action_audit_id, at "
        "FROM workflow_run_steps WHERE run_id = :r ORDER BY seq",
        {"r": run_id},
    )
    return item


@router.get("/shadow-report")
def shadow_report(hours: int = 168, engine: Engine = Depends(get_engine),
                  _user=Depends(require_role(Role.viewer))) -> dict:
    """What the engine would have done, and what stopped it.

    The grouping that matters is **refusals by guard**. If one guard dominates
    for a week, that is the fleet telling you the threshold is wrong — not that
    the engine is working. Reading it any other way is how a guard gets quietly
    tuned into uselessness.
    """
    hours = max(1, min(int(hours), 24 * 90))
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = db.fetch_all(
        engine,
        "SELECT s.decision, s.detail, s.node_id, r.workflow_id, r.shadow "
        "FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id "
        "WHERE r.started_at >= :since",
        {"since": since},
    )
    refusals: dict[str, int] = {}
    would_run: dict[str, int] = {}
    for row in rows:
        if row["decision"] == "refused":
            code = _guard_code(row["detail"])
            refusals[code] = refusals.get(code, 0) + 1
        elif row["decision"] == "would_run":
            would_run[row["node_id"]] = would_run.get(row["node_id"], 0) + 1
    return {
        "hours": hours,
        "would_run": [{"node_id": k, "count": v}
                      for k, v in sorted(would_run.items(), key=lambda x: -x[1])],
        "refused_by_guard": [{"guard": k, "count": v}
                             for k, v in sorted(refusals.items(), key=lambda x: -x[1])],
        "runs": db.fetch_one(
            engine, "SELECT COUNT(*) AS n FROM workflow_runs WHERE started_at >= :since",
            {"since": since})["n"],
    }


def _guard_code(detail: Any) -> str:
    text = str(detail or "")
    if text.startswith("[") and "]" in text:
        return text[1:text.index("]")]
    return "other"


# ───────────────────────── proposals ─────────────────────────

@router.get("/proposals")
def list_proposals(status: str = "pending", limit: int = 100,
                   engine: Engine = Depends(get_engine),
                   _user=Depends(require_role(Role.viewer))) -> list[dict]:
    limit = max(1, min(int(limit), 500))
    params: dict[str, Any] = {}
    sql = ("SELECT p.*, d.name AS device, d.site AS site, w.name AS workflow "
           "FROM action_proposals p "
           "LEFT JOIN devices d ON d.id = p.device_id "
           "LEFT JOIN workflows w ON w.id = p.workflow_id WHERE 1 = 1")
    if status and status != "all":
        sql += " AND p.status = :s"
        params["s"] = status
    sql += f" ORDER BY p.id DESC LIMIT {limit}"
    rows = db.fetch_all(engine, sql, params)
    for row in rows:
        spec = ACTIONS.get(str(row.get("action")))
        row["label"] = spec.label if spec else row.get("action")
        row["disruptive"] = bool(spec.disruptive) if spec else True
    return rows


@router.post("/proposals/{proposal_id}/dismiss")
def dismiss_proposal(proposal_id: int, body: DecisionBody,
                     engine: Engine = Depends(get_engine),
                     user=Depends(require_role(Role.operator))) -> dict:
    row = _pending_or_404(engine, proposal_id)
    db.execute(
        engine,
        "UPDATE action_proposals SET status = 'dismissed', decided_by = :by, "
        "decided_at = :at WHERE id = :id",
        {"by": _actor(user), "at": datetime.now(timezone.utc), "id": proposal_id},
    )
    _close_run(engine, row, f"dismissed by {_actor(user)}")
    return {"id": proposal_id, "status": "dismissed"}


@router.post("/proposals/{proposal_id}/approve")
async def approve_proposal(proposal_id: int, body: DecisionBody, request: Request,
                           engine: Engine = Depends(get_engine),
                           user=Depends(require_role(Role.operator))) -> dict:
    """Execute a proposed action, with the approving human as the actor.

    This deliberately calls the *same* handlers `/api/actions` exposes rather
    than a parallel implementation: the per-action config flags, the target
    resolution and the audit row must be identical whether a button or a
    workflow put the action in front of the operator. The engine proposed it;
    the person who clicks owns it, and the audit says so.
    """
    row = _pending_or_404(engine, proposal_id)
    action = str(row["action"])
    try:
        action_or_refuse(action)
    except ActionRefused as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    params = _params(row)
    try:
        result = await _dispatch(action, params, row, request, engine, user)
    except ActionRefused as exc:
        db.execute(engine, "UPDATE action_proposals SET status = 'failed', "
                           "decided_by = :by, decided_at = :at WHERE id = :id",
                   {"by": _actor(user), "at": datetime.now(timezone.utc),
                    "id": proposal_id})
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    db.execute(
        engine,
        "UPDATE action_proposals SET status = 'executed', decided_by = :by, "
        "decided_at = :at WHERE id = :id",
        {"by": _actor(user), "at": datetime.now(timezone.utc), "id": proposal_id},
    )
    _close_run(engine, row, f"approved and executed by {_actor(user)}")
    log.warning("proposal %s (%s) approved and executed by %s",
                proposal_id, action, _actor(user))
    return {"id": proposal_id, "status": "executed", "result": result}


async def _dispatch(action: str, params: dict, row: dict, request: Request,
                    engine: Engine, user) -> dict:
    """Route to the existing operator-action implementation for this key."""
    from netmon.api import actions as actions_api

    if action == "poe_cycle":
        device_id = params.get("device_id")
        port = params.get("port")
        if not device_id or not port:
            raise ActionRefused("this proposal carries no switch/port to act on")
        body = actions_api.PoeCycleBody(device_id=int(device_id), port=str(port),
                                        member=int(params.get("member") or 1))
        return await actions_api._poe_cycle_impl(body, request, engine, user)
    if action == "ap_reboot":
        body = actions_api.ApRebootBody(device_id=int(params["device_id"]))
        return await actions_api._ap_reboot_impl(body, request, engine, user)
    # camera_reboot has no implementation yet (phase 22.4). Refusing here keeps
    # the proposal honest rather than reporting an execution that never happened.
    raise ActionRefused(
        f"{action} cannot be executed from NetMon yet — it is registered and "
        "audited, but its implementation lands in a later phase")


def _params(row: dict) -> dict:
    try:
        return json.loads(row.get("params") or "{}")
    except ValueError:
        return {}


def _pending_or_404(engine: Engine, proposal_id: int) -> dict:
    row = db.fetch_one(engine, "SELECT * FROM action_proposals WHERE id = :id",
                       {"id": proposal_id})
    if not row:
        raise HTTPException(status_code=404, detail="no such proposal")
    if row["status"] != "pending":
        raise HTTPException(status_code=409,
                            detail=f"this proposal is already {row['status']}")
    return dict(row)


def _close_run(engine: Engine, proposal: dict, message: str) -> None:
    """Release the run the proposal belongs to.

    Without this the run stays `awaiting_approval` forever and W9 blocks the
    device from ever being remediated again.
    """
    if not proposal.get("run_id"):
        return
    db.execute(
        engine,
        "UPDATE workflow_runs SET status = 'done', message = :m, finished_at = :now "
        "WHERE id = :id AND status = 'awaiting_approval'",
        {"m": message[:500], "now": datetime.now(timezone.utc), "id": proposal["run_id"]},
    )


def _validate_or_422(doc: dict) -> None:
    try:
        gr.parse(doc)
    except gr.GraphError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
