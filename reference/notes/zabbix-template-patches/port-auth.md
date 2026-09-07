# Port authentication (802.1X / MAC-auth / web-auth) per client

The earlier note (`vlan-poe-topology.md`) flagged netlogin sessions as
SNMP-trap-only on EXOS — the `extremeNetlogin*` OIDs in
`EXTREME-SECURITY-MIB` are all `accessible-for-notify`, so you can't
poll them.

**The MIB we actually want is `ETSYS-MULTI-AUTH-MIB`** (under
`enterasys.etsysMibs.etsysModules.46`, OID `1.3.6.1.4.1.5624.1.2.46`).
It's a Zabbix-pollable table — Enterasys-era unified auth model, and
EXOS still implements it. One row per `(station MAC, port, auth-method)`
covering 802.1X, MAC-auth, web-auth (PWA), CEP detection, RADIUS
snooping, etc., all in the same table.

## The session table

`etsysMultiAuthSessionStationTable` (1.3.6.1.4.1.5624.1.2.46.1.4.1).
Index is a 4-tuple `(StationAddrType, StationAddr, ifIndex, AgentType)`
which encodes in OIDs as:

```
<addrType>.<addrLen>.<addr bytes…>.<ifIndex>.<agentType>
```

For typical port auth (MAC-addressed stations) that's:
```
3.6.<m1>.<m2>.<m3>.<m4>.<m5>.<m6>.<ifIndex>.<agentType>
```
— 10 components in `{#SNMPINDEX}`. The dashboard parses the second-to-last
component to recover the port `ifIndex`, and joins back to the existing
`net.if.alias[ifIndex.<n>]` / port discovery to get the human "slot:port".

### Per-session columns (all pollable)

| Field | OID suffix | Type |
|---|---|---|
| `etsysMultiAuthSessionAgentType` | `.1` | 1=802.1X · 2=PWA · 3=MAC-auth · 4=CEP · 5=RADIUS-snoop · 6=auto-track · 7=quarantine |
| `etsysMultiAuthSessionStationAuthStatus` | `.2` | 1=authSuccess · 2=authFail · 3=authInProgress · 4=authIdle · 5=authTerminated |
| `etsysMultiAuthSessionAuthAttemptTime` | `.3` | TimeStamp |
| `etsysMultiAuthSessionAuthServerType` | `.4` | 1=radius · 2=local |
| `etsysMultiAuthSessionAuthServerAddr` | `.6` | InetAddress |
| `etsysMultiAuthSessionPolicyIndex` | `.7` | Filter-ID / Policy Profile applied |
| `etsysMultiAuthSessionIsApplied` | `.8` | TruthValue — only one row per MAC+port is "applied" at a time |
| `etsysMultiAuthSessionDuration` | `.12` | seconds |
| `etsysMultiAuthSessionIdleTime` | `.13` | seconds |
| `etsysMultiAuthSessionVlanTunnelAttribute` | `.14` | dynamic VLAN ID (RADIUS Tunnel-Private-Group-ID); 0=none, 4095=could-not-apply |

## What the patch adds

`port-auth.yaml` adds one LLD with seven prototypes per session:
`extreme.portauth.{status, agent, duration, idle, vlan, policy, applied}[<index>]`.

The LLD filter restricts items to `AuthStatus = 1 (authSuccess)` so we don't
spawn items for transient `authInProgress` / `authTerminated` rows that the
agent may prune at any time.

Polling cadence is 5 minutes per item — auth sessions are stable enough that
faster polling is wasteful, and a typical edge switch can have 100+ sessions
which means 700+ items. Bump to 10 minutes on large stacks if it's too
chatty.

## Multi-auth quirk to be aware of

The same MAC on the same port can have multiple rows — one per auth agent.
For example, a phone behind 802.1X with MAC-auth fallback could show two
rows (`agentType=1` and `agentType=3`). Only one is "applied" at a time
(`extreme.portauth.applied[…] = 1`); the rest are passive evaluations or
stale. The dashboard should filter to `applied = true` (TruthValue 1) when
rendering the "who's on this port" list.

## Alternatives in the same MIB family

- **`ETSYS-MAC-AUTHENTICATION-MIB`** (1.3.6.1.4.1.5624.1.2.25) —
  `etsysMACAuthenticationSessionTable` is a simpler 2-column view
  (`SessionPort` + `Duration`, indexed by MAC). Use only if you don't need
  agent type / VLAN / policy detail.
- Standard `IEEE8021-PAE-MIB` at 1.0.8802.1.1.1 — covers 802.1X only, no
  MAC-auth or web-auth. EXOS supports it but its tables are awkwardly
  shaped (per-port supplicant state, not per-session-per-MAC).

`ETSYS-MULTI-AUTH-MIB` is the right pick: one table, all auth types,
per-MAC granularity, pollable, and includes the RADIUS-assigned VLAN —
the data the dashboard actually needs to render a "clients authenticated
on this port" view.

## Importing

Import `port-auth.yaml` after `vlan-poe-topology.yaml`. UUIDs are stable
so re-imports won't duplicate. Run the LLD once manually ("Execute now")
after import so the session items materialize before the dashboard tries
to read them.

Verification snippet:
```
snmpwalk -v2c -c <community> <switch-ip> 1.3.6.1.4.1.5624.1.2.46.1.4.1.1.2
```
Each returned OID's tail is the session index (10 components for
MAC-keyed sessions); the value is the auth status.
