#!/usr/bin/env python3
"""
milestone_ess_resolve.py
------------------------
One-shot helper that takes the JSON output of
  `milestone_ess_state.py --list-stategroups`
(on stdin or as a file argument) and enriches every GUID with the human
name Milestone assigns to it, by querying the RESTful Config API's
eventTypes endpoint.

Use this after running --list-stategroups to turn raw GUIDs into
something you can reason about ("Communication" vs "Recording") and
pick the right values for the ESS macros.

Usage (two common shapes):

  # pipe from list-stategroups
  ./milestone_ess_state.py HOST USER PASS --list-stategroups \\
      | ./milestone_ess_resolve.py HOST USER PASS

  # or read from a saved file
  ./milestone_ess_state.py HOST USER PASS --list-stategroups > groups.json
  ./milestone_ess_resolve.py HOST USER PASS --input groups.json

Output: the same JSON with two new fields per pair:
  - stategroup_name       (best-effort human name for the group)
  - type_name             (human name for the specific event type)
"""
from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.parse
import urllib.request


def get_token(base: str, idp_path: str, user: str, password: str,
              client_id: str, ssl_ctx) -> str:
    body = urllib.parse.urlencode({
        "grant_type": "password",
        "username": user,
        "password": password,
        "client_id": client_id,
    }).encode()
    req = urllib.request.Request(
        base + idp_path,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, context=ssl_ctx, timeout=30) as resp:
        payload = json.loads(resp.read().decode())
    return payload["access_token"]


def get_all_event_types(base: str, token: str, ssl_ctx) -> list[dict]:
    """Paginate through /api/rest/v1/eventTypes and return all event-type records."""
    out: list[dict] = []
    page = 0
    while True:
        url = f"{base}/api/rest/v1/eventTypes?page={page}&size=2000"
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, context=ssl_ctx, timeout=60) as resp:
            payload = json.loads(resp.read().decode())
        arr = payload.get("array") or payload.get("data") or []
        if not arr:
            break
        out.extend(arr)
        # The API may or may not include _links.next; rely on length check.
        if len(arr) < 2000:
            break
        page += 1
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host")
    ap.add_argument("username")
    ap.add_argument("password")
    ap.add_argument("--scheme", default="https", choices=("http", "https"))
    ap.add_argument("--verify-tls", action="store_true")
    ap.add_argument("--client-id", default="GrantValidatorClient")
    ap.add_argument("--idp-path", default="/API/IDP/connect/token")
    ap.add_argument("--input", default=None,
                    help="Read --list-stategroups JSON from this file "
                         "(default: stdin)")
    args = ap.parse_args()

    # TLS
    if args.scheme == "https":
        ssl_ctx = ssl.create_default_context()
        if not args.verify_tls:
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE
    else:
        ssl_ctx = None

    # Read stategroups dump
    raw = open(args.input).read() if args.input else sys.stdin.read()
    groups_data = json.loads(raw)
    if "pairs" not in groups_data:
        print("input does not look like --list-stategroups output "
              "(no 'pairs' key)", file=sys.stderr)
        return 1

    base = f"{args.scheme}://{args.host}"
    token = get_token(base, args.idp_path, args.username, args.password,
                      args.client_id, ssl_ctx)
    event_types = get_all_event_types(base, token, ssl_ctx)

    # Build lookup: id -> (name, stategroupId, stategroupName)
    # The Config API returns records like:
    #   {"id": "<type-guid>", "name": "Communication Error",
    #    "stategroup": {"id": "<group-guid>", "name": "Communication"}}
    # Exact field shape varies across versions; tolerate both flat and nested.
    type_map: dict[str, dict] = {}
    group_map: dict[str, str] = {}
    for et in event_types:
        tid = et.get("id")
        if not tid:
            continue
        tname = et.get("name") or et.get("displayName") or ""
        # stategroup fields have varied across API versions
        sg = et.get("stategroup") or et.get("stateGroup") or {}
        if isinstance(sg, dict):
            sgid = sg.get("id", "")
            sgname = sg.get("name", "") or sg.get("displayName", "")
        else:
            sgid = et.get("stategroupId", "") or et.get("stategroupid", "")
            sgname = et.get("stategroupName", "")
        type_map[tid] = {
            "type_name": tname,
            "stategroup_id_from_config": sgid,
            "stategroup_name": sgname,
        }
        if sgid and sgname:
            group_map[sgid] = sgname

    # Enrich pairs
    for p in groups_data.get("pairs", []):
        tid = p.get("type")
        gid = p.get("stategroupid")
        tm = type_map.get(tid, {})
        p["type_name"] = tm.get("type_name", "(unknown)")
        p["stategroup_name"] = tm.get("stategroup_name") or group_map.get(gid, "(unknown)")

    groups_data["event_types_fetched"] = len(event_types)
    sys.stdout.write(json.dumps(groups_data, indent=2))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
