# `netmon.automation` — workflow remediation engine

Spec: [`docs/spec/22-automation-workflows.md`](../../docs/spec/22-automation-workflows.md)

NetMon's first component that can write to a source **without a human clicking
a button**. Everything in its design follows from that.

## What it is

A workflow is a small DAG — trigger → branches → actions — stored as JSON in
`workflows.graph`, edited visually (phase 22.3), and evaluated by the
`automation` supervised task every `[automation] interval_s`.

It owns no write path. Every action goes through
[`netmon/actions.py`](../actions.py)'s `AuditedAction` and a key in the closed
`ACTIONS` registry, so an operator reading `action_audit` sees automated and
human attempts in one trail with the same columns.

## Modules

| File | Role |
|---|---|
| `graph.py` | Closed node/predicate registry + validator. A graph names things; it can never carry a URL, host, credential or command. |
| `context.py` | The per-run fact snapshot. Gathered once so two guards cannot disagree because the fleet moved between their reads. |
| `guards.py` | G1–G10. Applied by the runner to every action step; **not expressible in a graph**, so the editor cannot weaken them. |
| `portmemory.py` | Records each powered device's access port while it is healthy. See below. |
| `runner.py` | Walks the DAG, asks the guards, writes down what it did or would have done. |
| `seed.py` | The default camera remediation workflow, seeded disabled and in shadow. |

## Three gates before anything happens

1. `[automation] enabled` — false by default; the task is not even registered.
2. `workflows.enabled` — 0 by default per workflow.
3. `workflows.shadow` — 1 by default. A shadow run evaluates every node, applies
   every guard, resolves the real port, and records `would_run` with the exact
   action and target — then stops short of the call.

Even fully live, **nothing marked `disruptive` in the action registry ever fires
unattended.** PoE cycles and camera reboots become an `action_proposals` row for
a human to approve. The runner has no code path that sends a disruptive action.

## Why `device_port_memory` exists

Measured against the production database on 2026-09-11:

| | cameras actually down (82) | healthy cameras (300 sampled) |
|---|---|---|
| resolves to a PoE-cycle-safe port | 15 (18%) | 281 (93%) |
| **no FDB entry at all** | **65 (79%)** | **0 (0%)** |

A camera that has lost power stops transmitting, so the switch ages its MAC out
of the forwarding table within minutes. Resolving the port at remediation time
structurally cannot work for the devices remediation exists for — so the port is
resolved and recorded *while the device is healthy*, and guard G5 reads the
remembered row, refusing anything that was never confirmed safe or is stale.

## Why the trigger is not `ping`

The owner's original sketch was "camera down → ping → if ping down, cycle PoE".
On this fleet all **211** cameras that ignore ICMP are recording normally, and
`recording` reads `up` for all 2659 devices — so ping-down means "this model
does not answer ICMP" far more often than it means "broken", and `recording` is
a constant.

The trigger is therefore `source_status = down` held 15 minutes, and ping is
consulted only *after* Milestone has independently said the device is down —
which is what the `ping_up` branch does, and why it branches toward a VMS
reconnect rather than a power cycle.

## Failure modes

* **A graph that no longer validates** is skipped and logged as an error; it
  keeps its `enabled` flag so it stays visible rather than silently dying.
* **A guard refusal** is written to `workflow_run_steps` with its code and
  reason. "Nothing happened" is always explainable from the table.
* **A crash mid-run** leaves the steps already decided, because steps are
  written as they are decided rather than batched at the end.
* **`_execute` is not yet wired** (phase 22.2). It refuses loudly rather than
  reporting a success it did not have.

## Running standalone

The runner and sampler follow the project task contract (`run_once` /
`run_guarded`) and are registered by the app lifespan when `[automation]
enabled` is true. A `--once` CLI lands with phase 22.2.

> Note the standing hazard (see project memory): a manual `--once` writes to the
> live database alongside the supervised task. Two writers racing on the same
> rows look like flapping.
