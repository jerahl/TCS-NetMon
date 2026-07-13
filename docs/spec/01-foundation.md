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
   task supervisor; routers for health, auth, devices; SSO auth (SAML SP,
   ClassLink IdP) with assertion→role mapping; server-side session cookies;
   role-gated deps.
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

## Roles & auth — SSO via ClassLink (SAML)

**Plan adjustment (2026-07-13):** login is single sign-on. NetMon is a **SAML
2.0 Service Provider**; **ClassLink** is the identity provider (it federates
the district directory). NetMon does **not** handle passwords and does **not**
bind AD directly.

Target flow:

1. Unauthenticated request to a gated route → redirect to ClassLink (SP-initiated
   SSO), or ClassLink app-launch (IdP-initiated) posts to NetMon's ACS endpoint.
2. NetMon validates the signed SAML assertion (signature against the IdP's
   metadata certificate, `Audience`/`Destination`/`NotOnOrAfter`, replay
   protection) at `POST /auth/saml/acs`.
3. Attribute → role mapping: ClassLink role/group claims map to
   `viewer` < `operator` < `admin` (config, same precedence rule as today —
   highest granted role wins). A user with no mapped claim is denied.
4. On success NetMon issues its own server-side session cookie (unchanged from
   the interim design: opaque cookie → session store; `HttpOnly`, `SameSite=Lax`,
   `Secure` when `[web] secure_cookies=true`). SLO/logout clears the session.

Endpoints to add: `GET /auth/saml/login` (SP-initiated redirect),
`POST /auth/saml/acs` (assertion consumer), `GET /auth/saml/metadata` (SP
metadata for ClassLink), logout. `require_role(min_role)` and the session
store are unchanged.

Config (`[auth]`, replacing the LDAP keys): IdP metadata URL/entity-id + signing
cert, SP entity-id + ACS URL, SP signing key/cert (secrets on disk only), and
the attribute→role claim map.

The `[auth] dev_bypass_user`/`dev_bypass_role` pair still allows local
development without an IdP; it is refused when `[web] secure_cookies=true` so
it can never be left on in production.

**Current code status:** Phase 1 shipped an *interim* `ldap3` username/password
login (`netmon/auth/ldap.py`, `POST /auth/login`) before this decision. It is a
placeholder to be replaced by the SAML SP above; the session store, roles, and
`require_role` gate it fed into are reused unchanged. See "Next session".

**Open decisions (resolve before implementing — do not guess):**
- SAML SP library + pin (e.g. `python3-saml`, which needs `xmlsec1`/`libxml2`
  system libs — weigh against the §9 offline-deploy goal — vs. a pure-Python
  option). New dependency ⇒ owner approval (§3).
- Exact ClassLink attribute names carrying role/group; whether any directory
  lookup is still needed (if so, `ldap3` stays; otherwise it is retired).
- SP signing/encryption cert management and rotation.

## Execution model

`app.py` lifespan builds the DB engine, runs pending migrations (opt-in via
`[db] auto_migrate`), and starts the supervisor. Every future collector/poller
task registers with the supervisor **and** is runnable standalone
(`python -m netmon.collectors.xiq --once|--loop`) — the contract lives in
`collectors/base.py`.

## Dependency notes / open items

- **MariaDB driver:** RESOLVED — `pymysql==1.1.1` is owner-approved (2026-07-11)
  and pinned in `pyproject.toml` / CLAUDE.md §3. Production uses
  `mysql+pymysql://…?charset=utf8mb4`; dev/test uses `sqlite://` (stdlib, no
  extra driver). The DB layer is URL-driven, so the two share one code path.
  PyMySQL is pure-Python (no C build / system libs), which suits the
  offline-tolerant deploy.
- The migration SQL is MariaDB-flavored (`ENGINE=InnoDB`, `AUTO_INCREMENT`).
  Tests assert its integrity textually rather than executing it against
  MariaDB; the app applies it live against the configured MariaDB.

## Definition of Done

- [x] Package scaffold per §5.
- [x] `001_init.sql` implements §6 with rollback notes; runner applies it.
- [x] Config loader + validation; `netmon.conf.example` present.
- [x] FastAPI skeleton: sessions, roles, `/healthz`, `/docs`.
- [~] Auth: interim `ldap3` login shipped; **SAML SP (ClassLink) is the target**
      and is not yet implemented (plan adjustment 2026-07-13).
- [x] Task-supervisor scaffold in lifespan (heartbeat self-task).
- [x] One-shot seed populates `devices` from XIQ + PF fixtures.
- [x] `pytest` green.
- [x] `docs/runbooks/deploy.md` written.
- [x] MariaDB driver decision resolved (`pymysql`, owner-approved).
- [ ] **Owner-side:** app boots against real MariaDB (on-network).
      Verified during deploy, not in this session.

## Next session

- **Rework auth to SAML SSO (ClassLink)** per the "Roles & auth" section: pick
  + get approval for the SAML SP library, add the `[auth]` SAML config, build
  the `/auth/saml/{login,acs,metadata}` endpoints and the attribute→role map,
  and replace the interim `ldap3` login (reusing the session store + role gate).
  Retire `ldap3` if assertions carry the role claims.
- Phase 2 (native poller) — first real supervisor task; begins with
  `docs/spec/02-poller.md`.
- Consider promoting the in-memory session store to a DB-backed table before
  multi-worker uvicorn deployment (sessions won't share across workers).
