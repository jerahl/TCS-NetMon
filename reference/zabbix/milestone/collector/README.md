# milestone-collector

Long-lived Python service that owns all Milestone → Zabbix data acquisition:

- **WS pump (continuous)** — holds the Events-and-State WebSocket open,
  baselines via `getState`, streams deltas, pushes per-camera state to
  `milestone.cam.ess.raw[<guid>]` (the template's existing JS preprocessing
  fans the raw blob out to `…comm.type`, `…comm.time`, `…rec.type`).
- **REST pump (scheduled)** — pulls camera/groups/RS-storage inventory and
  pushes legacy-shape blobs to `milestone.cameras.getall`,
  `milestone.groups.get`, `milestone.rs.extras.get`.

One service, two pumps, one token-refresh loop, one secrets file — replaces
all eight legacy externals (`milestone_{cameras,groups,rs,ess}_{read,refresh,state}.{sh,py}`).

See `../milestone-rest-rework.md` for the design rationale and
`../milestone-rework-brief.md` Phase 2 for the operational decisions
(Zabbix-proxy host, 5-GUID subscription, systemd `EnvironmentFile=` secrets).

## Files

```
collector/
├── milestone_collector.py        # the service
├── milestone-collector.service   # systemd unit
├── requirements.txt              # aiohttp, websockets
└── README.md                     # this file
```

## Install (on the Zabbix proxy)

```bash
# 1. Dedicated unprivileged user.
sudo useradd --system --no-create-home --shell /usr/sbin/nologin milestone-collector

# 2. Python deps (a venv is fine if you don't want them system-wide).
sudo pip3 install -r requirements.txt

# 3. Drop the binary somewhere on PATH.
sudo install -m 0755 milestone_collector.py /usr/local/bin/milestone_collector.py

# 4. Secrets file — see ../test/.env.example for the variable set.
sudo install -d -o root -g root -m 0750 /etc/milestone-collector
sudo install -o root -g milestone-collector -m 0640 my.env /etc/milestone-collector/env

# 5. systemd unit.
sudo install -m 0644 milestone-collector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now milestone-collector
sudo systemctl status milestone-collector
journalctl -u milestone-collector -f
```

## Required environment

```ini
# /etc/milestone-collector/env  (0640 root:milestone-collector)
MILESTONE_HOST=milestone.example.com
MILESTONE_SCHEME=https
MILESTONE_USER=zbx_collector
MILESTONE_PASSWORD=...           # XProtect Basic user, read-only role
MILESTONE_CLIENT_ID=GrantValidatorClient
MILESTONE_VERIFY_TLS=1           # 0 in dev for self-signed

ZABBIX_SERVER=zbx-proxy.example.com:10051   # zabbix_sender target
ZABBIX_SENDER_HOST=milestone-site-1         # Zabbix host the trapper items live on
# ZABBIX_SENDER_BIN=/usr/bin/zabbix_sender  # override if not on PATH
# LOG_LEVEL=DEBUG
```

The host name `ZABBIX_SENDER_HOST` is whichever Zabbix host has the
"Milestone XProtect by HTTP" and "Milestone XProtect RS extras by HTTP"
templates linked.

## Development / one-shot use

```bash
cd tcs_dashboard/zabbix/milestone/collector

# Dry-run against dev: load creds from ../test/.env, run both pumps once,
# print every sender line instead of shelling out.
./milestone_collector.py --once --dry-run --env ../test/.env

# REST plane only (verify inventory blob shape against the legacy externals).
./milestone_collector.py --once --rest-only --dry-run --env ../test/.env

# WS plane only (verify state baseline arrives).
./milestone_collector.py --once --ws-only --dry-run --env ../test/.env
```

`--once` runs each pump for a single full cycle (REST = one full assemble
+ push for each blob; WS = connect → subscribe → `getState` → exit before
the receive loop) and returns. Use it for parity diffs against the legacy
externals during the Phase 3 soak.

## Operational notes

- **Token refresh** runs lazily inside `TokenStore.get()` — the first call
  past `expires_in - 60s` triggers a refresh. The WS connection itself
  isn't reauthenticated mid-session (the protocol doesn't accept it); a
  fresh token is applied on the next reconnect. Tune the Milestone token
  TTL with care: if it's shorter than your typical reconnect interval, the
  WS will outlive its token and fail at the next forced reconnect.
- **WS resume** uses the stored `sessionId` + `lastEventId`. Milestone's
  30 s resume window recovers missed events; longer drops return a fresh
  `201` session, at which point the collector re-subscribes and re-baselines
  (the `getState` cost is one full snapshot every reconnect older than 30 s).
- **`getState` is huge** at fleet scale (~tens of MB, 1–2 min). The collector
  sets `max_size=128 MB` on the websocket and uses the library's default
  ping_interval so keepalives are serviced while the response streams.
- **Sender batching:** every WS event batch produces one `zabbix_sender`
  invocation (stdin-fed lines). REST blobs each produce one invocation.

## Known gaps (Phase 5)

- Liveness heartbeat trapper for "monitor the monitor" — not wired yet;
  Phase 5 adds it.
- The RS-extras blob's per-RS `state` field is currently `null`; wiring
  the WS pump's RS service-state events through to the REST pump's RS
  records is Phase 5 work.
- Structured metrics (events/sec, reconnect count, last-baseline time,
  sender failures) are logged but not exposed; Phase 5 adds a small
  prometheus or Zabbix-side exposition.
- Token-rotation runbook — see Phase 5.
