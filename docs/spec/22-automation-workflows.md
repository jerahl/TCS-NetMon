# Spec 22 — Automation workflow engine

**Status:** 22.1 built 2026-09-11 (shadow, default off); 22.2–22.4 open
**Owner ask (2026-09-11):** "start on an automation workflow engine… Start with the
cameras, for example. if a camera goes down ping in if ping is up connect to camera
and restart, if ping is down cycle poe on the camera port. I'd like to have a visual
workflow editor like in tracecat."

**Depends on:** spec 11 D4 (audited action chokepoint), spec 13 (direct camera
monitoring), spec 19/20 S8 (camera ops, `[camera_ops]`), `netmon/uplink.py`
(access-port resolution).

---

## 1. What this is

A **remediation** engine: it watches NetMon's own state, decides whether a
device's failure is one it can act on, and drives the *existing* audited action
chokepoint (`netmon/actions.py`) rather than growing a second way to write to
sources. A workflow is a small graph — trigger → checks → branch → action —
stored as JSON, edited visually, evaluated by a supervised task.

It is the first thing in NetMon that writes to a source **without a human
clicking the button**. Everything below follows from that one fact.

## 2. What the live fleet says about the owner's example

The literal rule ("camera down → ping → ping down → cycle PoE") was measured
against the production DB on 2026-09-11 before any code was written. Three
results changed the design.

### 2a. ICMP silence is not a camera fault

| ping | Milestone `recording` | cameras |
|---|---|---|
| up | up | 2438 |
| **down** | **up** | **211** |

Every one of the 211 cameras that ignores ICMP is recording. Firing PoE cycles
on `ping = down` would bounce 211 working cameras on the first pass. This is the
same finding already encoded in `engine.py::_states` (`device_types` narrowing)
and the reason it exists.

`recording` is `up` for all 2659 devices — it is a **constant**, so it cannot be
a trigger either. The signal that actually discriminates is
`source_status`: `up` 2410, `down` 102, `blind` 147.

`blind` means *Milestone* could not be reached, not that the camera failed
(CLAUDE.md §6: "blind must never render as healthy" — and must never be acted
on as if it were a device fault).

### 2b. A dead camera has already aged out of the FDB

`uplink_for_mac()` run over the 82 cameras that are both ping-down and
Milestone-down, against 300 randomly sampled healthy cameras:

| | dead (82) | healthy (300) |
|---|---|---|
| resolves to a `poe_cycle_safe` port | 15 (18%) | 281 (93%) |
| **no FDB entry at all** | **65 (79%)** | **0 (0%)** |

A camera that has lost power stops transmitting, so the switch ages its MAC out
of the forwarding table within minutes. **Resolving the port at remediation time
structurally cannot work for the exact devices remediation is for.**

→ Design consequence: `device_port_memory` (§4). The port is resolved and
recorded *while the device is healthy*, and remediation reads the remembered
port. A remembered port that was never `poe_cycle_safe`, or is older than
`require_port_confirmed_within`, is refused — not guessed.

### 2c. Failures cluster, so they are usually not device faults

The 82 dead cameras by site: MLK 11, University Place 10, Southview 7, TMS 7,
Bryant High 7, Rock Quarry 6, Central Elementary 5, Skyland 5.

Eleven cameras in one building did not independently fail. That is a closet, an
uplink, or an NVR. Remediating each one would issue 11 PoE cycles chasing one
upstream fault, and would keep doing it every cycle.

→ Design consequence: the **blast-radius guard** (§5, G4) is not a nicety. It is
the single guard most likely to fire in production on day one.

## 3. Decisions

