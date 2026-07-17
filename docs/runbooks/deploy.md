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
# ...edit /etc/netmon/netmon.conf (DB url + ClassLink SAML), then:
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
- Firewall default-deny inbound except SSH (`SSH_PORT`, default 22) and 80/443,
  plus **SNMP for the poller/sweeps** (`OPEN_SNMP=1`, default): UDP/161 out and
  the switches' replies (UDP source-port 161) in. **Scope the reply rule** with
  `SNMP_SOURCE_CIDR="10.20.0.0/16,10.21.0.0/16"` (comma-separated management
  networks) — left empty it admits source-port-161 UDP from anywhere and the
  script warns. Symptom when missing: every switch reads "no response/timeout"
  in the sweep while `snmpbulkwalk` from another host works.
- Single uvicorn worker is still the default; multi-worker is safe once
  migration `007` (DB-backed sessions) is applied — see §5.
- **Phase 2 note:** the poller shells out to `fping`, which needs raw sockets.
  The unit comments where to grant `CAP_NET_RAW` (or split the poller into its
  own unit) when that phase lands.

Knobs (env vars): `SERVER_NAME`, `NETMON_TLS_CERT`/`NETMON_TLS_KEY`, `BIND_PORT`,
`SSH_PORT`, `ENABLE_FIREWALL`, `ENABLE_FAIL2BAN`, `APP_SRC`. The manual steps
below document what the script does under the hood.

## Database setup — `scripts/setup_db.sh`

`deploy.sh` assumes the MariaDB database + user already exist. Create them once
with `scripts/setup_db.sh` (idempotent, least-privilege, no passwords on the
command line):

```bash
# Local MariaDB (root via unix_socket), write the URL straight into the conf:
sudo ./scripts/setup_db.sh --write-config

# Remote MariaDB; prompts for the admin password, app connects from a subnet:
DB_HOST=db.internal ADMIN_USER=admin DB_USER_HOST='10.10.%' \
  ./scripts/setup_db.sh

./scripts/setup_db.sh --dry-run     # print the SQL, run nothing
```

It creates the `netmon` schema (utf8mb4) and the `netmon` app user with
privileges scoped to `netmon.*` only (DML + the DDL migrations need). The app
password is generated if you don't pass `DB_PASSWORD`; with `--write-config`
the resulting `mysql+pymysql://…` URL (password percent-encoded) is written
into `/etc/netmon/netmon.conf`, otherwise it is printed once for you to paste.
`--dml-only` makes a runtime user with no schema-change rights (migrate
separately as an admin). Run it on the DB host for local socket auth, or from
anywhere with `DB_HOST`/`ADMIN_USER` set. Then `sudo ./scripts/deploy.sh update`.

## 0. Prerequisites

- Python 3.11+ on the VM (3.12 preferred; Debian 12 ships 3.11 and is
  supported), a service user `netmon`, and MariaDB reachable.
- SSO via **ClassLink (SAML)**: register a NetMon SAML app in the ClassLink
  admin console using NetMon's SP metadata (`https://<host>/auth/saml/metadata`,
  ACS `https://<host>/auth/saml/acs`); put the IdP entity-id / SSO URL /
  signing cert into `[auth]` (`saml_idp_*`), and map the released `role` /
  `group_ids` claims to `viewer`/`operator`/`admin` (`saml_role_*` /
  `saml_group_*`). `xmlsec1`/`libxml2` (installed by the deploy script) back
  `python3-saml`. A dev bypass remains for local, no-IdP development.
- **Break-glass local account** (recommended) so admins can log in when
  ClassLink or the network is down: generate a hash with
  `python -m netmon.auth.local` and set `[auth] local_user` /
  `local_password_hash` / `local_role`. Users land on `/login` (ClassLink +
  local form) when unauthenticated.
- MariaDB driver: `pymysql` ships in `pyproject.toml` (owner-approved). Use a
  `mysql+pymysql://user:pass@host/netmon?charset=utf8mb4` URL. No system
  packages needed — PyMySQL is pure-Python.

## 1. Install

```bash
sudo -u netmon python3 -m venv /opt/netmon/venv   # python3.12 if available, else 3.11
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

**Re-seeding after cutover (no Zabbix — spec 11 D9):** once the registry is
seeded, the DB itself is the durable site source of truth. Refresh the
registry from fresh XIQ/PF exports without any Zabbix export:

```bash
sudo -u netmon NETMON_CONF=/etc/netmon/netmon.conf \
  /opt/netmon/venv/bin/python -m netmon.seed \
  --xiq xiq.json --pf pf.json --sites-from-db
```

Existing devices keep their site; new devices arrive `Unassigned` (assign
them in the DB or pass `--sites` alongside, which overrides per host). The
upsert never re-enables a device an operator disabled and never blanks a
per-source key that a fresh export happens to lack.

**Web registry management (admin, edit-gated):** with `[security]
allow_web_edit = true`, an admin can add/edit/delete sites, **reassign
devices between sites**, **import switches/APs from XIQ** (dry-run preview),
and **edit SNMP status-label maps** (e.g. the Extreme stack member
oper-status decode) from the `#/registry` page, and **edit the site map**
(drag sites, add/edit/delete fiber links and their paths) from the `#/map`
page's EDIT MAP button — no CLI needed. A map site can also be **linked to a
network site/group** whose name differs (Registry → Sites → Network group), so
its marker rolls up that group's devices without a rename. Site/device/link edits write only
NetMon's own `sites`/`devices`/`fiber_links` rows (never a source); enum
overrides live in `snapshot_cache` and are picked up by the next sweep. All of
it is refused when `allow_web_edit` is false. (See
`docs/runbooks/site-map.md` for the map editor.)

**SSH to a device (SSHEASY):** set `[web] ssheasy_url` to the base URL of a
deployed SSHEASY (`jerahl/ssheasy`) web SSH client. An "SSH" button then
appears on switch/AP detail pages for operators/admins, opening
`<ssheasy_url>/terminal?host=<mgmt_ip>&port=22&embed=1` in an embedded iframe
(mirrors the ZCD/Zabbix embed exactly). Credentials are entered in the
terminal — NetMon never stores or forwards them. Set `ssheasy_url` to the full
scheme+host+port SSHEASY is reached at (its container publishes `:8080`, e.g.
`ssheasy_url = http://ssheasy.example.internal:8080`). Two deploy gotchas make
the iframe show "refused to connect":

- **`frame-ancestors`** — SSHEASY's `nginx/nginx.conf` CSP must list NetMon's
  exact origin (scheme + host + port, e.g. `https://netmon.example.internal`),
  then `nginx -s reload`. A bare hostname does not match.
- **Mixed content** — SSHEASY ships HTTP-only. A browser will not embed an
  `http://` iframe inside an `https://` NetMon page; serve SSHEASY over TLS (or
  use the modal's open-in-new-tab escape, which is not subject to framing).

Leave `ssheasy_url` empty to hide the affordance.

## 5. Run the app

Behind nginx (TLS) with a systemd unit; `secure_cookies=true` in production.

```bash
NETMON_CONF=/etc/netmon/netmon.conf \
  /opt/netmon/venv/bin/uvicorn netmon.app:create_app --factory \
  --host 127.0.0.1 --port 8080
```

> Multi-worker note: sessions are DB-backed as of migration `007` (Phase 10.0)
> — they survive restarts and are shared across `--workers > 1`. If the
> `sessions` table is missing (migrations not applied) the app logs a warning
> and falls back to the Phase 1 in-process store: logins still work but do not
> survive a restart, and multi-worker is unsafe until `007` is applied.

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
