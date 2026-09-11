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
from netmon.actions import ACTIONS, ActionSpec, action_or_refuse
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
    # Re-reads state from the database rather than the cached snapshot: the
    # whole point of a `wait` node is that something may have changed.
    "still_down": lambda ctx: device_down(_reread_flags(ctx)),
}


def _reread_flags(ctx: Context) -> dict[str, Any]:
    from netmon.automation.context import _FLAGS_ONE_SQL
    row = db.fetch_one(ctx.engine, _FLAGS_ONE_SQL, {"id": ctx.device_id})
    return dict(row) if row else {}


class WorkflowRunner:
    """Supervised task: evaluate every enabled workflow over its trigger set."""

    name = "automation"

    def __init__(self, engine: Engine, cfg: Any,
                 action_enabled: Callable[[str], bool] | None = None) -> None:
        self.engine = engine
        self.cfg = cfg
        self.interval_s = float(getattr(cfg, "interval_s", 300))
        self.timeout_s = max(120.0, self.interval_s)
        # Injected so the guards never have to know the shape of `[actions]`
        # or `[camera_ops]` (G10).
        self.action_enabled = action_enabled or (lambda key: False)

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
            "AND status IN ('running', 'awaiting_approval') LIMIT 1",
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
        runs = 0
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
                    self._run_one(wf, graph, int(dev["device_id"]))
                    runs += 1
                except Exception:
                    log.exception("workflow %s failed on device %s",
                                  wf["name"], dev["device_id"])
        return runs

    def _run_one(self, wf: dict[str, Any], graph: gr.Graph, device_id: int) -> None:
        shadow = bool(wf["shadow"])
        trigger = graph.trigger
        ctx = Context.build(
            self.engine, self.cfg, workflow_id=int(wf["id"]),
            workflow_name=str(wf["name"]), device_id=device_id,
            trigger_dimension=str(trigger.config["dimension"]),
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
            node_id = self._visit(ctx, graph, state, node)
        self._close_run(run_id, state)

    def _visit(self, ctx: Context, graph: gr.Graph, state: "_RunState",
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
            # The runner does not sleep. A `wait` ends this evaluation and the
            # run resumes on a later cycle — a task that blocked for five
            # minutes would hold its supervisor slot and stall every other
            # workflow behind it.
            seconds = int(node.config.get("seconds") or 300)
            self._step(state, node, "skipped",
                       f"waiting {seconds // 60}m before re-checking; the run resumes "
                       "on a later cycle")
            state.paused = True
            return None

        if node.kind == "alert":
            summary = str(node.config.get("summary") or "")
            self._step(state, node, "would_run" if state.shadow else "taken",
                       f"alert: {summary.format(device=ctx.name, site=ctx.site)}"
                       if "{" in summary else f"alert: {summary}")
            return _first(graph.next_ids(node.id))

        if node.kind == "action":
            return self._action(ctx, graph, state, node)

        self._step(state, node, "skipped", f"nothing to do for a {node.kind} node")
        return _first(graph.next_ids(node.id))

    def _action(self, ctx: Context, graph: gr.Graph, state: "_RunState",
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

        audit_id, ok, message = self._execute(ctx, spec, target, params)
        self._step(state, node, "taken" if ok else "failed",
                   f"{spec.label} on {target}: {message}", action_audit_id=audit_id)
        if not ok:
            return None
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

    def _execute(self, ctx: Context, spec: ActionSpec, target: str,
                 params: dict[str, Any]) -> tuple[int | None, bool, str]:
        """Non-disruptive actions only — see `_action`.

        Not yet wired to the source clients: phase 22.2 connects
        `milestone_update_hardware` here through the same `AuditedAction`
        chokepoint `api/actions.py` uses. Until then this refuses loudly rather
        than pretending, so nothing can quietly report success it did not have
        (CLAUDE.md §4.5).
        """
        return None, False, ("not wired yet — phase 22.2 connects this through "
                             "AuditedAction; nothing was sent")

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
            status, message = "done", "paused at a wait node; resumes on a later cycle"
        else:
            status, message = "done", "completed"
        db.execute(
            self.engine,
            "UPDATE workflow_runs SET status = :s, message = :m, finished_at = :now "
            "WHERE id = :id",
            {"s": status, "m": message[:500], "now": datetime.now(timezone.utc),
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
