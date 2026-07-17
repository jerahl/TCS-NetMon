# Spec 12 — Settings engine (web-editable configuration)

**Status:** in progress (this session)
**Owner ask (2026-07-15):** "a settings module/engine … allow an admin to change all
settings in the web interface. It should be able to update any API keys or
passwords, but not view them in the web."

---

## 1. Goal

Admins manage NetMon's operational configuration from a Settings page instead
of editing `/etc/netmon/netmon.conf` over SSH: collector enable/poll cadence,
alert-engine/SMTP settings, SAML mapping, source URLs — and source credentials
(API tokens, passwords, SNMP community), which are **write-only**: they can be
set or replaced from the web but are never displayed or returned by any API.

## 2. Design decisions

| # | Decision | Rationale |
|---|---|---|
| S1 | **Overlay, not replacement.** `netmon.conf` stays the bootstrap source of truth. A new `app_settings` table stores per-key admin overrides. Effective value = DB override → conf file → code default. | The app must boot with no DB and no overrides; the conf file keeps working unchanged; every override is individually revertible ("reset to file/default"). |
| S2 | **Bootstrap & recovery keys are file-only** and never appear in the web registry: `[db]` (url, auto_migrate), `[web]` host/port/secure_cookies, the break-glass local account, the dev bypass, the `[security]` section itself, and executable paths (`fping_path`, `snmpget_path`, `snmpbulkwalk_path`). | A bad web edit must never brick boot, lock the owner out (break-glass always works from the file), or point a subprocess at an attacker-chosen binary. `[zabbix]` is script-only and also excluded. |
| S3 | **Secrets are write-only.** `GET` returns only `is_set` + provenance; `PUT` sets, `DELETE` clears the override. No endpoint ever returns a secret value. | The owner ask, verbatim. |
| S4 | **Secrets are sealed at rest** with a stdlib construction (`netmon/secretbox.py`): HMAC-SHA256 in counter mode as a PRF keystream + encrypt-then-MAC, random 16-byte nonce, keys derived from `[security] settings_key` in the conf file. Token format `nmsb1:<nonce>:<ct>:<tag>`. | The dependency policy (CLAUDE.md §3) forbids adding `cryptography`/`pynacl`; plaintext secrets in DB dumps/backups is worse. The key lives only in the root-protected conf file, so a DB copy alone does not reveal secrets. Used for `app_settings` only — not a general crypto facility. |
| S5 | **Web editing is a conf-gated capability**: `[security] allow_web_edit` (default **false**). `GET` (read, secrets masked) works for any admin; `PUT`/`DELETE`/apply return 403 with a pointed message until the owner flips the flag. Secret writes additionally require `settings_key` to be set (409 otherwise). | Per-step reversibility (§4.3): one file switch kills the whole web write path. Default-off matches the project's shipping posture. |
| S6 | **Every change is audited** in `settings_audit` (key, set/clear, old→new, who, when). For secret keys old/new are stored as NULL — the audit shows *that* it changed, never *what*. | §4 conventions; secrets never land in logs or tables in the clear. |
| S7 | **Apply without SSH:** `POST /api/settings/apply` rebuilds the overlaid config, swaps `app.state.config`, and restarts the supervised tasks (poller/sweeps/collectors/engine) under a fresh supervisor. Keys marked `restart` (currently only `web.session_ttl`) still need a service restart and are reported as such. | Collectors/poller/engine are constructed from config at task registration; SAML/auth reads `app.state.config` per request so it goes live on swap. Supervisor stats reset on apply (visible on NetMon Status) — acceptable and honest. |
| S8 | Overlay application is **fail-soft**: an override that no longer parses/decrypts (e.g. `settings_key` rotated) logs loud, is skipped (file value wins), and is badged as an error in `GET /api/settings`. `PUT`-time validation makes this unreachable in normal use. | A bad row must never prevent boot — that would turn a web edit into an outage (violates the S2 guarantee). Fail loud ≠ fail dead. |
| S9 | Standalone collector runs (`python -m netmon.collectors.x --once`) apply the same overlay after loading the file config. | The escape hatch must see the same effective config as the supervisor, or debugging lies. |

## 3. Data model (migration 008)

