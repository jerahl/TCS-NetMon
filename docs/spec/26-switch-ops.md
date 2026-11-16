# Spec 26 — Direct SNMP switch operations

**Status:** built 2026-11-16 on branch `claude/switch-ops`, default **off**, dry-run **on**.
**Owner sign-off:** 2026-11-16 — SNMP SET writes to switches approved (CLAUDE.md §8:
new non-GET). Brief originated from the Site Engine retirement review (Site Engine →
Extreme Platform ONE): NetMon talks to switches directly where rConfig can't or won't.

## 1. What

| Capability | How | Role | Flag |
|---|---|---|---|
| PoE cycle | SET `extremePethPortResetPower.<slot>.<port>` = set(1); fallback `pethPsePortAdminEnable` false(2) → wait → true(1) | operator | `[switch_ops] poe_cycle` |
| Port bounce | SET `ifAdminStatus.<ifIndex>` down(2) → wait (default 5 s, max 30 s) → up(1) | operator | `[switch_ops] port_bounce` |
| Live port view | `snmpget` of one port every 5 s while viewed; FDB every 15 s | viewer | `[switch_ops] live_port` |

Master switch `[switch_ops] enabled` (default false) gates both writes; `dry_run`
(default true) logs the exact `snmpset` command lines in `action_audit` and sends nothing.

Not copied from Site Engine's `Cycle_Port_POE.py`: it SETs ifAdminStatus to up(1) in
*both* halves, so only its PoE reset ever did anything. NetMon's bounce takes the link
down for real.

## 2. Index (verified)

EXOS names ports `slot:port` (standalone `1:N`), `ifIndex = slot*1000 + port`. PoE
tables are indexed `{pethPsePortGroupIndex, pethPsePortIndex}` = `slot.port`
(EXTREME-POE-MIB `extremePethPsePortEntry` shares the POWER-ETHERNET-MIB index).

Read-only walk, RQE_516 (5× X465-48P stack, 32.5.1.5), 2026-11-16:
`1916.1.27.2.1.1.5` (reset) 240 rows, groups 1–5, all `clear(2)`; `.6` (mW) 240 rows;
`.4` (clear fault) 240 rows; `105.1.1.1.3` 240 rows, all true(1).
**Standalone switch not yet walked** — expected group 1; a missing instance is refused
at the pre-read, never guessed.

## 3. Refusals

* All actions: port must exist in `switch_ports` and be front-panel
  (`is_physical_port`; excludes mgmt `slot*1000`, stacking `2xx`, VLAN ifs), and
  `ifIndex == slot*1000+port`.
* **PoE cycle: no uplink/neighbor refusal** (owner, 2026-11-16: "a switch won't use
  PoE"). Refused only when the port has no PoE, PoE is admin-off (a cycle would turn
  it on), or the switch lacks both PoE objects.
* **Port bounce:** refused on an EDP neighbor, an LLDP neighbor that is a registered
  switch, a mapped fiber-link end, or an SFP port. LLDP from cameras/APs/phones does
  not block. Admin override = type the port name; recorded in the audit row. Also
  refused when the port is admin-down (a bounce would enable it).
* Cooldown 120 s per port across `snmp_poe_cycle`, `snmp_port_bounce` *and* the rConfig
  `poe_cycle`. One write in flight per switch (in-process lock + `pending` audit rows,
  so both processes respect it). Bulk: ≤ 8 ports operator, ≤ 48 admin.

## 4. Never leave a port down (migration 042)

`switch_port_restores` row inserted **before** any "off/down" SET with the exact
restore OID/value and a deadline (hold + 30 s grace); deleted after the restore SET is
accepted. The restore SET retries 3× (idempotent). The **restore sweep** runs in
`netmon-poller.service` every 15 s — a different process from the one that took the
port down — re-applies overdue rows regardless of `enabled`/`dry_run`, opens a
`switch_port_restore` alert (`managed_by = 'switch_ops'`, invisible to the engine) with a
notification, and closes it when no overdue row remains. The PoE *reset* path is one
self-completing SET and writes no row.

A SET with no answer is treated as possibly-landed: an unanswered reset does **not**
fall back to admin off/on (that would cut power twice).

## 5. Verification

After the switch lock is released, a background task reads the port back for up to
`verify_timeout_s` (90 s): PoE delivering + mW > 0 (PoE), link up (both), and — when the
port had MACs in the last sweep — one of them back in the live FDB on that bridge port.
Timings are appended to the audit row; failure turns its outcome to `failed`.

## 6. Live view

Request-driven, no background loop: each GET renews a 30 s subscription and polls only
when the cached sample is older than 5 s. Viewers share one poll; ≤ 20 live ports
fleet-wide; one in-flight read per switch (busy → cached sample). In memory only. This
is a deliberate, bounded exception to "zero source calls at page render" (CLAUDE.md §6).

## 7. Automation

`[switch_ops] automation_poe_method = rconfig|snmp` (default `rconfig`) picks the path an
approved `poe_cycle` proposal takes. With `snmp`, an *unavailable* SNMP path (feature
off, no credentials, object missing) falls back to rConfig when `rconfig_fallback = true`;
a *policy* refusal (cooldown, outstanding restore) never falls back.

## 8. Credentials

Dedicated SNMPv3 authPriv user (SHA/AES), write view limited to ifAdminStatus, ifAlias,
pethPsePortAdminEnable, extremePethPortResetPower. `NETMON_SNMP_RW_USER/_AUTH/_PRIV` in
`/etc/netmon/netmon.env` only (config refuses them in netmon.conf). Passphrases go to a
0600 `snmp.conf` in a private temp dir (`SNMPCONFPATH`), never on argv. Reads use the
poller's existing read community. Site Engine's write credentials are not reused.
Commands: `docs/runbooks/switch-ops.md`.

## 9. Rollout (owner-gated)

1. ✅ Read-only walk on a stack (RQE_516). ☐ Walk one standalone switch.
2. ☐ Merge; deploy with `enabled = false`; apply migration 042; install the poller
   `EnvironmentFile` drop-in (runbook).
3. ☐ `enabled = true`, `dry_run = true`: dry-run PoE cycle + bounce on the agreed spare port.
4. ☐ Owner creates the SNMPv3 write user on that switch; credentials in netmon.env.
5. ☐ `dry_run = false`; one live PoE cycle and one bounce on the spare port, with owner approval.
6. ☐ Later: `automation_poe_method = snmp`; `live_port = true`.

## Next session

* Walk a standalone switch (step 1).
* `render-check` cases for `SwitchOpButton` / `LivePort` (not yet added).
* Candidate follow-up: `extremePethPortClearFault` (.4) "clear PoE fault" action — out of
  scope until asked.
