# Runbook — NETworkManager profile feed

Generating the technicians' NETworkManager host list from the NetMon registry.
Script: `scripts/netwm_profiles.py`.

---

## What this is, and what it is not

NETworkManager is a Windows technician's toolbox — RDP, PuTTY, ping monitor,
traceroute, SNMP — driven by a list of hosts it calls *profiles*. It is a
C#/.NET WPF application under GPL-3.0 and shares no code with NetMon; **none of
it is integrated and none of it could be.** This is a one-way feed: NetMon
writes a file, NETworkManager reads it, and NetMon learns nothing back.

The point is that NetMon already knows every host on the estate and keeps that
knowledge current, so nobody has to hand-maintain a list that drifts.

## What the file contains

Names, sites, management IPs, device types, and which NETworkManager tools to
offer per device.

**No credentials.** Not an SNMP community, not an RDP password, not a PuTTY
username — the profile schema has fields for all of them and the writer refuses
to populate any. `_assert_no_secrets()` checks the assembled document before it
is written, so a field added later fails the run rather than landing on a share.

It is still a plaintext inventory of every management address on the estate.
Treat it accordingly: the default mode is `0640`, and the share it lands on
should be readable by technicians and nobody else.

## Running it

```bash
# See what would be produced, write nothing.
/opt/netmon/venv/bin/python scripts/netwm_profiles.py \
    --config /etc/netmon/netmon.conf --dry-run

# Write it.
/opt/netmon/venv/bin/python scripts/netwm_profiles.py \
    --config /etc/netmon/netmon.conf \
    --out /srv/share/netwm/Profiles/TCS-NetMon.json \
    --netmon-url https://netmon.tusc.k12.al.us
```

| Flag | Default | Notes |
|---|---|---|
| `--types` | `switch,ap,recording_server,other` | `all` adds the ~2,650 cameras |
| `--netmon-url` | *(unset)* | adds a deep link to each device's NetMon page in its description |
| `--mode` | `640` | octal mode of the written file |
| `--dry-run` | off | per-site counts, writes nothing |

Cameras are out by default deliberately: 2,659 of them would bury the ~960
hosts a network technician actually opens, and camera work goes through
Milestone.

## Delivery to the fleet

NETworkManager's system-wide policy can point every install at a profiles
directory given as an absolute path, an environment variable, or a **UNC path**.
So:

1. Put the file on a share, e.g. `\\files\netwm\Profiles\TCS-NetMon.json`.
2. Set the profiles directory in the NETworkManager policy to that UNC path.
3. Regenerate nightly:

```cron
0 5 * * * netmon /opt/netmon/venv/bin/python \
    /usr/share/TCS-NetMon/scripts/netwm_profiles.py \
    --config /etc/netmon/netmon.conf \
    --out /srv/share/netwm/Profiles/TCS-NetMon.json
```

The write is atomic — a temp file in the destination directory, then
`os.replace` — so a technician's install never reads half a document, however
the schedules overlap.

## The one manual check

**Nothing in CI can confirm NETworkManager parses the file**, because it is a
Windows GUI application. The tests assert the document shape against the schema
read from the NETworkManager source and assert this writer's own rules; they
cannot assert the app's behaviour.

So after the first run, once: open the file in NETworkManager and confirm a
profile actually drives its tools — ping a switch, RDP a recording server.

If a future NETworkManager release renames the wrapper keys, the symptom is an
empty or partial profile list, and `tests/test_netwm_profiles.py::
test_wrapper_matches_the_netwm_schema` is the test that encodes what the
current schema is. `SCHEMA_VERSION` in the script is the knob.

## Schema notes

Read from `Source/NETworkManager.Profiles/` in the upstream repository:

- `ProfileFileData` serialises `{Version, LastBackup, Groups}`. The groups list
  is a computed `GroupsSerializable` property carrying
  `[JsonPropertyName("Groups")]`, so the JSON key is `Groups`.
- Each group: `Name`, `Description`, `Profiles`.
- The app deserialises with `System.Text.Json` and
  `PropertyNameCaseInsensitive = true`, so a profile naming only the fields we
  care about is valid — every property left out takes its C# constructor
  default. That is why this writer emits ~12 fields per profile rather than the
  200-plus a full `ProfileInfo` carries: enumerating them would mean owning
  every default we do not care about.
- `Tags` is a string and `TagsCollection` is an array; the separator the app
  uses to split the former could not be established from the source, so the
  writer emits **both** and whichever one is read is correct.

## Known wrinkle: site names

Grouping uses `devices.site`, which is what the devices actually carry.

Note that `devices.site` and `sites.name` do **not** agree across the estate —
`sites` holds short codes (`NMS`, `WMS`, `BHS`) while most device rows hold full
names (`Northridge Middle`, `Westlawn Middle`, `Bryant High`). Only `15th`,
`MLK`, `TCTA` and `TMS` overlap. The profile groups therefore read as full
names, which is the right answer for this file, but it is a pre-existing
inconsistency worth resolving separately — it also affects the issue tracker's
site field (spec 24) and any join between the two.
