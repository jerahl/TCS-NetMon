# Runbook — Operator write actions (spec 11 D4)

The four ZCD operator actions, live in NetMon since **2026-07-29**. These are
the **only** non-GET calls NetMon makes to any source platform. Everything else
in the system is read-only and stays that way.

## How it works (30 seconds)

| Action | Source | Call | Where the button is |
|---|---|---|---|
| Reevaluate Access | PacketFence | `POST /api/v1/node/<mac>/reevaluate_access` | PacketFence page |
| Restart Port | PacketFence | `POST /api/v1/node/<mac>/restart_switchport` | Switches → port detail |
| Cycle PoE | rConfig | `POST /api/v1/snippets/4/deploy` | Switches → port detail |
| Reboot AP | ExtremeCloud IQ | `POST /devices/:reboot` `{"ids":[id]}` | AP Detail |

Every attempt writes a row to `action_audit` **before** the call leaves, and the
row is settled afterwards. Role floor is `operator` (`[actions] min_role`).

## 1. What makes this safe enough to ship

Five properties, all enforced in code rather than by convention:

1. **Closed action registry.** `netmon/actions.py` defines the four; a caller
   supplies an action *key*, never a path. There is no code path that POSTs a
   caller-supplied URL, so these endpoints cannot become an SSRF pivot.
2. **Targets resolve server-side.** The request carries a `device_id`; the
   endpoint reads the address out of the registry itself.
3. **Arguments are validated even though the snippet is trusted.** A PoE cycle
   checks that the port actually exists on that switch. The rConfig snippet is
   reviewable in rConfig; its `port`/`member` substitutions come from NetMon, so
   they get checked.
4. **No retries, ever.** A state-changing call that times out may already have
   landed. Re-sending could reboot an AP twice, so the UI reports *unknown* and
   asks you to re-check.
5. **Refusals are audited too.** An attempt is evidence even when nothing was
   sent — a disabled flag, an unknown device, a wrong device type all leave a
   `refused` row.

## 2. Deviations from the signed design — read this

D4's approved design specified **per-action flags defaulting to off**, with a
dry-run/shadow pass first (CLAUDE.md §4.2), built **post-cutover** in phase
11.x. The owner directed otherwise on 2026-07-29:

- flags default **true** — the actions are live as soon as the code deploys;
- built **before** cutover rather than after;
- role floor `operator`, not admin.

The flags still exist, so any single action can be switched off without a
deploy. That is the property §4.3 cares about, and it is the fastest lever if
one misbehaves.

## 3. Turning one off

```ini
[actions]
enabled = true        # master switch — false disables all four
reevaluate_access = true
restart_port = true
poe_cycle = true
ap_reboot = true
poe_snippet_id = 4    # the stored rConfig "Cycle POE" snippet
min_role = operator   # `viewer` is refused at startup
```

Then `systemctl restart netmon` (or Apply in the settings UI). **Remember the
effective config comes from the DB overlay first** — see
[settings.md](settings.md); the conf file alone is not the truth. Check what is
actually in force:

```bash
cd /usr/share/TCS-NetMon
.venv/bin/python -c "
from netmon import config as C, db as D, settings as S
cfg=C.load_config('/etc/netmon/netmon.conf'); eng=D.make_engine(cfg.db.url)
print(S.overlay_config(cfg,eng).actions)"
```

`min_role = viewer` is rejected at startup rather than quietly hardened — a
read-only role must never be able to reboot an AP, and a typo should be loud.

## 4. Reading the audit trail

```sql
SELECT requested_at, actor, action, target, outcome, http_status, message
FROM action_audit ORDER BY id DESC LIMIT 20;
```

Or `GET /api/actions/audit?limit=50[&device_id=N]` — viewer-readable on purpose;
who bounced what is operational history, not a secret.

| `outcome` | Meaning |
|---|---|
| `ok` | the source accepted it |
| `failed` | the source rejected it, or never answered — **the action may still have happened** |
| `refused` | NetMon stopped it before anything was sent (flag off, unknown device, bad port) |
| `pending` | the row was never settled — the process died mid-call. **Itself a finding**; treat the action's outcome as unknown |

`params` is sanitised: secret-shaped keys are dropped entirely rather than
masked, because a mask still leaks the length.

## 5. Troubleshooting

| Symptom | Cause | Check |
|---|---|---|
| Button greyed with "disabled in config" | that action's flag is false | the overlay snippet in §3 |
| `409` "is not a known port" | no SNMP inventory for that port | run an `snmp_inventory` sweep; check the port name matches `switch_ports.name` |
| `409` "has no XIQ device id" | `devices.xiq_device_id` is NULL | re-run the XIQ import on the Registry page |
| `409` "not a device rConfig knows" | the switch isn't in rConfig, or its IP differs | rConfig knows 153 devices; match is IP-first then exact name |
| `403` | role below `min_role` | `GET /api/actions` reports `your_role` and `min_role` |
| Amber "may still have been carried out" | source timed out | check the device; do **not** click again reflexively |
| No buttons at all | `[actions] enabled = false`, or you are a viewer | `GET /api/actions` |

## 6. Reversibility (CLAUDE.md §4.3)

- One action: set its flag false, restart.
- All four: `[actions] enabled = false`, restart.
- Entirely: revert the D4 commits; migration 020 rolls back with
  `DROP TABLE action_audit` (keep the rows if you want the history —
  the table is inert without the code).

## See also

- `docs/spec/11-standalone-scope.md` §6 — the D4 decision and its deviations
- `reference/actions/ActionXiqApReboot.php`, `ActionSwitchCyclePoe.php`,
  `ActionPfDevice.php` — the ZCD originals these were ported from
- [settings.md](settings.md) — why the conf file is not the effective config
