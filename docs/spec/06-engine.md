# Spec 06 — Alert engine, shadow mode (Phase 6)

**Goal:** the part Zabbix does best, rebuilt small and cautious. Rules
(rows, not code) evaluate `device_state`; matches dedupe into one open `alert`
per (device, rule); a duration gate and maintenance windows damp noise; a
notifier records what it *would* send. Ships in **shadow mode** — logs
would-be notifications, sends nothing — until the owner flips it at cutover
(Phase 8).

## Evaluation loop (`engine/`)

Runs as one supervised task on a short interval (same model as collectors).
Each cycle:

1. **Load** enabled `alert_rules` (dimension + condition + severity +
   `min_duration_s` + target).
2. **Match** each rule against `device_state` for its dimension. `condition` is
   stored data — `{"op": "eq"|"ne"|"in", "value": ...}` — evaluated by a pure
   function (`rules.evaluate`).
3. **Duration gate:** a match only fires once the state has held for
   `min_duration_s`. "Held since" = the most recent `state_events.occurred_at`
   for that (device, dimension) — the moment the current value began (falls
   back to `device_state.updated_at`).
4. **Dedupe:** one **open** alert per (device, rule). New match with no open
   alert → open one (`opened_at`); already open → bump `last_seen_at`; a device
   that no longer matches → **close** the open alert (`closed_at`). Re-fires
   never duplicate. (MariaDB also enforces this with a generated `open_key`
   unique index; the engine logic is portable and doesn't rely on it.)
5. **Notify** on a newly-opened alert → a `notifications` row. Maintenance
   windows suppress the *notification*, not the alert/state recording.

## Maintenance windows

`maintenance_windows` scope a device / site / device_type over a time range.
An open/opening alert whose device falls in an active window still records, but
its notification is marked suppressed (no shadow/real send). Ack and windows
exist from day one — without them, notification fatigue kills trust.

## Notifier (`engine/notify.py`)

SMTP only (v1). `[engine] shadow=true` by default: every notification is
written to `notifications` with `shadow=1` and nothing is sent. When
`shadow=false` (owner, at cutover) a matching row is emailed via `[engine]
smtp_*` and written with `shadow=0`. Suppressed-by-maintenance notifications are
recorded with a summary noting the suppression and never sent.

## Seeded rules

Migrations `002`/`003` seed: `source_blind`, `device_source_down`,
`device_down` (ping), `config_backup_stale` (>7d), `camera_not_recording`,
`trunk_unregistered`. Each is a row an admin can later edit/disable.
**Collector-stale** (a `collector_health` freshness alert) is a distinct
evaluation path over `collector_health`, not a `device_state` rule — deferred
to a follow-up; `source_blind` covers the "source unreachable" case meanwhile.

## API + UI

- `GET /api/alerts` — open alerts (device, rule, severity, opened/last_seen,
  ack). Viewer.
- `POST /api/alerts/{id}/ack` — operator acks (records `acked_by`/`acked_at`).
- `GET/POST /api/maintenance` — list / create windows. Operator to create.
- **Problems** page (`#/problems`) lists open alerts with an Ack button.

## Comparison report

`scripts/shadow_report.py` summarizes a window of `notifications` (+ opened/
closed alerts) into a readable report the owner diffs against Zabbix during the
parallel run. The Zabbix side is the owner's export (or a later importer); this
produces the NetMon side.

## Config (`[engine]`)

`enabled` (default false — per-step reversibility), `interval_s` (30),
`shadow` (default **true**), `smtp_host`, `smtp_port`, `smtp_from`,
`default_target` (fallback notification address).

## Definition of Done

- [x] Engine runs continuously in shadow as a supervised task (registered when
      `[engine] enabled`).
- [x] `notifications` fills with shadow rows; dedupe + min_duration + close
      verified by tests.
- [x] Maintenance windows suppress notifications (not recording) — tested.
- [x] Ack API + Problems page (with Ack button); maintenance API.
- [x] Rule-evaluation + engine-lifecycle unit tests green (67 total).
- [x] `scripts/shadow_report.py` produces a readable summary.
- [ ] Real SMTP send path exercised at cutover (Phase 8); collector-stale rule
      (over `collector_health`) is a deferred follow-up.

## Next / deferred

- Collector-stale rule over `collector_health`. Real SMTP send path exercised
  at cutover (Phase 8). 3CX/rConfig dimensions (`trunk`, `config_backup`) go
  live with Phase 7.
