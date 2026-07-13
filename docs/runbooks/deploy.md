# Runbook — Deploy (Phase 1 foundation)

Covers standing up the `netmon` FastAPI app + DB schema on the dedicated VM.
Collectors/poller/engine are not deployed yet (later phases); this brings up
the frame: config, database, auth, and the API with `/docs`.

## Automated deploy/update — `scripts/deploy.sh`

`scripts/deploy.sh` automates everything in this runbook and hardens the host.
It is idempotent — safe to re-run — and never writes a secret into the repo.

```bash
# Clone to a NON-home path (the hardened unit sets ProtectHome=yes):
sudo git clone <repo-url> /opt/netmon/src
cd /opt/netmon/src

sudo ./scripts/deploy.sh install --dry-run   # preview every action, change nothing
sudo ./scripts/deploy.sh install             # full setup + hardening
# ...edit /etc/netmon/netmon.conf (DB url + AD), then:
sudo ./scripts/deploy.sh update              # pull, reinstall, migrate, restart, health-check

sudo ./scripts/deploy.sh status              # service + /healthz
sudo ./scripts/deploy.sh secure              # re-apply hardening only
```

Provide a CA-issued certificate (otherwise a self-signed placeholder is
generated):

```bash
SERVER_NAME=netmon.tcs.local \
NETMON_TLS_CERT=/etc/ssl/certs/netmon.crt NETMON_TLS_KEY=/etc/ssl/private/netmon.key \
  sudo -E ./scripts/deploy.sh install
```

**What `install` does:** installs packages (python, nginx, openssl, `fping`/
`snmp` for the Phase 2 poller, firewall); creates the locked `netmon` system
user (no login shell); lays out `/opt/netmon` (root-owned app + venv),
`/etc/netmon` (`0640` config), `/var/lib/netmon` (state), `/var/log/netmon`;
builds the venv and installs this repo; creates `/etc/netmon/netmon.conf` from
the example (never overwriting an existing one) with `secure_cookies=true`;
runs migrations; installs a **sandboxed** systemd unit; configures an **nginx
TLS reverse proxy** (HTTP→HTTPS redirect, HSTS + security headers); and sets a
**host firewall** (SSH + HTTPS only).

**Security posture applied:**
- App listens on `127.0.0.1:8080` only — never exposed; nginx terminates TLS.
- systemd sandbox: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`,
  `PrivateTmp`, empty `CapabilityBoundingSet`, `SystemCallFilter=@system-service`,
  `MemoryDenyWriteExecute`, writable paths limited to state + logs.
- Config `0640 root:netmon`; TLS key `0600 root:root`; secrets stay in
  `/etc/netmon/`, never in the repo.
- Firewall default-deny inbound except SSH (`SSH_PORT`, default 22) and 80/443.
- Single uvicorn worker (the Phase 1 session store is in-process; see §5).
- **Phase 2 note:** the poller shells out to `fping`, which needs raw sockets.
  The unit comments where to grant `CAP_NET_RAW` (or split the poller into its
  own unit) when that phase lands.

Knobs (env vars): `SERVER_NAME`, `NETMON_TLS_CERT`/`NETMON_TLS_KEY`, `BIND_PORT`,
`SSH_PORT`, `ENABLE_FIREWALL`, `ENABLE_FAIL2BAN`, `APP_SRC`. The manual steps
below document what the script does under the hood.

## 0. Prerequisites

- Python 3.12 on the VM, a service user `netmon`, and MariaDB reachable.
- An AD service path for `ldap3` binds (read-only) and the three role groups
  created (`NetMon-Viewers`, `NetMon-Operators`, `NetMon-Admins`).
- MariaDB driver: `pymysql` ships in `pyproject.toml` (owner-approved). Use a
  `mysql+pymysql://user:pass@host/netmon?charset=utf8mb4` URL. No system
  packages needed — PyMySQL is pure-Python.

## 1. Install

```bash
sudo -u netmon python3.12 -m venv /opt/netmon/venv
sudo -u netmon /opt/netmon/venv/bin/pip install /opt/netmon/src   # the repo
# The MariaDB driver (pymysql) installs automatically as a pinned dependency.
```

