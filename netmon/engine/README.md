# Alert engine

Evaluates `alert_rules` against `device_state`, dedupes into open `alerts`, and
records `notifications`. Ships in **shadow mode** (logs would-be notifications,
sends nothing). Spec: `docs/spec/06-engine.md`.

## Cycle (`engine.py`, supervised task `engine`)

1. Load enabled rules.
2. Match each rule's `condition` (pure `rules.evaluate`, ops `eq`/`ne`/`in`/
   `contains`, fail-closed) against `device_state` for its dimension.
3. **Duration gate:** fire only after the state has held `min_duration_s`
   (held-since = latest `state_events.occurred_at` for the device+dimension).
4. **Dedupe:** one open alert per (device, rule) — open / bump `last_seen_at` /
   close on resolve. Portable SQL (SQLite + MariaDB).
5. **Notify** a newly-opened alert → `notifications`. Maintenance windows
   suppress the notification, not the alert.

## Notifier (`notify.py`)

`[engine] shadow=true` (default): rows written with `shadow=1`, nothing sent.
`shadow=false` (owner, at cutover) emails via `[engine] smtp_*`. Maintenance-
suppressed notifications are recorded (noted) and never sent.

## API / UI

- `GET /api/alerts` (viewer), `POST /api/alerts/{id}/ack` (operator).
- `GET/POST /api/maintenance` (operator to create).
- Problems page (`#/problems`) with an Ack button.

## Report

`python scripts/shadow_report.py --days 7` — NetMon-side summary of shadow
notifications + opened/closed alerts for the parallel-run diff against Zabbix.

## Config (`[engine]`)

`enabled` (default false), `interval_s` (30), `shadow` (default true),
`smtp_host`, `smtp_port`, `smtp_from`, `default_target`.

## Seeded rules

`source_blind`, `device_source_down` (002); `device_down`,
`config_backup_stale`, `camera_not_recording`, `trunk_unregistered` (003).
Collector-staleness (over `collector_health`) is a deferred follow-up.
