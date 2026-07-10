# Spec 01 — Foundation (Phase 1)

**Goal:** stand up the `netmon` package skeleton everything else hangs off:
config + secrets layout, DB layer + schema migration for the full data model,
FastAPI app with AD auth / sessions / roles / `/healthz` / `/docs`, the
supervised-task scaffold the collectors and poller will plug into, and a
one-shot device-registry seed from XIQ + PacketFence exports.

No live source polling happens in this phase — collectors are Phase 3+. What
Phase 1 proves is that the *frame* is correct and reversible.

## Deliverables

1. **Package scaffold** (`pyproject.toml`, `netmon/` per CLAUDE.md §5).
2. **Config loader** (`netmon/config.py`) — reads `/etc/netmon/netmon.conf`
   (override via `NETMON_CONF`), validates required keys, fails loud on missing
   secrets. Repo carries `netmon.conf.example` only.
3. **DB layer** (`netmon/db.py`) — SQLAlchemy Core engine from the config URL,
   small query helpers. No ORM.
4. **Migration 001** (`migrations/001_init.sql`) — the eight tables of
   CLAUDE.md §6, each migration carrying a `-- rollback:` note. Applied by the
   runner (`netmon/migrate.py`, also `python -m netmon.migrate`).
5. **FastAPI app** (`netmon/app.py`) — app factory + lifespan that starts the
   task supervisor; routers for health, auth, devices; AD auth via `ldap3`
   with group→role mapping; server-side session cookies; role-gated deps.
6. **Task supervisor** (`netmon/supervisor.py`) — registers named async tasks,
   each wrapped in an interval loop + timeout + exception boundary +
   reschedule. Phase 1 ships it empty (no collectors registered) but exercised
   by a heartbeat self-task.
7. **Device seed** (`scripts/seed_devices.py`, `python -m netmon.seed`) —
   parses XIQ + PF fixtures/exports into reconciled `devices` rows per the
   spec-00 rules and upserts them.
8. **Tests** (`tests/`) — config validation, Pydantic models, seed
   reconciliation, migration integrity, `/healthz`. `pytest` green.
9. **Runbook** (`docs/runbooks/deploy.md`).

## Data model (built by `001_init.sql`)

Exactly CLAUDE.md §6: `devices`, `device_state`, `state_events`,
`alert_rules`, `alerts`, `notifications`, `maintenance_windows`,
`collector_health`. Invariants: `device_state` = "what is true now",
`state_events` = append-only "what changed when", a blind source is a *state*
(`source_status = blind`) and must never render as healthy.

## Roles & auth

- AD bind via `ldap3` (`config [auth]`). Group DN → role mapping in config.
- Roles: `viewer` < `operator` < `admin`. `require_role(min_role)` dependency.
- Server-side sessions: opaque cookie → in-memory session store (Phase 1);
  a DB/Redis-backed store is a later hardening item. Cookie is `HttpOnly`,
  `SameSite=Lax`, `Secure` when `[web] secure_cookies=true`.
- A `[auth] dev_bypass_user`/`dev_bypass_role` pair allows local development
  without an AD server; it is refused when `[web] secure_cookies=true` so it
  can never be left on in production.

## Execution model

`app.py` lifespan builds the DB engine, runs pending migrations (opt-in via
`[db] auto_migrate`), and starts the supervisor. Every future collector/poller
task registers with the supervisor **and** is runnable standalone
(`python -m netmon.collectors.xiq --once|--loop`) — the contract lives in
`collectors/base.py`.

## Dependency notes / open items

- **MariaDB driver:** SQLAlchemy needs a DBAPI for the `mysql+pymysql://` URL.
  `pymysql` is **not** in CLAUDE.md §3's allowed list, so it is flagged for
  owner approval rather than silently added. Dev/test uses `sqlite://`, which
  needs no extra driver; the DB layer is URL-driven so the prod driver is a
  config + one-line dependency decision. **← owner decision needed.**
- The migration SQL is MariaDB-flavored (`ENGINE=InnoDB`, `AUTO_INCREMENT`).
  Tests assert its integrity textually rather than executing it against
  MariaDB; the app applies it live against the configured MariaDB.

## Definition of Done

- [x] Package scaffold per §5.
- [x] `001_init.sql` implements §6 with rollback notes; runner applies it.
- [x] Config loader + validation; `netmon.conf.example` present.
- [x] FastAPI skeleton: AD auth, sessions, roles, `/healthz`, `/docs`.
- [x] Task-supervisor scaffold in lifespan (heartbeat self-task).
- [x] One-shot seed populates `devices` from XIQ + PF fixtures.
- [x] `pytest` green.
- [x] `docs/runbooks/deploy.md` written.
- [ ] **Owner-side:** app boots against real MariaDB + AD (needs driver
      decision + on-network AD). Verified during deploy, not in this session.

## Next session

- Resolve the MariaDB driver dependency question, then wire a live boot test.
- Phase 2 (native poller) — first real supervisor task; begins with
  `docs/spec/02-poller.md`.
- Consider promoting the in-memory session store to a DB-backed table before
  multi-worker uvicorn deployment (sessions won't share across workers).