## 2. Configure

Secrets live only in `/etc/netmon/netmon.conf` (root-readable, `0640`, owned by
`netmon`), never in the repo (CLAUDE.md §4.6). Start from the example:

```bash
sudo install -o netmon -g netmon -m 0640 netmon.conf.example /etc/netmon/netmon.conf
sudoedit /etc/netmon/netmon.conf     # set [db] url, [auth] ldap_server/base_dn/groups
```

Validate the config loads before starting the service:

```bash
sudo -u netmon NETMON_CONF=/etc/netmon/netmon.conf \
  /opt/netmon/venv/bin/python -c "from netmon.config import load_config; load_config(); print('config OK')"
```

A missing secret or the dev bypass left on under `secure_cookies=true` fails
loud here — fix it before proceeding.

## 3. Migrate the database

```bash
sudo -u netmon NETMON_CONF=/etc/netmon/netmon.conf \
  /opt/netmon/venv/bin/python -m netmon.migrate --status     # show pending
sudo -u netmon NETMON_CONF=/etc/netmon/netmon.conf \
  /opt/netmon/venv/bin/python -m netmon.migrate              # apply
```

Migrations are numbered SQL files applied once and tracked in
`schema_migrations`. **Rollback:** each file carries a `-- rollback:` note;
`001_init.sql` rolls back by dropping the eight tables in reverse dependency
order and deleting its `schema_migrations` row (safe — no data at 001).

`[db] auto_migrate=true` applies pending migrations on app startup; leave it
**false** in production and migrate deliberately during a change window.

## 4. Seed the device registry

Export three inputs to JSON: XIQ (`GET /devices?views=BASIC`), PacketFence
(`nodes/search`), and the Zabbix `Site/` host groups
(`host.get` + `selectHostGroups`) that assign each device's site. Then:

```bash
# Preview reconciliation (writes nothing):
/opt/netmon/venv/bin/python -m netmon.seed \
  --xiq xiq.json --pf pf.json --sites zbx_sites.json --dry-run
# Apply:
sudo -u netmon NETMON_CONF=/etc/netmon/netmon.conf \
  /opt/netmon/venv/bin/python -m netmon.seed \
  --xiq xiq.json --pf pf.json --sites zbx_sites.json
```

Rows with `site=Unassigned` are in no `Site/<name>` group in the export
(or aren't monitored by Zabbix) — review them (spec-00 reconciliation rules).
Omitting `--sites` seeds every device as `Unassigned`.

## 5. Run the app

Behind nginx (TLS) with a systemd unit; `secure_cookies=true` in production.

```bash
NETMON_CONF=/etc/netmon/netmon.conf \
  /opt/netmon/venv/bin/uvicorn netmon.app:create_app --factory \
  --host 127.0.0.1 --port 8080
```

> Multi-worker note: the Phase 1 session store is in-process, so sessions are
> not shared across `--workers > 1`. Run a single worker until the store is
> promoted to a shared backend (tracked in spec-01 "Next session").

## 6. Verify

```bash
curl -s http://127.0.0.1:8080/healthz         # {"status":"ok","db_ok":true,...}
# /docs renders the OpenAPI UI; log in via POST /auth/login, then GET /api/devices.
```

## 7. Rollback (whole deploy)

Stop the service; the code has no destructive side effects. To undo the schema,
apply the per-migration `-- rollback:` notes newest-first. Config and secrets
live outside the repo and are untouched by a code rollback.

## Troubleshooting

- **`config file not found`** — set `NETMON_CONF` or create
  `/etc/netmon/netmon.conf`.
- **`dev_bypass_user is set while secure_cookies=true`** — the dev auth bypass
  is refused in production; remove it.
- **`ldap_server is required`** — set it, or (dev only) use the bypass with
  `secure_cookies=false`.
- **`/healthz` shows `db_ok:false`** — DB unreachable or unmigrated; the
  process still answers (fail loud, not silent). Check the `[db] url` and that
  migrations ran.
