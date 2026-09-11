"""The workflow runner: evaluate graphs against state, record everything.

Spec 22. The runner is deliberately dull. It walks a validated DAG, asks the
guards before every action, and writes down what it did or would have done. All
the judgement lives in `guards.py`; all the authority to send anything lives in
`netmon/actions.py`.

Three properties are worth stating because the rest of the module is built to
preserve them:

* **Shadow is not a dry-run flag checked at the end.** A shadow run evaluates
  every node, applies every guard, resolves the real port and writes a
  `would_run` step naming the exact action and target — then stops short of the
  call. The shadow trail is meant to be readable as "here is what would have
  happened", which it cannot be if the guards were skipped.
* **Disruptive actions never execute here** (spec 22 W2). They become an
  `action_proposals` row. The runner has no code path that sends a disruptive
  action, live mode included.
* **A crash leaves evidence.** Steps are written as they are decided, not
  batched at the end, so a run killed mid-flight still shows where it got to.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy.engine import Engine

from netmon import db, health
from netmon.actions import ACTIONS, ActionSpec, AuditedAction, action_or_refuse
from netmon.automation import graph as gr
from netmon.automation.context import Context
from netmon.automation.guards import Refusal, check_all
from netmon.state import REACHABILITY_FLAGS_SQL, device_down

log = logging.getLogger("netmon.automation")

#: A branch predicate: given the run context, is it true? None means "cannot
#: tell", which the runner treats as false and records as such — an unanswerable
#: question must not silently take the true arm toward an action.
Predicate = Callable[[Context], "bool | None"]


def _ping_up(ctx: Context) -> bool | None:
    if not ctx.flags.get("has_state"):
        return None
    if ctx.flags.get("ping_up"):
        return True
    if ctx.flags.get("ping_down"):
        return False
    return None  # never probed — not the same as "does not answer"


_PREDICATES: dict[str, Predicate] = {
    "ping_up": _ping_up,
    "ping_down": lambda ctx: None if _ping_up(ctx) is None else not _ping_up(ctx),
    "device_down": lambda ctx: device_down(ctx.flags),
    "source_blind": lambda ctx: ctx.state_value("source_status") == "blind",
    "port_memory_confirmed": lambda ctx: bool(
        (ctx.port_memory() or {}).get("poe_cycle_safe")),
    "switch_up": lambda ctx: (
        None if not (ctx.port_memory() or {}).get("switch_device_id")
        else not ctx.device_is_down(int(ctx.port_memory()["switch_device_id"]))),
    # "Is the thing we triggered on still true?" — re-read from the database,
    # because the whole point of the `wait` before it is that something may
    # have changed.
    #
    # Deliberately *not* `device_down()`. The tiebreaker answers a different
    # question, and answers it wrongly here: a camera that answers ICMP while
    # Milestone still cannot see it reads as "not down", so a run that had just
    # failed to fix anything would route to "recovered" and close.
    "still_down": lambda ctx: (
        ctx.reread_state_value(ctx.trigger_dimension) == ctx.trigger_value),
}


class WorkflowRunner:
    """Supervised task: evaluate every enabled workflow over its trigger set."""

    name = "automation"

    def __init__(self, engine: Engine, cfg: Any,
                 action_enabled: Callable[[str], bool] | None = None,
                 milestone_factory: Callable[[], Any] | None = None) -> None:
        self.engine = engine
        self.cfg = cfg
        self.interval_s = float(getattr(cfg, "interval_s", 300))
        self.timeout_s = max(120.0, self.interval_s)
        # Injected so the guards never have to know the shape of `[actions]`
        # or `[camera_ops]` (G10).
        self.action_enabled = action_enabled or (lambda key: False)
        #: Returns a MilestoneClient, or None when the VMS is unusable. Injected
        #: so this module never parses `[milestone]` itself, and so tests can
        #: drive it with a fake.
        self.milestone_factory = milestone_factory

    # --- workflow selection --------------------------------------------------

    def _workflows(self) -> list[dict[str, Any]]:
        return db.fetch_all(
            self.engine,
            "SELECT id, name, title, graph, enabled, shadow, version "
            "FROM workflows WHERE enabled = 1 ORDER BY id",
        )

    def _trigger_devices(self, node: gr.Node) -> list[dict[str, Any]]:
        """Devices currently matching a trigger, already held long enough.

        The hold is measured from `state_events` — the transition log — not from
        `device_state.updated_at`, which moves every time a collector rewrites
        the same value and would restart the clock on every cycle.
        """
        cfg = node.config
        dim, value = str(cfg["dimension"]), str(cfg["value"])
        device_type = str(cfg.get("device_type") or "").strip()
        params: dict[str, Any] = {"dim": dim, "val": value}
        type_clause = ""
        if device_type:
            type_clause = " AND d.device_type = :dt"
            params["dt"] = device_type
        rows = db.fetch_all(
            self.engine,
            "SELECT d.id AS device_id, d.name AS name, s.updated_at AS updated_at, "
            "  (SELECT MAX(e.occurred_at) FROM state_events e "
            "    WHERE e.device_id = d.id AND e.dimension = :dim) AS changed_at "
            "FROM devices d JOIN device_state s ON s.device_id = d.id "
            f"WHERE d.enabled = 1 AND s.dimension = :dim AND s.value = :val{type_clause}",
            params,
        )
        min_hold = int(cfg.get("min_duration_s") or 0)
        if not min_hold:
            return rows
        now = datetime.now(timezone.utc)
        held = []
        for row in rows:
            since = _as_dt(row.get("changed_at")) or _as_dt(row.get("updated_at"))
            if since is None or (now - since).total_seconds() >= min_hold:
                held.append(row)
        return held

    def _has_live_run(self, workflow_id: int, device_id: int) -> bool:
        """Spec 22 W9. Without this, a 5-minute loop queues 12 proposals an
        hour for one broken camera."""
        row = db.fetch_one(
            self.engine,
            "SELECT 1 AS x FROM workflow_runs "
            "WHERE workflow_id = :w AND device_id = :d "
            "AND status IN ('running', 'waiting', 'awaiting_approval') LIMIT 1",
            {"w": workflow_id, "d": device_id},
        )
        if row:
            return True
        row = db.fetch_one(
            self.engine,
            "SELECT 1 AS x FROM action_proposals "
            "WHERE workflow_id = :w AND device_id = :d AND status = 'pending' LIMIT 1",
            {"w": workflow_id, "d": device_id},
        )
        return bool(row)

    # --- the cycle -----------------------------------------------------------

    async def run_once(self) -> int:
        # Parked runs first: a device mid-remediation must be finished before
        # the trigger scan considers starting another run for it (W9).
        runs = await self._resume_due()
        self._expire_proposals()
        for wf in self._workflows():
            try:
                graph = gr.parse(wf["graph"])
            except gr.GraphError as exc:
                # A workflow that no longer validates is disabled in effect but
                # loudly, not silently: it keeps its enabled flag so the owner
                # sees it in the UI with the parse error attached.
                log.error("workflow %s (%s) has an invalid graph and will not run: %s",
                          wf["id"], wf["name"], exc)
                continue
            devices = self._trigger_devices(graph.trigger)
            if devices:
                log.info("workflow %s: %d device(s) match the trigger",
                         wf["name"], len(devices))
            for dev in devices:
                if self._has_live_run(int(wf["id"]), int(dev["device_id"])):
                    continue
                try:
                    await self._run_one(wf, graph, int(dev["device_id"]))
                    runs += 1
                except Exception:
                    log.exception("workflow %s failed on device %s",
                                  wf["name"], dev["device_id"])
        return runs

    async def _resume_due(self) -> int:
        """Continue runs whose wait has elapsed.

        A run is resumed at most once per cycle and only when its workflow is
        still enabled and its graph still validates — an owner who disables a
        workflow while a run is parked should not have it wake up later.
        """
        now = datetime.now(timezone.utc)
        due = db.fetch_all(
            self.engine,
            "SELECT r.id, r.workflow_id, r.device_id, r.resume_node, r.shadow, "
            "       w.name, w.graph, w.enabled, w.version "
            "FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id "
            "WHERE r.status = 'waiting' AND r.resume_at IS NOT NULL "
            "AND r.resume_at <= :now",
            {"now": now},
        )
        resumed = 0
        for row in due:
            if not row["enabled"]:
                self._abandon(int(row["id"]),
                              "the workflow was disabled while this run was waiting")
                continue
            try:
                graph = gr.parse(row["graph"])
            except gr.GraphError as exc:
                self._abandon(int(row["id"]),
                              f"the workflow graph no longer validates: {exc}")
                continue
            node_id = str(row["resume_node"] or "")
            if node_id not in graph.nodes:
                # The graph was edited under the parked run and the node it was
                # coming back to is gone. Abandoning is the honest outcome:
                # picking a "nearby" node would resume a workflow the owner did
                # not write.
                self._abandon(int(row["id"]),
                              f"node '{node_id}' no longer exists in the workflow")
                continue
            try:
                await self._continue(row, graph, node_id)
                resumed += 1
            except Exception:
                log.exception("workflow %s failed resuming run %s", row["name"], row["id"])
        return resumed

    def _abandon(self, run_id: int, why: str) -> None:
        db.execute(
            self.engine,
            "UPDATE workflow_runs SET status = 'done', message = :m, "
            "resume_at = NULL, resume_node = NULL, finished_at = :now WHERE id = :id",
            {"m": why[:500], "now": datetime.now(timezone.utc), "id": run_id},
        )
        log.info("workflow run %s abandoned: %s", run_id, why)

    async def _continue(self, row: dict[str, Any], graph: gr.Graph, node_id: str) -> None:
        """Resume a parked run from `node_id`, reusing its run and step sequence."""
        ctx = Context.build(
            self.engine, self.cfg, workflow_id=int(row["workflow_id"]),
            workflow_name=str(row["name"]), device_id=int(row["device_id"]),
            trigger_dimension=str(graph.trigger.config["dimension"]),
            trigger_value=str(graph.trigger.config["value"]),
        )
        ctx.run_id = int(row["id"])
        ctx.action_enabled = self.action_enabled
        state = _RunState(run_id=int(row["id"]), shadow=bool(row["shadow"]))
        state.seq = self._last_seq(int(row["id"]))
        db.execute(self.engine,
                   "UPDATE workflow_runs SET status = 'running', resume_at = NULL, "
                   "resume_node = NULL WHERE id = :id", {"id": row["id"]})
        cursor: str | None = node_id
        while cursor is not None:
            cursor = await self._visit(ctx, graph, state, graph.nodes[cursor])
        self._close_run(int(row["id"]), state)

    def _last_seq(self, run_id: int) -> int:
        row = db.fetch_one(self.engine,
                           "SELECT MAX(seq) AS s FROM workflow_run_steps WHERE run_id = :r",
                           {"r": run_id})
        return int((row or {}).get("s") or 0)

    def _expire_proposals(self) -> int:
        """Age out proposals nobody acted on.

        An expired proposal is left visible with `status = 'expired'` rather
        than deleted: a remediation nobody looked at for a day is itself a
        finding, and the row is the evidence.
        """
        n = db.execute(
            self.engine,
            "UPDATE action_proposals SET status = 'expired' "
            "WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= :now",
            {"now": datetime.now(timezone.utc)},
        )
        if n:
            log.info("automation: expired %d unactioned proposal(s)", n)
        return int(n or 0)

    async def _run_one(self, wf: dict[str, Any], graph: gr.Graph, device_id: int) -> None:
        shadow = bool(wf["shadow"])
        trigger = graph.trigger
        ctx = Context.build(
            self.engine, self.cfg, workflow_id=int(wf["id"]),
            workflow_name=str(wf["name"]), device_id=device_id,
            trigger_dimension=str(trigger.config["dimension"]),
            trigger_value=str(trigger.config["value"]),
        )
        ctx.action_enabled = self.action_enabled
        reason = (f"{trigger.config['dimension']}={trigger.config['value']} "
                  f"held {int(trigger.config.get('min_duration_s') or 0) // 60}m")
        run_id = self._open_run(wf, device_id, reason, shadow)
        ctx.run_id = run_id
        state = _RunState(run_id=run_id, shadow=shadow)
        self._step(state, trigger, "taken", f"{ctx.name}: {reason}")

        node_id: str | None = _first(graph.next_ids(trigger.id))
        while node_id is not None:
            node = graph.nodes[node_id]
            node_id = await self._visit(ctx, graph, state, node)
        self._close_run(run_id, state)

    async def _visit(self, ctx: Context, graph: gr.Graph, state: "_RunState",
                     node: gr.Node) -> str | None:
        """Execute one node; return the next node id, or None to stop."""
        if node.kind == "stop":
            self._step(state, node, "taken", "workflow ends here")
            return None

        if node.kind == "branch":
            pred_name = str(node.config["predicate"])
            answer = _PREDICATES[pred_name](ctx)
            if answer is None:
                # Unanswerable is not false-with-a-shrug: record it plainly and
                # take the false arm, which by convention is the cautious one.
                self._step(state, node, "skipped",
                           f"{pred_name}: cannot tell from the state NetMon holds; "
                           "taking the 'no' arm")
                answer = False
            else:
                self._step(state, node, "taken",
                           f"{gr.PREDICATES[pred_name]} {'yes' if answer else 'no'}")
            return _first(graph.next_ids(node.id, when="true" if answer else "false"))

        if node.kind == "wait":
            # The runner does not sleep. A `wait` parks the run with a cursor —
            # a task that blocked for five minutes would hold its supervisor
            # slot and stall every other workflow behind it. `_resume_due()`
            # picks it up on a later cycle and continues from `resume_node`.
            seconds = int(node.config.get("seconds") or 300)
            resume_node = _first(graph.next_ids(node.id))
            if resume_node is None:
                self._step(state, node, "skipped",
                           "nothing is wired after this wait, so there is nothing to "
                           "come back for")
                return None
            self._step(state, node, "skipped",
                       f"waiting {seconds // 60}m before re-checking, then continuing "
                       f"at '{resume_node}'")
            state.paused = True
            state.resume_at = datetime.now(timezone.utc) + timedelta(seconds=seconds)
            state.resume_node = resume_node
            return None

        if node.kind == "alert":
            summary = str(node.config.get("summary") or "")
            self._step(state, node, "would_run" if state.shadow else "taken",
                       f"alert: {summary.format(device=ctx.name, site=ctx.site)}"
                       if "{" in summary else f"alert: {summary}")
            return _first(graph.next_ids(node.id))

        if node.kind == "action":
            return await self._action(ctx, graph, state, node)

        self._step(state, node, "skipped", f"nothing to do for a {node.kind} node")
        return _first(graph.next_ids(node.id))

    async def _action(self, ctx: Context, graph: gr.Graph, state: "_RunState",
                      node: gr.Node) -> str | None:
        key = str(node.config["action"])
        ctx.action_key = key
        try:
            spec = action_or_refuse(key)
        except Exception as exc:
            self._step(state, node, "refused", str(exc))
            return None

        refusal = check_all(ctx)
        if refusal is not None:
            self._step(state, node, "refused", f"[{refusal.code}] {refusal.reason}")
            state.refused = refusal
            return None

        target, params = self._target_for(ctx, spec)

        if spec.disruptive:
            # Spec 22 W2. There is no live branch below this line: the runner
            # cannot fire a disruptive action, in shadow or out of it.
            rationale = self._rationale(ctx, spec, target)
            if state.shadow:
                self._step(state, node, "would_run",
                           f"would propose {spec.label} on {target} for approval — "
                           f"{rationale}")
            else:
                self._propose(ctx, state, spec, target, params, rationale)
                self._step(state, node, "awaiting_approval",
                           f"{spec.label} on {target} is queued for approval — {rationale}")
                state.awaiting = True
            return None

        if state.shadow:
            self._step(state, node, "would_run",
                       f"would run {spec.label} on {target} ({spec.effect})")
            return _first(graph.next_ids(node.id))

        audit_id, outcome, message = await self._execute(ctx, spec, target, params)
        decision = {"ok": "taken", "unsupported": "skipped"}.get(outcome, "failed")
        self._step(state, node, decision, f"{spec.label} on {target}: {message}",
                   action_audit_id=audit_id)
        if outcome == "failed":
            return None
        # `unsupported` continues: the point of the fallback wired after this
        # node is to cover exactly the case where the cheap fix is unavailable.
        return _first(graph.next_ids(node.id))

    # --- action plumbing -----------------------------------------------------

    def _target_for(self, ctx: Context, spec: ActionSpec) -> tuple[str, dict[str, Any]]:
        """What this action would be aimed at, resolved from remembered facts.

        Resolved in shadow mode too — a shadow trail that said "would cycle PoE
        on <unknown>" would not be reviewable, and resolving is read-only.
        """
        if spec.key == "poe_cycle":
            mem = ctx.port_memory() or {}
            port = str(mem.get("port") or "?")
            return (f"{mem.get('switch_name') or 'switch'} port {port}",
                    {"device_id": mem.get("switch_device_id"), "port": port,
                     "confirmed_at": str(mem.get("confirmed_at") or "")})
        return ctx.name, {"device_id": ctx.device_id}

    def _rationale(self, ctx: Context, spec: ActionSpec, target: str) -> str:
        """Everything an operator needs to decide without leaving the page."""
        bits = [spec.effect]
        if spec.key == "poe_cycle":
            mem = ctx.port_memory() or {}
            bits.append(f"port evidence: {mem.get('why') or 'unknown'}, "
                        f"last confirmed {mem.get('confirmed_at')}, "
                        f"{mem.get('macs_on_port')} MAC(s) on the port")
        peers = ctx.peers_down_at_site()
        if peers > 1:
            bits.append(f"note: {peers} {ctx.device_type}s are down at {ctx.site}")
        return "; ".join(str(b) for b in bits)

    def _propose(self, ctx: Context, state: "_RunState", spec: ActionSpec,
                 target: str, params: dict[str, Any], rationale: str) -> None:
        expires = ctx.now + timedelta(seconds=int(self.cfg.proposal_ttl_s))
        db.execute(
            self.engine,
            "INSERT INTO action_proposals "
            "(run_id, workflow_id, device_id, action, target, params, rationale, "
            " status, expires_at, created_at) "
            "VALUES (:run, :wf, :dev, :a, :t, :p, :why, 'pending', :exp, :now)",
            {"run": state.run_id, "wf": ctx.workflow_id, "dev": ctx.device_id,
             "a": spec.key, "t": target[:128], "p": json.dumps(params, default=str),
             "why": rationale, "exp": expires, "now": ctx.now},
        )

    async def _execute(self, ctx: Context, spec: ActionSpec, target: str,
                       params: dict[str, Any]) -> tuple[int | None, str, str]:
        """Carry out a **non-disruptive** action. Never reached for a disruptive
        one — see `_action`.

        Returns ``(audit_id, outcome, message)`` where outcome is ``ok``,
        ``failed`` or ``unsupported``. The third is not a failure: a VMS that
        does not offer a task is a capability gap, and treating it as a failure
        would stop the run at a step that was never going to work, stranding the
        fallback behind it.
        """
        if spec.key != "milestone_update_hardware":
            # Nothing else registered is non-disruptive today. Refusing by
            # default means a newly registered action cannot start firing from a
            # workflow before anyone wires and reviews it here.
            return None, "failed", (f"{spec.key} has no automated implementation; "
                                    "nothing was sent")
        return await self._milestone_refresh(ctx, spec, target)

    async def _milestone_refresh(self, ctx: Context, spec: ActionSpec,
                                 target: str) -> tuple[int | None, str, str]:
        """Ask Milestone to re-detect a camera it already manages.

        **This estate does not currently offer the task.** `UpdateHardware` is
        advertised per-hardware, and on this VMS no hardware advertises it at
        all, so the capability is checked *before* an audit row is opened — the
        same order `cameras/runner.py` uses, and for the same reason: a
        supported-nowhere feature must not write a "failed" audit row per camera
        and make the trail look like an outage.
        """
        from netmon.collectors.milestone_client import TASK_UPDATE_HARDWARE

        row = db.fetch_one(
            self.engine,
            "SELECT c.hardware_id FROM cameras c WHERE c.device_id = :d",
            {"d": ctx.device_id},
        )
        hardware_id = str((row or {}).get("hardware_id") or "").strip()
        if not hardware_id:
            return None, "unsupported", ("NetMon holds no Milestone hardware id for this "
                                         "camera, so the VMS cannot be asked to re-detect it")
        factory = self.milestone_factory
        client = factory() if factory else None
        if client is None:
            return None, "unsupported", "no Milestone client is configured"

        try:
            available = await client.hardware_tasks(hardware_id)
        except Exception as exc:  # noqa: BLE001 — a read failure is not a fault here
            return None, "unsupported", f"could not read the VMS task list: {exc!r}"
        if TASK_UPDATE_HARDWARE not in available:
            return None, "unsupported", (
                f"this VMS does not offer {TASK_UPDATE_HARDWARE} for the camera "
                f"(it advertises {', '.join(available) or 'nothing'})")

        with AuditedAction(self.engine, spec, actor=f"automation:{ctx.workflow_name}",
                           role="automation", device_id=ctx.device_id, target=target,
                           params={"hardware_id": hardware_id}) as audit:
            try:
                status_code, body = await client.update_hardware(hardware_id)
            except Exception as exc:  # noqa: BLE001
                audit.failed(f"UpdateHardware failed: {exc!r}")
                return audit.audit_id, "failed", f"UpdateHardware failed: {exc!r}"
            if status_code >= 400:
                audit.failed(f"UpdateHardware answered HTTP {status_code}: {body[:200]}",
                             http_status=status_code)
                return audit.audit_id, "failed", f"the VMS answered HTTP {status_code}"
            audit.ok("Milestone asked to re-detect the camera", http_status=status_code)
            return audit.audit_id, "ok", "Milestone asked to re-detect the camera"

    # --- run bookkeeping -----------------------------------------------------

    def _open_run(self, wf: dict[str, Any], device_id: int, reason: str,
                  shadow: bool) -> int:
        now = datetime.now(timezone.utc)
        db.execute(
            self.engine,
            "INSERT INTO workflow_runs "
            "(workflow_id, workflow_version, device_id, trigger_reason, status, "
            " shadow, started_at) "
            "VALUES (:w, :v, :d, :r, 'running', :s, :now)",
            {"w": wf["id"], "v": wf.get("version") or 1, "d": device_id,
             "r": reason[:255], "s": 1 if shadow else 0, "now": now},
        )
        row = db.fetch_one(
            self.engine,
            "SELECT id FROM workflow_runs WHERE workflow_id = :w AND device_id = :d "
            "ORDER BY id DESC LIMIT 1",
            {"w": wf["id"], "d": device_id},
        )
        return int(row["id"]) if row else 0

    def _step(self, state: "_RunState", node: gr.Node, decision: str, detail: str,
              action_audit_id: int | None = None) -> None:
        state.seq += 1
        db.execute(
            self.engine,
            "INSERT INTO workflow_run_steps "
            "(run_id, seq, node_id, node_kind, label, decision, detail, "
            " action_audit_id, at) "
            "VALUES (:r, :seq, :nid, :kind, :label, :dec, :detail, :audit, :now)",
            {"r": state.run_id, "seq": state.seq, "nid": node.id, "kind": node.kind,
             "label": node.label[:255], "dec": decision, "detail": detail[:1000],
             "audit": action_audit_id, "now": datetime.now(timezone.utc)},
        )

    def _close_run(self, run_id: int, state: "_RunState") -> None:
        if state.awaiting:
            status, message = "awaiting_approval", "queued for operator approval"
        elif state.refused is not None:
            status = "refused"
            message = f"[{state.refused.code}] {state.refused.reason}"
        elif state.paused:
            status = "waiting"
            message = f"waiting until {state.resume_at:%H:%M} to continue at '{state.resume_node}'"
        else:
            status, message = "done", "completed"
        # A parked run has not finished, so it keeps a NULL `finished_at` and
        # carries the cursor instead.
        db.execute(
            self.engine,
            "UPDATE workflow_runs SET status = :s, message = :m, finished_at = :fin, "
            "resume_at = :rat, resume_node = :rnode WHERE id = :id",
            {"s": status, "m": message[:500],
             "fin": None if status == "waiting" else datetime.now(timezone.utc),
             "rat": state.resume_at if status == "waiting" else None,
             "rnode": state.resume_node if status == "waiting" else None,
             "id": run_id},
        )

    # --- supervisor contract -------------------------------------------------

    async def run_guarded(self) -> None:
        health.record_start(self.engine, self.name)
        started = time.monotonic()
        try:
            n = await self.run_once()
        except Exception as exc:
            health.record_error(self.engine, self.name, message=repr(exc),
                                duration_ms=int((time.monotonic() - started) * 1000))
            log.exception("workflow runner failed")
            return
        health.record_success(self.engine, self.name, records=n,
                              duration_ms=int((time.monotonic() - started) * 1000))


class _RunState:
    def __init__(self, run_id: int, shadow: bool) -> None:
        self.run_id = run_id
        self.shadow = shadow
        self.seq = 0
        self.refused: Refusal | None = None
        self.awaiting = False
        self.paused = False
        self.resume_at: datetime | None = None
        self.resume_node: str | None = None


def _first(ids: list[str]) -> str | None:
    return ids[0] if ids else None


def _as_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
