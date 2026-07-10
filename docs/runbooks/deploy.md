# Runbook — Deploy (Phase 1 foundation)

Covers standing up the `netmon` FastAPI app + DB schema on the dedicated VM.
Collectors/poller/engine are not deployed yet (later phases); this brings up
the frame: config, database, auth, and the API with `/docs`.

## 0. Prerequisites

- Python 3.12 on the VM, a service user `netmon`, and MariaDB reachable.
- An AD service path for `ldap3` binds (read-only) and the three role groups
  created (`NetMon-Viewers`, `NetMon-Operators`, `NetMon-Admins`).
- **Open decision (blocks live MariaDB):** the MariaDB DBAPI driver is not yet
  in the approved dependency list (CLAUDE.md §3). Pick a driver (e.g.
  `pymysql`), get owner sign-off, add it to `pyproject.toml`, and use a
  `mysql+pymysql://` URL. Until then the app only runs against SQLite.

## 1. Install

```bash
sudo -u netmon python3.12 -m venv /opt/netmon/venv
sudo -u netmon /opt/netmon/venv/bin/pip install /opt/netmon/src   # the repo
# plus the approved MariaDB driver once decided, e.g.:
# sudo -u netmon /opt/netmon/venv/bin/pip install pymysql==<pin>
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

Export XIQ (`GET /devices?views=BASIC`) and PacketFence (`nodes/search`) to
JSON, then:

```bash
# Preview reconciliation (writes nothing):
/opt/netmon/venv/bin/python -m netmon.seed --xiq xiq.json --pf pf.json --dry-run
# Apply:
sudo -u netmon NETMON_CONF=/etc/netmon/netmon.conf \
  /opt/netmon/venv/bin/python -m netmon.seed --xiq xiq.json --pf pf.json
```

Rows with `site=unknown` did not match the `<SITE>-…` hostname convention —
review them (spec-00 reconciliation rules).

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
