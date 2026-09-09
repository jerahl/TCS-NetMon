# VLAN, PoE Budget, Topology

Second template patch — fills out the data the Switches tabs need beyond
per-member health. Apply on top of (or alongside) `per-member-health.yaml`.

## What it adds

### VLAN tab
- `extreme.vlan.discovery` walks `EXTREME-VLAN-MIB::extremeVlanIfTable`
  (1.3.6.1.4.1.1916.1.2.1.2). One row per VLAN. Prototypes:
  - `extreme.vlan.id[<ifIndex>]` — the 802.1Q VID
  - `extreme.vlan.descr[<ifIndex>]` — human name
  - `extreme.vlan.admin[<ifIndex>]` — admin status (1=up, 2=down)
  - `extreme.vlan.encaps[<ifIndex>]` — 1=8021q, 2=none
- `extreme.vlan.portmap.discovery` walks `extremeVlanOpaqueTable`
  (1.3.6.1.4.1.1916.1.2.6.1) — indexed by `<vlanIfIndex>.<slot>`. Each
  row gives a tagged/untagged port bitmap for that VLAN on that slot.
  Prototypes:
  - `extreme.vlan.tagged[<vlanIfIndex>.<slot>]` — hex octet string
  - `extreme.vlan.untagged[<vlanIfIndex>.<slot>]` — hex octet string

  The dashboard parses the PortList bitmap (RFC 2674 §5: octet `n`, bit `k`
  = port `n*8 + k`, MSB-first within each octet) into a port set to render
  the per-port VLAN matrix.

  **Why this table specifically:** EXOS supports the standard
  Q-BRIDGE-MIB `dot1qVlanCurrentTable`, but on a stack the egress port
  bitmap mixes all slots into one long octet string keyed by ifIndex —
  hard to render per-member. `extremeVlanOpaqueTable` is indexed by
  `(vlanIfIndex, slotNumber)`, so each row's bitmap is already
  slot-scoped and maps cleanly onto the per-slot port grid in the
  dashboard.

### PoE Budget tab
- `extreme.poe.slot.discovery` walks `EXTREME-POE-MIB::extremePethPseSlotTable`
  (1.3.6.1.4.1.1916.1.27.1.2). One row per PoE-capable stack member.
  Prototypes (all watts unless noted):
  - `extreme.poe.budget[<slot>]` — configured limit (`extremePethSlotPowerLimit`)
  - `extreme.poe.drawn[<slot>]` — allocated to PoE devices (`extremePethSlotConsumptionPower`)
  - `extreme.poe.measured[<slot>]` — actually measured (`extremePethSlotMeasuredPower`)
  - `extreme.poe.available[<slot>]` — effective budget given PSU mode (`extremePethSlotMaxAvailPower`)
  - `extreme.poe.capacity[<slot>]` — hardware ceiling (`extremePethSlotMaxCapacity`)
  - `extreme.poe.status[<slot>]` — operational state (`extremePethSlotPoeStatus`)
- Extends `snmp.interfaces.poe.discovery` with a per-port `class` prototype
  reading `pethPsePortPowerClassifications` (1.3.6.1.2.1.105.1.1.1.10).
  Values: 1=class0, 2=class1, 3=class2, 4=class3, 5=class4 (PoE+/802.3at).

Stack totals (drawn / budget / reserved / available shown in the headline
card) are derived client-side by summing the per-slot items. Top consumers
already come from the existing `snmp.interfaces.poe.mpower[…]` items.

### Topology tab
- `lldp.neighbor.discovery` walks `LLDP-MIB::lldpRemTable`
  (1.0.8802.1.1.2.1.4.1) — one row per learned neighbor. Index is the
  3-tuple `<TimeMark>.<LocalPortNum>.<RemIndex>`. Prototypes:
  - `lldp.neighbor.sysname[<index>]`
  - `lldp.neighbor.portid[<index>]`
  - `lldp.neighbor.portdesc[<index>]`
  - `lldp.neighbor.sysdesc[<index>]`
  - `lldp.neighbor.chassisid[<index>]`
- `lldp.local.discovery` walks `lldpLocPortDesc` (1.0.8802.1.1.2.1.3.7.1.4).
  The middle component of each neighbor index references the local LLDP
  port number, which on EXOS happens to equal ifIndex for physical ports
  but the LLDP-MIB doesn't guarantee that. This LLD lets the dashboard
  build a definitive `localPortNum → "<slot>:<port>"` map.