| # | Decision | Date | Rationale |
|---|---|---|---|
| **W1** | **The engine gets no write path of its own.** Every action it takes goes through `netmon.actions.AuditedAction` and a key in the closed `ACTIONS` registry, with `actor = "automation:<workflow>"`. | 2026-09-11 | CLAUDE.md §4.1. One audited chokepoint was the whole point of D4; an automation engine that bypassed it would undo that. An operator reading `action_audit` sees automated and human attempts in one trail, with the same columns. |
| **W2** | **Autonomy splits on `ActionSpec.disruptive`.** `disruptive = False` runs automatically; `disruptive = True` queues an `action_proposals` row for human approval. | 2026-09-11 (owner) | The flag already exists on every registered action and already means exactly this. Nothing that cuts power or reboots hardware happens unattended. |
| **W3** | **Shadow-first, default off.** `workflows.shadow` defaults 1 and `workflows.enabled` defaults 0; `[automation] enabled` defaults false. In shadow, every step is evaluated and recorded as `would_run` and nothing leaves the building. | 2026-09-11 | CLAUDE.md §4.2/§4.3. The shadow trail is also how the owner tunes the guards before trusting them. |
| **W4** | **Guards are engine-level, not graph-level.** The blast-radius, cooldown, staleness, blind-source and port-confidence guards are applied by the runner to *every* action step and cannot be expressed, weakened, or removed from the editor. | 2026-09-11 | A visual editor whose graph could disable the safety checks is a footgun with a GUI. The editor composes intent; the engine keeps the invariants. |
| **W5** | **Node kinds are a closed registry**, like `ACTIONS`. The graph names a node kind and an action key; it can never carry a URL, a host, a command, or a snippet body. | 2026-09-11 | Same reasoning as `actions.py`: "There is no way to ask this module to POST an arbitrary URL." A workflow JSON row is operator-supplied data and is treated as such. |
| **W6** | **React Flow (`@xyflow/react`) is approved** as the 4th frontend dependency, bundled locally by esbuild and pinned in `package-lock.json`. No CDN. | 2026-09-11 (owner, CLAUDE.md §3) | The editor is the owner's ask; hand-rolling pan/zoom/drag/edge-routing is ~800 lines of undifferentiated work. |
| **W7** | **`camera_reboot` is approved** as a new `ACTIONS` entry: an RCP+ write to Bosch camera hardware, `disruptive = True`, behind `[camera_ops]`, default off. | 2026-09-11 (owner, CLAUDE.md §4.1) | The ping-up branch needs it as a *fallback*. It is a real hardware write and gets the same treatment as firmware: registry entry, config flag, audit row, approval queue. |
| **W8** | **The ping-up branch tries Milestone first.** `milestone_update_hardware` (non-disruptive, approved 2026-09-09) runs automatically; `camera_reboot` is only proposed if the camera is still down after it. | 2026-09-11 (owner) | If the camera answers ICMP, the broken thing is usually the VMS connection, not the camera. Cheapest correct fix first, and it is the one that needs no approval. |
| **W9** | **A run acts on one device at a time and is idempotent per (workflow, device).** A device with an open run or a pending proposal is not re-triggered. | 2026-09-11 | Without this, a 5-minute evaluation loop queues 12 proposals an hour for one broken camera. |

## 4. Data model (migration `032`)

| Table | Holds | Notes |
|---|---|---|
| `workflows` | name, description, `graph` JSON, `enabled` (default 0), `shadow` (default 1), version, audit columns | The React Flow document round-trips through `graph`. |
| `workflow_runs` | one evaluation of one workflow against one device | `status`, `shadow`, trigger reason, timings. |
| `workflow_run_steps` | per-node outcome: `taken` / `skipped` / `would_run` / `refused` / `failed` / `awaiting_approval`, with the reason | The shadow report reads from here. `action_audit_id` links a step to the existing audit row. |
| `action_proposals` | the approval queue for `disruptive` actions | Carries the rationale an operator needs to decide: which port, why it is believed safe, how old the evidence is, what else is down at that site. Expires. |
| `device_port_memory` | last access port resolved for a device **while it was healthy** | The §2b fix. `poe_cycle_safe`, `why`, `macs_on_port`, `confirmed_at`. One row per device, replace-on-refresh. |

`device_port_memory` is written by a sampler task that runs `uplink_for_mac()`
over healthy devices — never over a device that is currently down, because that
is precisely when the answer is wrong or absent.

## 5. The guards (engine-level, W4)

Applied to every action step, in this order. Each refusal is recorded on the
step with its reason, so the shadow report says *why* nothing happened.

