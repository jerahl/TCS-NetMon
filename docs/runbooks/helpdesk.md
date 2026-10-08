# Runbook — Frontline Help Desk integration (spec 25)

## Enable

1. **Credentials** — Asset Management › Management › District Settings › API
   and SSO Information. Edit `/etc/netmon/netmon.env` (root:netmon 0640):
   ```
   HD_API_KEY=<secret key>
   HD_API_PASSPHRASE=<passphrase>
   ```
   The drop-in `/etc/systemd/system/netmon.service.d/env.conf` loads it
   (`EnvironmentFile=-/etc/netmon/netmon.env`). Never put these in
   netmon.conf — NetMon refuses to start if you do.

2. **Probe** (read-only; prints key names and counts, never ticket content):
   ```
   cd /usr/share/TCS-NetMon
   sudo bash -c 'set -a; . /etc/netmon/netmon.env; set +a; \
     /opt/netmon/venv/bin/python scripts/helpdesk_probe.py --user-id <FRONTLINE_USER_ID>'
   ```
   Fix anything marked ✗/? before enabling (spec 25 §10).

3. **Migrate** (038): `sudo -u netmon /opt/netmon/venv/bin/netmon-migrate`
   (auto_migrate is off on the VM).

4. **Configure** `/etc/netmon/netmon.conf`:
   ```
   [helpdesk]
   enabled = true
   scope_user_id = <FRONTLINE_USER_ID>
   ```
   Then `sudo systemctl restart netmon`.

5. **Check**: Helpdesk › Tickets loads; the nav "helpdesk" source pill is
   green; link a test ticket to a test issue and unlink it.

## Disable

`[helpdesk] enabled = false` + restart. Links stay readable on Problems,
Issues and Changes; ticket pages say the integration is off.

## Rotate credentials

Edit `/etc/netmon/netmon.env`, `sudo systemctl restart netmon`. The access
token is in memory only, so a restart is the whole rotation.

## Symptoms

| Symptom | Meaning | Action |
|---|---|---|
| "credentials are not set" banner | env vars missing in the service | check the drop-in and file perms; `systemctl show netmon -p EnvironmentFiles` |
| "login refused (HTTP 401/403)" | key/passphrase wrong or revoked | re-issue in Frontline; update netmon.env |
| "retrying in Ns" | outage backoff (15 s → 10 min) | wait, or restart to clear; check Frontline status |
| "route unknown to this help desk build" | HTTP 444 — Frontline changed a route | re-run the probe; update `netmon/helpdesk.py` |
| link shows "no such ticket" | help desk answered 404 (deleted or out of scope) | the link is kept; unlink if it is wrong |
| link shows "refused access" | help desk answered 403 | scope_user_id cannot see it |
