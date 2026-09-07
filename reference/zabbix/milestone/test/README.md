# Phase 0 — dev harness & API verification

Proves the three Milestone API surfaces work against **dev** XProtect and
captures the facts the rework's later phases depend on. Nothing here touches
Zabbix or the dashboard. See `../milestone-rework-brief.md` Phase 0 for the
task list and DoD; this directory is the runnable form of it.

> **Run against the dev API Gateway only.** Use a dedicated read-only XProtect
> Basic user. Credentials live in `.env` (gitignored); captured responses live
> in `fixtures/` (gitignored). Never commit either.

## Setup

```bash
cp .env.example .env && "$EDITOR" .env     # fill in dev host + creds
```

## What each check covers (maps to brief Phase 0 tasks)

| Brief task | Check | How |
|---|---|---|
| 2 token | IDP token + which path works | `phase0_config_probe.sh` |
| 3 config walk + fixtures | RS → hardware → cameras, capture objects | `phase0_config_probe.sh` |
| 6 pagination probe (Q-B) | does `?size=` truncate? | `phase0_config_probe.sh` |
| **Q-A (camera plane gate)** | does RS-scoped `includeChildren=cameras,settings` embed cameras + MAC? | `phase0_config_probe.sh` |
| 4 WS baseline | `startSession`/`addSubscription`/`getState` | `milestone_ess_state.py` (reuse) |
| 4 WS delta | toggle a camera → delta event | `websocat` (below) |
| 5 Origin header | does the Gateway reject a foreign `Origin`? | `websocat -H` (below) |
| 7 stategroup audit | do the 5 GUIDs cover every state group the template reads? | `milestone_ess_state.py --list-stategroups` → `milestone_ess_resolve.py` |
| 8 synthetic events | does `POST /events` reach the WS *state* stream? | `curl` (below) |
| 9 resume window | 200 vs 201 at ~25s vs ~35s | `websocat` (below) |

## 1. Config plane (token, walk, Q-A, Q-B) — automated

```bash
./phase0_config_probe.sh
```

Reads `.env`, writes fixtures, and prints a **FACTS SUMMARY**. The load-bearing
line is **Q-A**: if RS-scoped `includeChildren=cameras,settings` embeds cameras
and a MAC field, `milestone.cameras.getall` (brief Phase 1 task 2) is one call
per RS; if not, it needs the per-hardware fallback and a timeout soak. Paste the
summary into the Phase 0 notes and commit the (sanitised) fixtures if useful.

## 2. WS baseline + stategroup coverage audit (tasks 4, 7)

The existing helpers already speak the ESS WebSocket — reuse them rather than
re-implementing:

```bash
# Baseline getState (also confirms token → WSS → startSession → subscribe path):
./../milestone_ess_state.py "$MILESTONE_HOST" "$MILESTONE_USER" "$MILESTONE_PASSWORD" \
    --scheme "$MILESTONE_SCHEME"  > fixtures/ws_getstate.json

# Coverage audit: enumerate (stategroupid,type) pairs, then resolve GUIDs to names.
./../milestone_ess_state.py "$MILESTONE_HOST" "$MILESTONE_USER" "$MILESTONE_PASSWORD" \
    --scheme "$MILESTONE_SCHEME" --list-stategroups > fixtures/ws_stategroups.json
./../milestone_ess_resolve.py "$MILESTONE_HOST" "$MILESTONE_USER" "$MILESTONE_PASSWORD" \
    --input fixtures/ws_stategroups.json > fixtures/ws_stategroups_named.json
```

Confirm the 5 subscription GUIDs (brief "Event-type GUIDs") cover every state
group the template's `milestone.cam.ess.*` items and CALCULATED items read. If a
template-read state rides on a hardware-level GUID (`communication_hw_*`), the
collector's subscription must add `resourceTypes:["hardware"]` — record the
decision here.

## 3. WS delta, resume window, Origin (tasks 4, 5, 9) — `websocat`

`milestone_ess_state.py` is one-shot (no resume), so use `websocat` for the
session-resume and Origin facts. Install: `cargo install websocat` or a release
binary.

```bash
TOKEN=$(curl -sk -X POST "$MILESTONE_SCHEME://$MILESTONE_HOST/API/IDP/connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=password --data-urlencode "username=$MILESTONE_USER" \
  --data-urlencode "password=$MILESTONE_PASSWORD" --data-urlencode client_id=GrantValidatorClient \
  | jq -r .access_token)

# Interactive: send startSession (blank ids), addSubscription, getState, then
# toggle a camera in Management Client and watch the delta arrive.
websocat -k -H="Authorization: Bearer $TOKEN" \
  "wss://$MILESTONE_HOST/api/ws/events/v1"
#   paste: {"command":"startSession","commandId":1,"sessionId":"","eventId":""}
#   note the returned sessionId; paste addSubscription with the 5 GUIDs; getState.

# Resume window (task 9): record sessionId + last eventId, close, reconnect and
# send startSession with those ids at ~25s (expect status 200, resumed) and in a
# fresh run at ~35s (expect 201, new session). Confirms the 30s figure.

# Origin (task 5): does the Gateway reject a foreign Origin on the WS handshake?
websocat -k -H="Authorization: Bearer $TOKEN" -H="Origin: https://zabbix.example.com" \
  "wss://$MILESTONE_HOST/api/ws/events/v1"
#   If this connects, cross-origin from the Zabbix UI host is fine (Phase 4).
#   If rejected, Phase 4 needs same-origin reverse-proxy or scoped CORS.
```

## 4. Synthetic events (task 8) — `POST /events`

Lets Phase 2 test the collector without physically toggling cameras. A *service*
token can trigger any type; a *user* token only External/MIPDevice types — so
triggering the system comm/recording GUIDs may need a service token. Confirm
whether the synthetic event shows up in the WS *state* stream (§3) or only the
event log.

```bash
curl -sk -X POST "$MILESTONE_SCHEME://$MILESTONE_HOST/api/rest/v1/events" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"<event-type-guid>","source":"cameras/<camera-guid>","datatype":"none"}'
```

## Definition of Done

Token, per-RS camera enumeration, and a live WS delta all observed and captured
in `fixtures/`; the FACTS SUMMARY recorded; Q-A / Q-B / stategroup-coverage /
resume-window / synthetic-event / Origin answers written into the Phase 0 notes.
Those answers unblock the `milestone.cameras.getall` aggregator (Phase 1) and
the collector subscription filter (Phase 2).
