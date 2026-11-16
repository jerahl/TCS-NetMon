# Runbook — direct SNMP switch operations (spec 26)

## 1. Create the SNMPv3 write user on a switch (owner, by hand or rConfig)

NetMon never pushes this. Switch Engine / EXOS 32.x–33.x syntax; run on the test switch
first and check the `show` output before rolling out. Not yet executed on this fleet.

```
configure snmpv3 add mib-view netmon-write subtree 1.3.6.1.2.1.2.2.1.7
configure snmpv3 add mib-view netmon-write subtree 1.3.6.1.2.1.31.1.1.1.18
configure snmpv3 add mib-view netmon-write subtree 1.3.6.1.2.1.105.1.1.1.3
configure snmpv3 add mib-view netmon-write subtree 1.3.6.1.4.1.1916.1.27.2.1.1.5
configure snmpv3 add user netmon-rw authentication sha <AUTH_PASS> privacy aes <PRIV_PASS>
configure snmpv3 add group netmon-rw user netmon-rw sec-model usm
configure snmpv3 add access netmon-rw sec-model usm sec-level priv read-view defaultUserView write-view netmon-write
enable snmp access snmpv3
save configuration
```

Check: `show snmpv3 user netmon-rw`, `show snmpv3 access netmon-rw`,
`show snmpv3 mib-view netmon-write`. If SNMP is restricted by an access profile, the
NetMon server needs read-write through it. Passphrases: ≥ 8 chars, **no whitespace**
(NetMon refuses whitespace — net-snmp would silently truncate it).

Quick test from the NetMon server (reads the reset object, which always returns 2):

```
snmpget -v3 -l authPriv -u netmon-rw -a SHA -A '<AUTH_PASS>' -x AES -X '<PRIV_PASS>' <switch-ip> 1.3.6.1.4.1.1916.1.27.2.1.1.5.1.1
```

## 2. NetMon configuration

`/etc/netmon/netmon.env` (root:netmon 0640):

```
NETMON_SNMP_RW_USER=netmon-rw
NETMON_SNMP_RW_AUTH=<AUTH_PASS>
NETMON_SNMP_RW_PRIV=<PRIV_PASS>
```

The poller needs the same environment (it runs the restore sweep).
`/etc/systemd/system/netmon-poller.service.d/env.conf`:

```
[Service]
EnvironmentFile=-/etc/netmon/netmon.env
```

then `systemctl daemon-reload && systemctl restart netmon netmon-poller`.

`/etc/netmon/netmon.conf`:

```
[switch_ops]
enabled = true
dry_run = true          ; flip to false only after the dry run on the spare port
live_port = false
```

## 3. First test (owner-approved spare port only)

1. Dry run: Switches → the switch → spare port → **Cycle PoE (SNMP) (dry run)**, then
   **Bounce port (dry run)**. Audit trail (bottom of the page) shows `DRY RUN — …` and the
   exact `snmpset` lines. Nothing is sent.
2. Live: `dry_run = false`, restart `netmon`. Repeat on the same port. Within ~90 s the
   audit row gains `verified: power Ns, link Ns, …` or `verification FAILED: …`.

## 4. If a port is left down

`SELECT * FROM switch_port_restores;` — every row is a port NetMon has not yet put back.
The poller re-applies overdue rows every 15 s and raises a `switch_port_restore` alert.
`last_error` says why a restore keeps failing. To restore by hand, SET the row's
`restore_oid` to `restore_value` (or `enable ports <port>` / `enable inline-power ports
<port>` on the CLI), then delete the row.

## 5. Turning it off

`[switch_ops] enabled = false` and restart `netmon`. The restore sweep keeps running
regardless, so a port taken down before the switch-off still comes back.
