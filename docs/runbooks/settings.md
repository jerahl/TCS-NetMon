# Runbook — Web settings (settings engine)

Spec: `docs/spec/12-settings-engine.md`. Page: `#/settings` (admins only).

## How it works (30 seconds)

Effective value of every managed setting = **DB override → netmon.conf → code
default**. Overrides live in the `app_settings` table (migration 008) and are
edited from the Settings page. `netmon.conf` is never rewritten. Secrets (API
tokens, passwords, SNMP community, SAML SP key) are **write-only**: they can be
set/replaced/cleared in the UI but no API ever returns one; at rest they are
sealed with the key below. Every change lands in `settings_audit`
(secret values redacted at write time).

## Enabling (one-time)

1. Apply migration 008: `netmon-migrate` (or `[db] auto_migrate = true`).
2. Add to `/etc/netmon/netmon.conf` (file-only section — not web-editable):

   ```ini
   [security]
   settings_key = <python -c "import secrets; print(secrets.token_hex(32))">
   allow_web_edit = true
   ```

3. Restart the service. Without `allow_web_edit` the page is read-only;
   without `settings_key` non-secret editing works but secret writes 409.

## Applying changes

- **Save** on a row stores the override (audited). It takes effect on the next
  service restart, or immediately via **Apply changes**, which swaps the
  in-memory config and restarts the supervised tasks (poller, sweeps,
  collectors, engine) in place. Supervisor run/failure counters on NetMon
  Status reset on apply — expected.
- Rows flagged "needs service restart" (currently `web.session_ttl`) ignore
  Apply; restart the service.
- **Reset to file** deletes the override; the conf/default value returns.

## What is deliberately NOT web-editable

`[db]` (URL, auto_migrate), web bind host/port, `secure_cookies`, the
break-glass local account, the dev bypass, the `[security]` section, and the
`fping`/`snmpget`/`snmpbulkwalk` executable paths. Rationale (spec 12 S2): a
web edit must never brick boot, lock you out (break-glass always works from
the file), or repoint a subprocess binary. Edit those in `netmon.conf` + restart.

## Recovery

- **Bad edit broke a collector**: Settings page → Reset to file → Apply. Or
  SQL: `DELETE FROM app_settings WHERE `key` = '...';` and restart.
- **Locked out of SSO by a bad SAML edit**: sign in with the break-glass local
  account (file-only), fix the override, Apply.
- **Rotated/lost `settings_key`**: stored secret overrides fail decryption —
  they are *skipped loudly* (file values take effect; rows badge as `error`).
  Re-enter each secret in the UI to reseal under the new key.
- **Kill the whole feature**: set `allow_web_edit = false` (or drop the
  section) and restart — overrides already in the DB still apply; delete rows
  from `app_settings` to shed them.

## Audit

`GET /api/settings/audit` or the table at the bottom of the page: who changed
what, when, old → new. For secrets only the fact of the change is recorded.
