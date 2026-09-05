#!/usr/bin/env python3
"""Down-device snapshot — a baseline you can diff before/after an intervention.

Written for a PoE-cycling weekend: run it before, run it after, compare the
same numbers computed the same way. Reading the counts off a dashboard twice
invites comparing two different definitions of "down".

The headline number is **down_confirmed** — devices both the source platform and
ICMP agree are unreachable. That is the population a power cycle can plausibly
fix, and the one worth judging the exercise by.

`down_network_only` is reported but deliberately kept out of the headline. For
cameras it is dominated by models that never answer ICMP while Milestone reports
them recording (spec 19 §7), so it does not mean "broken" and will not improve
with a power cycle. Counting it would make the before/after look worse than it
is, then look unchanged.

Read-only. Reads NetMon's DB; queries no source.

Usage:
    python scripts/down_snapshot.py                 # human-readable
    python scripts/down_snapshot.py --json          # for diffing
    python scripts/down_snapshot.py --save baseline.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from netmon import db                       # noqa: E402
from netmon.config import load_config       # noqa: E402

TYPES = ("camera", "ap", "switch", "recording_server")
TIERS = ("down_confirmed", "down_source_only", "down_network_only", "up", "unknown")


def collect(engine) -> dict:
    tiers: dict[str, dict[str, int]] = {}
    for r in db.fetch_all(engine, """
        SELECT s.value AS tier, d.device_type AS dt, COUNT(*) AS n
        FROM device_state s JOIN devices d ON d.id = s.device_id
        WHERE s.dimension = 'reachability' GROUP BY 1, 2"""):
        tiers.setdefault(r["tier"], {})[r["dt"]] = r["n"]

    totals = {r["device_type"]: r["n"] for r in db.fetch_all(engine, """
        SELECT device_type, COUNT(*) AS n FROM devices WHERE enabled = 1
        GROUP BY device_type""")}

    probes: dict[str, dict[str, int]] = {}
    for r in db.fetch_all(engine, """
        SELECT d.device_type AS dt, s.dimension AS dim, s.value AS val, COUNT(*) AS n
        FROM device_state s JOIN devices d ON d.id = s.device_id
        WHERE s.dimension IN ('ping', 'source_status') AND s.value IN ('down', 'blind')
        GROUP BY 1, 2, 3"""):
        probes.setdefault(r["dt"], {})[f"{r['dim']}_{r['val']}"] = r["n"]

    # Named devices in the headline tier, so the after-run can show which
    # recovered rather than only that the count moved.
    named = [f'{r["device_type"]}:{r["name"]}' for r in db.fetch_all(engine, """
        SELECT d.name, d.device_type FROM device_state s
        JOIN devices d ON d.id = s.device_id
        WHERE s.dimension = 'reachability' AND s.value = 'down_confirmed'
        ORDER BY d.device_type, d.name""")]

    return {"generated_at": datetime.now(timezone.utc).isoformat(),
            "tiers": tiers, "totals": totals, "probes": probes,
            "down_confirmed_devices": named}


def render(snap: dict) -> None:
    t = snap["tiers"]
    print(f"Down-device snapshot — {snap['generated_at'][:16].replace('T', ' ')} UTC\n")
    print(f"{'tier':<20} {'camera':>8} {'ap':>8} {'switch':>8} {'rec srv':>9}")
    print("-" * 57)
    for tier in TIERS:
        v = t.get(tier, {})
        mark = "  <-- headline" if tier == "down_confirmed" else ""
        print(f"{tier:<20} {v.get('camera',0):>8} {v.get('ap',0):>8} "
              f"{v.get('switch',0):>8} {v.get('recording_server',0):>9}{mark}")
    print("-" * 57)
    tot = snap["totals"]
    print(f"{'enabled':<20} {tot.get('camera',0):>8} {tot.get('ap',0):>8} "
          f"{tot.get('switch',0):>8} {tot.get('recording_server',0):>9}")

    dc = t.get("down_confirmed", {})
    ds = t.get("down_source_only", {})
    print(f"\nHEADLINE — both probes agree unreachable: "
          f"{dc.get('camera',0)} cameras, {dc.get('ap',0)} APs")
    print(f"Secondary — platform cannot reach, network can: "
          f"{ds.get('camera',0)} cameras, {ds.get('ap',0)} APs")

    print("\nRaw probe counts (for reference, not the headline):")
    for dt in ("camera", "ap"):
        p = snap["probes"].get(dt, {})
        bits = ", ".join(f"{k}={v}" for k, v in sorted(p.items()))
        print(f"   {dt:<8} {bits or '—'}")

    print("""
Reading this after the intervention:

  * Compare **down_confirmed** first. It is the population a power cycle can
    plausibly fix, and both probes have to agree before a device lands in it.
  * **down_network_only** for cameras is not a fault count. It is dominated by
    models that never answer ICMP while Milestone reports them recording, so it
    will not improve with a power cycle and should not be read as failure.
  * Cameras with `source_status = blind` have no Milestone verdict at all —
    counted separately, never as down.
  * The numbers move between polls: ICMP every 60 s, Milestone every 120 s. Take
    the "after" reading once both have completed a cycle post-reboot, or devices
    still coming up will read as down.""")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--save", metavar="PATH", help="write the JSON snapshot to a file")
    args = ap.parse_args(argv)

    engine = db.make_engine(load_config().db.url)
    snap = collect(engine)
    if args.save:
        Path(args.save).write_text(json.dumps(snap, indent=2))
        print(f"saved {args.save}")
    if args.json:
        print(json.dumps(snap, indent=2))
    elif not args.save:
        render(snap)
    return 0


if __name__ == "__main__":       # pragma: no cover
    sys.exit(main())