- `extreme.edp.discovery` walks `EXTREME-EDP-MIB::extremeEdpTable`
  (1.3.6.1.4.1.1916.1.13.2) — EDP is Extreme's pre-LLDP discovery
  protocol; useful for Extreme-to-Extreme topology because it carries
  the peer's slot and port number directly (where LLDP gives you a
  Port-ID that may be a MAC or an arbitrary string). Index is
  `<localIfIndex>.<b1>.<b2>.<b3>.<b4>.<b5>.<b6>.<b7>.<b8>` (9 sub-OIDs;
  fixed-size `OCTET STRING (SIZE (8))` without `IMPLIED` encodes each
  byte as its own sub-OID with no length prefix). Prototypes:
  - `extreme.edp.name[<index>]` — peer hostname
  - `extreme.edp.version[<index>]` — peer EXOS version
  - `extreme.edp.slot[<index>]` — peer slot number
  - `extreme.edp.port[<index>]` — peer port number
  - `extreme.edp.age[<index>]` — seconds since last refresh

  Run EDP alongside LLDP, not instead of it: LLDP covers non-Extreme
  neighbors (the core switches in your topology demo are Aruba CX, which
  speak LLDP but not EDP), while EDP gives crisper Extreme↔Extreme
  edges.

## Port authentication sessions

**Update:** an earlier draft of this doc said per-port auth sessions
weren't pollable via SNMP. That was wrong — the `extremeNetlogin*` OIDs
*are* trap-only, but the **`ETSYS-MULTI-AUTH-MIB`** session table is
fully pollable and covers all EXOS auth methods (802.1X, MAC-auth, web-
auth, CEP, etc.) in one place. See `port-auth.md` / `port-auth.yaml` in
this folder.

The notes below are kept for reference — they're alternative paths if
the MultiAuth MIB doesn't fit (e.g., if you need real-time event
streaming rather than a 5-minute poll, or if you're on a hardware/OS
combo where the MIB isn't implemented).

### Legacy alternatives (mostly superseded by port-auth.yaml)

The `extremeNetlogin*` OIDs (in `EXTREME-SECURITY-MIB`,
1.3.6.1.4.1.1916.1.42 area) are all `MAX-ACCESS accessible-for-notify` —
they only appear inside SNMP trap PDUs, not as gettable values.

Three practical alternatives:

1. **SNMP traps** (lightweight, near-real-time)
   - Configure EXOS to send traps to Zabbix (`configure snmpv2c add notification`).
   - The base template already polls `snmptrap.fallback` (key `snmptrap.fallback`)
     as a catch-all string. To extract session state, add dedicated trap
     items keyed off the trap OIDs:
     - `extremeNetloginUserLogin` (login event)
     - `extremeNetloginUserLogout` (logout event)
     - `extremeNetloginAuthFailure`
   - Each trap carries `extremeNetloginPortIfIndex`, `extremeNetloginStationMac`,
     `extremeNetloginUser`, `extremeNetloginAuthType`, and either source/dest
     VLAN. Use Zabbix `snmptrap["regex"]` items with preprocessing to bucket
     them by port and maintain a current-sessions view.
   - Tradeoff: the dashboard sees the *event stream*, not a queryable table —
     state has to be reconstructed from `login + logout` pairs. Acceptable for
     live "who's on this port right now" if you keep a recent-event window
     (~24h) and treat unmatched logins as still-active.

2. **SSH polling via rConfig** (works today)
   - The repo already integrates with rConfig (`tcs_dashboard/lib/RConfigClient.php`).
     Add an rConfig snippet that runs `show netlogin port <p>` (or
     `show netlogin all`) and parses the structured output.
   - Schedule it on the cadence you want (5 min is fine for "current
     sessions"). Wire it into the snapshot endpoint the same way
     `RConfigClient` already surfaces backups.

3. **EXOS REST API** (cleanest, requires EXOS ≥ 22.x with REST enabled)
   - `GET /rest/restconf/data/openconfig-system:system/...` — Extreme also
     exposes session state via `nbi` / RESTCONF on newer EXOS releases.
   - Not present in the current dashboard's client stack; would be a new
     client similar to `RConfigClient`.

Recommendation: **start with option 1 (SNMP traps)**. It's the lowest-friction
path, requires no extra credentials beyond what the SNMP setup already needs,
and gives login/logout events the dashboard can render as a per-port session
log. If you need a definitive "who is on port X *right now*" view that
survives Zabbix restart, layer in option 2.

## Importing

The patch is a Zabbix YAML fragment that merges into the existing template
on import. UUIDs are stable so a re-import won't duplicate items. After
applying, manually run the new LLDs once (Discovery → Items → "Execute
now") so the prototypes materialize before the dashboard tries to read
them.

A typical Extreme stack ends up with roughly:
- 12–30 VLAN-list items (3 × VLAN count + 1)
- 50–250 VLAN-portmap items (2 × VLAN count × member count)
- 30 PoE-slot items (6 × member count)
- 4 LLDP items per neighbor (typically 2–6 neighbors per switch)

If the VLAN-portmap LLD discovers more items than you want, scope it with
an LLD filter on `{#SNMPINDEX}` (e.g., only slots 1–4).