| # | Guard | Refuses when |
|---|---|---|
| G1 | **Source not blind** | The failure signal came from a source reporting `blind` for this device. A blind source is evidence about the source, not the device (§2a). |
| G2 | **Freshness** | The state rows the decision rests on are older than `max_state_age_s`. Never act on stale data (CLAUDE.md §4.5). |
| G3 | **Native tiebreaker** | The federated source says down but the native poller says the device is reachable (`netmon.state.device_down`), the same tiebreaker `engine.py` already applies. |
| G4 | **Blast radius** | More than `site_cluster_max` devices of this type are down at the same site, or more than `switch_cluster_max` behind the same switch. Escalates to an alert instead (§2c). |
| G5 | **Port confidence** | The remembered port is missing, was not `poe_cycle_safe`, or was confirmed longer ago than `require_port_confirmed_within`. PoE-cycling an unconfirmed port is how you bounce a 10G uplink (`uplink.py`). |
| G6 | **Upstream alive** | The switch the port belongs to is itself down. The camera is not the fault. |
| G7 | **Cooldown** | This workflow acted on this device within `per_device_cooldown_s`. |
| G8 | **Rate limit** | The workflow has already taken `fleet_rate_limit` actions this hour. |
| G9 | **Maintenance** | A `maintenance_windows` row covers the device, its site, or its type. |
| G10 | **Action enabled** | The `[actions]`/`[camera_ops]` flag for the action key is off, or `ACTIONS` does not contain it. Delegated to `actions.py`, not reimplemented. |

## 6. The camera workflow (`camera_down_remediation`)

Encoded as the seeded default graph, disabled and in shadow.

```
trigger: source_status = down for >= 15m, device_type = camera
   |
   +- G1 source not blind ....................... else stop, alert
   +- G2/G3 state fresh, native agrees .......... else stop
   +- G4 blast radius ........................... else stop, alert "site-wide"
   |
   +-- branch on native ping state
       |
       +-- ping UP (camera on the network, VMS lost it)
       |     -> milestone_update_hardware   [not disruptive -> automatic]
       |     -> wait 5m, re-check
       |     -> still down? camera_reboot   [disruptive -> PROPOSE]
       |
       +-- ping DOWN (camera off the network)
             -> G5 remembered port, confirmed & safe .... else stop, alert
             -> G6 switch itself is up .................. else stop
             -> poe_cycle(remembered port)  [disruptive -> PROPOSE]
             -> wait 5m, re-check; still down? alert, do not retry
```

Note what the ping-down branch does **not** do: it does not resolve the port
live, and it does not act on 211 cameras that merely ignore ICMP, because ICMP
is only consulted *after* Milestone has independently said the device is down.

## 7. Phases

| Phase | Deliverable | State |
|---|---|---|
| 22.1 | Spec, migration `032`, `device_port_memory` + sampler, guards, runner, node registry, seeded camera workflow — all shadow, default off | ✅ built 2026-09-11 |
| 22.2 | `/api/automation` — workflows CRUD, runs/steps, shadow report, proposal approve/dismiss | |
| 22.3 | React Flow editor + Automation page + proposal queue in the UI | |
| 22.4 | `camera_reboot` RCP+ implementation (W7) behind `[camera_ops]` | |
| 22.5 | Owner reviews the shadow trail, flips `shadow = false` per workflow | owner-gated |

## 8. Next session

**Built in 22.1:** `netmon/automation/{graph,context,guards,portmemory,runner,seed}.py`,
migration `032`, `[automation]` config section + `netmon.conf.example`, lifespan
wiring for the `automation` and `port_memory` tasks, `camera_reboot` registered
in `ACTIONS` (W7), 30 tests in `tests/test_automation.py` + 3 in
`tests/test_migrations.py`. Full suite green.

**Start 22.2 with:**

- `WorkflowRunner._execute` is a deliberate stub. It refuses loudly rather than
  reporting success it did not have, so `milestone_update_hardware` is not
  actually callable from a workflow yet. Wire it through `AuditedAction` the
  way `api/actions.py` does, and record the `action_audit_id` on the step.
- `wait` nodes end the evaluation and mark the run `done` with a "resumes on a
  later cycle" message, but nothing resumes them yet — the run has no cursor.
  22.2 needs either a `resume_at`/`resume_node` pair on `workflow_runs` or a
  re-trigger that picks the run up where it stopped. As shipped, the ping-up
  arm reaches `milestone_update_hardware` and then stops at `settle`; the
  `camera_reboot` fallback is unreachable until this lands.
- Proposal expiry is stored (`expires_at`) but nothing sweeps it.

**Open questions:**

- `max_state_age_s` is a guess at 1800s. Tune it against the Milestone
  collector's real cadence once the shadow trail has a week of runs.
- Should an expired proposal raise an alert, or die silently? Leaning alert —
  a proposal nobody looked at is itself a finding.
- The shadow report (22.2) should surface "runs that refused, grouped by guard
  code". If G4 dominates for a week, the fleet is telling us the site limit is
  wrong, not that the engine is working.