```
app_settings    `key` VARCHAR(128) PK · value TEXT NULL · is_secret TINYINT
                · updated_by · updated_at
settings_audit  id PK · `key` · action ENUM('set','clear') · old_value TEXT NULL
                · new_value TEXT NULL · changed_by · changed_at
```

`value` is the canonical string form (`"true"/"false"`, `"300"`, raw string) or
a sealed `nmsb1:` token for secrets. `settings_audit` is append-only.

## 4. Registry

`netmon/settings.py` owns a typed registry (`SettingDef`: key, kind
str/int/bool/secret, default, label, description, bounds, restart flag). Keys
mirror the INI layout: `poller.ping_interval_s`, `xiq.api_token`,
`engine.shadow`, `auth.saml_role_admin`, … Sections: web (session TTL), auth
(SAML IdP/SP + role/group mapping; SP key is a secret), poller (incl.
`snmp_community` secret), snmp_inventory, engine (incl. `shadow` — flipping it
off starts real email and is called out in the UI), and the five sources
(enabled, URLs, intervals, credentials as secrets).

The registry — not the DB — defines what is editable; an unknown key is a 404.
Typed sections overlay onto the frozen config dataclasses via
`dataclasses.replace`; source sections overlay onto the raw
`SourceToggle.settings` dict (decrypted secrets are injected in-memory only).

## 5. API (`netmon/api/settings.py`, all admin-gated)

| Route | Behavior |
|---|---|
| `GET /api/settings` | Groups of settings with effective value (secrets: `value=null`, `is_set`), provenance `source ∈ default·file·override`, `restart`, validation `error` badge, plus `edit_enabled` / `secrets_enabled` capability flags. |
| `PUT /api/settings/{key}` | Validate by kind/bounds, seal secrets, upsert override, audit. |
| `DELETE /api/settings/{key}` | Remove override (revert to file/default), audit. |
| `GET /api/settings/audit` | Recent audit rows (secrets redacted at write time). |
| `POST /api/settings/apply` | Overlay → swap `app.state.config` → restart supervised tasks. Serialized by an asyncio lock. Returns started task names + keys still needing full restart. |

## 6. UI

`#/settings`, admin-only nav entry (nav learns the role from `/auth/me`).
Grouped cards; per-row typed inputs (bool select, number, text); dirty rows get
Save/Discard; every overridden row shows an "override" badge + "Reset to file"
action. Secrets render as a password field with "(set — hidden)" placeholder
and Set/Replace + Clear buttons — the current value is never fetched. Page
header: Apply changes button (with supervisor-restart explanation), read-only
banner when `allow_web_edit=false`, and the audit trail table.

## 7. Testing

- `tests/test_settings.py` — secretbox roundtrip/tamper/wrong-key; registry
  invariants (unique keys, S2 exclusions, secrets flagged); pure overlay
  precedence incl. source-credential injection and fail-soft bad rows;
  validation bounds.
- `tests/test_settings_api.py` — role gating; edit-flag gating; masked GET;
  PUT/DELETE with audit; sealed-at-rest assertion against the raw table; apply
  swaps config + supervisor.
- `tests/test_migrations.py` — 008 tables + rollback note.

## 8. Rollback

Config: remove `[security] allow_web_edit` (or set false) — the write path is
gone, reads keep working. Full: revert the code, then migration 008 rollback
note (export `settings_audit` first if the history matters).

## 9. Checklist

- [x] Spec (this file)
- [x] `[security]` config section (settings_key, allow_web_edit)
- [x] `netmon/secretbox.py` + tests
- [x] `netmon/settings.py` registry + overlay + validation + tests
- [x] Migration `008_app_settings.sql` (+ conftest DDL, migration tests)
- [x] API router + app wiring (overlay in lifespan, apply lock) + tests
- [x] Standalone-run overlay (`collectors/base.py`)
- [x] Frontend: Settings page, admin nav section, api.js PUT/DELETE helpers
- [x] `netmon.conf.example` + runbook `docs/runbooks/settings.md`

## Next session

- Owner: generate `settings_key`, decide when to flip `allow_web_edit=true`.
- Consider surfacing "override differs from file" drift on NetMon Status.
- `wireless_clients`-era settings (10.2+) get registry entries in their phases.
