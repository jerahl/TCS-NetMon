#!/usr/bin/env python3
"""Generate a NETworkManager profile file from the NetMon device registry.

NETworkManager (BornToBeRoot) is a Windows technician's toolbox — RDP, PuTTY,
ping monitor, traceroute, SNMP — driven by a list of hosts it calls *profiles*.
NetMon already knows every host on this estate and keeps that knowledge
current. This writes the one out of the other, so a technician's desktop has an
always-correct host list instead of a hand-maintained one that drifts.

It is a *feed*, not an integration: no NETworkManager code is used or could be
(C#/.NET, WPF, Windows-only, GPL-3.0), nothing is read back, and NetMon learns
nothing from it. One file, written on a schedule.

DELIVERY. NETworkManager's system-wide policy can point every install at a
profiles directory given as an absolute path, an environment variable, or a UNC
path — so the intended shape is: this writes to a share, a policy points the
fleet at it, and the file is regenerated nightly.

    0 5 * * *  netmon  /opt/netmon/venv/bin/python \\
                       /usr/share/TCS-NetMon/scripts/netwm_profiles.py \\
                       --out /srv/share/netwm/Profiles/TCS-NetMon.json

WHAT GOES IN THE FILE, AND WHAT NEVER DOES. Names, sites, management IPs,
device types. **No credential of any kind** — not an SNMP community, not an RDP
password, not a PuTTY username. The profile schema has fields for all of those
and this writer refuses to populate them; `_assert_no_secrets` enforces it on
the way out rather than leaving it to review. A profile file is a plaintext
JSON inventory of every management address on the estate, which is already
sensitive enough: write it 0640 to a share only technicians can read, and treat
it like the registry it is.

READ-ONLY (CLAUDE.md §4.1): one SELECT against `devices`. Nothing is written
back to NetMon and no source platform is contacted.

SCHEMA. Read from the NETworkManager source (Source/NETworkManager.Profiles/):
`ProfileFileData` serialises `{Version, LastBackup, Groups}` — the groups list
carries `[JsonPropertyName("Groups")]` over a `GroupsSerializable` property —
and each group carries `Name`, `Description` and `Profiles`. The app
deserialises with System.Text.Json, `PropertyNameCaseInsensitive = true`, so a
profile naming only the fields below is valid: everything unmentioned takes the
C# constructor's default. That is deliberate — enumerating the 200-plus
properties a full `ProfileInfo` carries would mean owning every default this
file does not care about.

VERIFY ONCE, after the first run: open the file in NETworkManager and check a
profile actually drives its tools. If a future NETworkManager release renames
the wrapper keys, that is where it will show, and `SCHEMA_VERSION` below is the
knob.

Usage::

    python scripts/netwm_profiles.py --out TCS-NetMon.json
    python scripts/netwm_profiles.py --types all --out /srv/share/...
    python scripts/netwm_profiles.py --dry-run          # counts, writes nothing
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from netmon import db  # noqa: E402
from netmon.config import ConfigError, load_config  # noqa: E402

#: `ProfileFileData.Version`, used by NETworkManager for schema migrations.
SCHEMA_VERSION = 1

#: Default set. Cameras are excluded because 2,659 of them would bury the 966
#: hosts a network technician actually opens, and camera work goes through
#: Milestone anyway. `--types all` includes them.
DEFAULT_TYPES = ("switch", "ap", "recording_server", "other")

#: Separator for the `Tags` string. NETworkManager also carries a
#: `TagsCollection` array and this writer populates BOTH, so whichever one the
#: app reads gets correct data and the separator never has to be guessed right.
TAG_SEPARATOR = ";"

#: Profile fields that would carry a secret. Never written; asserted on output.
SECRET_FIELDS = (
    "SNMP_Community", "SNMP_Auth", "SNMP_Priv",
    "RemoteDesktop_Password", "RemoteDesktop_GatewayServerPassword",
    "PuTTY_Password", "PuTTY_PrivateKeyFile", "TigerVNC_Password",
)


def _tools_for(device_type: str, snmp_capable: bool, ip: str) -> dict:
    """Which NETworkManager tools a profile offers, by what the device is.

    Every tool inherits the profile's `Host`, so there is one address per
    device and no second copy to drift.

    The per-type choices are the ones a technician would make by hand:

    * Everything answers ping, so every profile gets the ping monitor.
    * SSH goes to switches and APs — the two things anyone consoles into.
      Cameras get none: nobody SSHes a camera, and offering it invites trying.
    * **RDP and PowerShell go to the recording servers, and only there.** They
      are the estate's Windows hosts, and the thing NetMon has never been able
      to see inside (OpenProject #111 — recorder host health needs WinRM). A
      technician opening a recorder today does it over RDP regardless; this
      just means they do not have to remember the address.
    * A web console for anything with a management web UI.
    * SNMP only where the registry says the device answers it, so the tool is
      not offered on hosts where it will time out.
    """
    web = f"https://{ip}"
    tools: dict = {
        "PingMonitor_Enabled": True,
        "PingMonitor_InheritHost": True,
        "Traceroute_Enabled": True,
        "Traceroute_InheritHost": True,
    }

    if device_type in ("switch", "ap"):
        tools.update({"PuTTY_Enabled": True, "PuTTY_InheritHost": True,
                      "WebConsole_Enabled": True, "WebConsole_Url": web})
    elif device_type == "camera":
        tools.update({"WebConsole_Enabled": True, "WebConsole_Url": web})
    elif device_type == "recording_server":
        tools.update({"RemoteDesktop_Enabled": True, "RemoteDesktop_InheritHost": True,
                      "PowerShell_Enabled": True, "PowerShell_InheritHost": True,
                      "PowerShell_EnableRemoteConsole": True})

    if snmp_capable:
        # No community string — the technician's own NETworkManager settings
        # supply it. See SECRET_FIELDS.
        tools.update({"SNMP_Enabled": True, "SNMP_InheritHost": True})

    return tools


def _profile(row: dict, netmon_url: str) -> dict:
    """One NETworkManager profile from one `devices` row."""
    name = str(row["name"])
    ip = str(row["mgmt_ip"])
    device_type = str(row["device_type"])
    site = str(row["site"] or "Unassigned")

    tags = [device_type, site]
    if row.get("snmp_capable"):
        tags.append("snmp")

    description = f"{device_type} at {site}"
    if netmon_url:
        # The route NetMon itself uses for this kind of device, so the profile
        # points back at the monitoring record rather than just an address.
        path = {"ap": "ap", "camera": "camera"}.get(device_type, "switches")
        description += f" · {netmon_url.rstrip('/')}/ui/#/{path}/{row['id']}"

    profile = {
        "Name": name,
        "Host": ip,
        "Description": description,
        "Group": site,
        "Tags": TAG_SEPARATOR.join(tags),
        "TagsCollection": tags,
    }
    profile.update(_tools_for(device_type, bool(row.get("snmp_capable")), ip))
    return profile


def _assert_no_secrets(payload: dict) -> None:
    """Refuse to write a file carrying a credential field.

    Belt and braces over `_tools_for`, which populates none of them: this runs
    on the assembled document, so a field added later by someone who did not
    read the module docstring fails here rather than landing on a share.
    """
    blob = json.dumps(payload)
    for field in SECRET_FIELDS:
        if f'"{field}"' in blob:
            raise SystemExit(
                f"refusing to write: the profile document contains {field}. "
                "NetMon does not put credentials in an exported inventory "
                "(see SECRET_FIELDS in this script).")


def build(engine, types: tuple[str, ...], netmon_url: str = "") -> dict:
    """The whole profile document, grouped by site."""
    placeholders = ", ".join(f":t{n}" for n in range(len(types)))
    rows = db.fetch_all(engine, f"""
        SELECT id, name, site, device_type, mgmt_ip, snmp_capable
          FROM devices
         WHERE enabled = 1
           AND mgmt_ip IS NOT NULL AND mgmt_ip <> ''
           AND device_type IN ({placeholders})
         ORDER BY site, device_type, name
    """, {f"t{n}": t for n, t in enumerate(types)})

    groups: dict[str, list[dict]] = {}
    for row in rows:
        row = dict(row)
        groups.setdefault(str(row["site"] or "Unassigned"), []).append(
            _profile(row, netmon_url))

    payload = {
        "Version": SCHEMA_VERSION,
        # NETworkManager writes its own backup timestamps; a generated file has
        # never been backed up, and claiming otherwise would be a lie it acts on.
        "LastBackup": None,
        "Groups": [
            {
                "Name": site,
                "Description": f"{len(profiles)} device(s) · generated from TCS NetMon",
                "Profiles": profiles,
            }
            for site, profiles in sorted(groups.items())
        ],
    }
    _assert_no_secrets(payload)
    return payload


def write_atomically(payload: dict, out: Path, mode: int = 0o640) -> None:
    """Write to a temp file in the destination directory, then rename.

    The destination is read by every technician's NETworkManager on a schedule
    nobody coordinates, so there must be no moment at which the file on the
    share is half a document. `os.replace` is atomic within a filesystem; the
    temp file is created in the same directory so it is the same filesystem.
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(out.parent), prefix=".netwm-", suffix=".json")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        # Before the rename, not after: a reader must never see it world-readable.
        os.chmod(tmp, mode)
        os.replace(tmp, out)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Generate a NETworkManager profile file from the NetMon registry.")
    p.add_argument("--config", default=None, help="NetMon config path (default $NETMON_CONF).")
    p.add_argument("--out", help="Write here (default: stdout).")
    p.add_argument("--types", default=",".join(DEFAULT_TYPES),
                   help=f"Device types to include, comma-separated, or 'all' "
                        f"(default: {','.join(DEFAULT_TYPES)}).")
    p.add_argument("--netmon-url", default="",
                   help="NetMon base URL, e.g. https://netmon.tcs.local — adds a "
                        "deep link back to each device's page in its description.")
    p.add_argument("--mode", default="640",
                   help="Octal mode for the output file (default 640).")
    p.add_argument("--dry-run", action="store_true",
                   help="Report what would be written and write nothing.")
    args = p.parse_args(argv)

    if args.types.strip().lower() == "all":
        types = ("switch", "ap", "camera", "recording_server", "trunk", "pbx", "other")
    else:
        types = tuple(t.strip() for t in args.types.split(",") if t.strip())
    if not types:
        p.error("--types selected nothing")

    try:
        cfg = load_config(args.config)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    engine = db.make_engine(cfg.db.url)
    try:
        payload = build(engine, types, args.netmon_url.strip())
    finally:
        engine.dispose()

    total = sum(len(g["Profiles"]) for g in payload["Groups"])
    if args.dry_run:
        print(f"{total} profile(s) in {len(payload['Groups'])} group(s), types: "
              f"{', '.join(types)}")
        for g in payload["Groups"]:
            print(f"  {g['Name']:<22} {len(g['Profiles']):>5}")
        print("(dry run — nothing written)")
        return 0

    if not args.out:
        json.dump(payload, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0

    out = Path(args.out)
    write_atomically(payload, out, mode=int(args.mode, 8))
    print(f"wrote {total} profile(s) in {len(payload['Groups'])} group(s) → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
