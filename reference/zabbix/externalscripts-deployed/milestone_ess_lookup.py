#!/usr/bin/env python3
"""
milestone_ess_lookup.py
-----------------------
One-shot diagnostic: fetch the ESS state snapshot for a known camera GUID
and print its full per-state-group record. Use this to identify which
event-type GUIDs represent "bad" states by looking at cameras you know
are in a particular state (offline, not recording, etc.).

The script also shows, for each state group this camera reports, what
OTHER type GUIDs exist in the same group across the whole install — so
you can see "this camera is in type X, but 2400 other cameras are in
type Y" at a glance, which is often enough to label X as the bad state
and Y as the good state.

Usage:
  ./milestone_ess_lookup.py HOST USER PASS CAMERA_GUID [--scheme https]

Example:
  ./milestone_ess_lookup.py milestone.example.com zbx_monitor 'pw' \\
      675d7926-ae4c-457a-b01d-ee38d22cd28b --scheme https

This script imports the fetcher from milestone_ess_state.py. Either put
both in the same directory or ensure milestone_ess_state.py is on the
Python path.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections import defaultdict

# Import the fetcher from the sibling module.
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

try:
    from milestone_ess_state import fetch_state, pivot_by_camera
except ImportError as e:
    print(f"cannot import milestone_ess_state: {e}\n"
          f"make sure milestone_ess_state.py is in {HERE}",
          file=sys.stderr)
    sys.exit(1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host")
    ap.add_argument("username")
    ap.add_argument("password")
    ap.add_argument("camera_guid")
    ap.add_argument("--scheme", default="https", choices=("http", "https"))
    ap.add_argument("--verify-tls", action="store_true")
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument("--client-id", default="GrantValidatorClient")
    ap.add_argument("--idp-path", default="/API/IDP/connect/token")
    ap.add_argument("--ws-path", default="/api/ws/events/v1")
    args = ap.parse_args()

    print(f"Fetching ESS snapshot (this takes a minute or two at large "
          f"camera counts)...", file=sys.stderr)

    state_resp = asyncio.run(fetch_state(
        host=args.host,
        username=args.username,
        password=args.password,
        scheme=args.scheme,
        verify_tls=args.verify_tls,
        timeout=args.timeout,
        client_id=args.client_id,
        idp_path=args.idp_path,
        ws_path=args.ws_path,
    ))

    pivoted = pivot_by_camera(state_resp)
    target = args.camera_guid.strip().lower()

    # Find the target camera (GUID compare is case-insensitive).
    found_key = None
    for k in pivoted:
        if k.lower() == target:
            found_key = k
            break

    if not found_key:
        print(f"\nCamera {args.camera_guid} NOT FOUND in the ESS snapshot.",
              file=sys.stderr)
        print(f"Total cameras in snapshot: {len(pivoted)}", file=sys.stderr)
        print("\nFirst 5 camera GUIDs in snapshot:", file=sys.stderr)
        for k in list(pivoted.keys())[:5]:
            print(f"  {k}", file=sys.stderr)
        return 1

    target_rec = pivoted[found_key]

    # For context, build a cross-install distribution per stategroup so
    # we can show "your camera reports X, these others report Y".
    group_type_counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for cam_guid, rec in pivoted.items():
        for grp, entry in rec.get("by_group", {}).items():
            t = entry.get("type") or ""
            group_type_counts[grp][t] += 1

    print("=" * 78)
    print(f"Camera:  {found_key}")
    print(f"Total state groups this camera reports into: "
          f"{len(target_rec['by_group'])}")
    print("=" * 78)

    for grp, entry in sorted(target_rec["by_group"].items()):
        this_type = entry.get("type") or ""
        this_time = entry.get("time") or ""
        distribution = group_type_counts[grp]
        this_count = distribution.get(this_type, 0)
        total_in_group = sum(distribution.values())

        print(f"\n  stategroup_id:  {grp}")
        print(f"  this camera's type:  {this_type}")
        print(f"  last state change:   {this_time}")
        print(f"  distribution across all cameras in this group "
              f"(total {total_in_group}):")

        # Sort by count descending so the majority type is at the top.
        ranked = sorted(distribution.items(), key=lambda kv: -kv[1])
        for t, n in ranked:
            marker = "  <- THIS CAMERA" if t == this_type else ""
            pct = n / total_in_group * 100 if total_in_group else 0.0
            print(f"       {n:>5} cameras ({pct:5.1f}%)  type={t}{marker}")

    print()
    print("Interpretation hint:")
    print("  If this camera is in a 'bad' state (offline / not recording /"
          " etc), then within each state group the type GUID marked")
    print("  '<- THIS CAMERA' represents that bad state for that group.")
    print("  The MAJORITY type (top of each distribution) is almost always")
    print("  the healthy state.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
