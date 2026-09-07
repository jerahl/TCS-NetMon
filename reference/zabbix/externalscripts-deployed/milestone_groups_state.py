#!/usr/bin/env python3
"""
milestone_groups_state.py
-------------------------
One-shot fetcher for Milestone XProtect *camera groups* (the logical
folders Smart Client uses to organise cameras into sites / buildings /
zones). One row per group, with the group's camera GUID list and a
de-duplicated parent-hardware GUID list so downstream consumers can
bucket cameras and devices by group in O(1).

Why this exists
    XProtect's organisational hierarchy is built on cameraGroups —
    every site / campus / building / floor users see in the Smart
    Client tree is a camera group. The Zabbix dashboard wants those
    groups as the "Site" axis instead of treating every Zabbix host as
    a site, so we pull /api/rest/v1/cameraGroups with the child cameras
    inlined and emit a snapshot keyed by group GUID.

    Doing this in a sibling script (rather than extending cameras_state.py)
    keeps responsibilities clear: cameras_state knows about hardware and
    cameras, groups_state knows about organisational folders. Both feed
    independent Zabbix items and refresh on their own cadence.

Output (default):
    JSON with this shape (mirrors the cameras_state.py file layout —
    a root-level by-GUID lookup plus an __array for LLD iteration):

        {
          "__count": N,
          "__fetched_at": "2026-04-29T12:34:56Z",
          "__array": [
              {
                  "id": "<group-guid>",
                  "name": "Bryant HS",
                  "description": "...",
                  "path": "Bryant HS",
                  "parentGroupId": null,
                  "cameraCount": 224,
                  "hardwareCount": 87,
                  "cameraIds": ["<cam-guid>", ...],
                  "hardwareIds": ["<hw-guid>", ...]
              },
              ...
          ],
          "<group-guid>": { ... same shape ... },
          ...
        }

    Per Plan v1.2 §A.5 the __-prefixed diagnostic keys (__count,
    __fetched_at, __array) can never collide with a real group GUID,
    so Zabbix can JSONPath-lookup any group at $["<guid>"] with no
    preprocessing required.

Usage:
    milestone_groups_state.py <host> <username> <password>
                              [--scheme https] [--verify-tls]
                              [--timeout 60] [--client-id GrantValidatorClient]
                              [--idp-path /IDP/connect/token]
                              [--api-base /api/rest/v1]
                              [--page-size 500]
                              [--no-cameras]

Exit codes:
    0  success (JSON on stdout)
    2  authentication failure
    3  HTTP / API error
    4  timeout
    1  other error

Requires: python3.8+ (urllib only — no third-party deps).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


# ---------------------------------------------------------------------------
# HTTP helpers (urllib only — same vocabulary as cameras_state.py so
# operators only have to learn one shape).
# ---------------------------------------------------------------------------
def _ssl_ctx(verify_tls: bool) -> ssl.SSLContext | None:
    ctx = ssl.create_default_context()
    if not verify_tls:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def get_token(base: str, idp_path: str, user: str, password: str,
              client_id: str, ctx: ssl.SSLContext | None,
              timeout: float) -> str:
    body = urllib.parse.urlencode({
        "grant_type": "password",
        "username": user,
        "password": password,
        "client_id": client_id,
    }).encode()
    req = urllib.request.Request(
        base + idp_path,
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        raise RuntimeError(f"IDP HTTP {e.code}: {body}") from None
    token = payload.get("access_token")
    if not token:
        raise RuntimeError(
            f"IDP response missing access_token: {str(payload)[:500]}"
        )
    return token


# ---------------------------------------------------------------------------
# Group fetching
#
# /api/rest/v1/cameraGroups returns the logical group hierarchy. With
# ?includeChildren=cameras every group record carries its direct camera
# children inline. Nested subgroups would normally appear under
# children.cameraGroups; we walk that tree depth-first so a flat output
# row exists for every group regardless of nesting depth.
# ---------------------------------------------------------------------------
def fetch_camera_groups(
    base: str, token: str, ctx: ssl.SSLContext | None,
    timeout: float, api_base: str, page_size: int,
    include_cameras: bool,
) -> list[dict]:
    """Page through /cameraGroups and return the raw records.

    Mirrors the fast-then-paginate strategy in cameras_state.py: one
    oversize page first, fall back to proper pagination on 4xx.
    """
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    children = "cameras,cameraGroups" if include_cameras else "cameraGroups"

    def _try_fast() -> list[dict] | None:
        url = (
            f"{base}{api_base}/cameraGroups"
            f"?includeChildren={children}&page=0&size=10000"
        )
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
                payload = json.loads(r.read().decode())
            arr = payload.get("array") or payload.get("data") or []
            return arr if isinstance(arr, list) else []
        except urllib.error.HTTPError as e:
            if e.code in (400, 404, 413, 414):
                return None
            body = e.read().decode(errors="replace")[:500]
            raise RuntimeError(f"cameraGroups HTTP {e.code}: {body}") from None

    arr = _try_fast()
    if arr is not None:
        return arr

    out: list[dict] = []
    page = 0
    while True:
        url = (
            f"{base}{api_base}/cameraGroups"
            f"?includeChildren={children}&page={page}&size={page_size}"
        )
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, context=ctx,
                                         timeout=timeout) as r:
                payload = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:500]
            raise RuntimeError(
                f"cameraGroups HTTP {e.code} on page {page}: {body}"
            ) from None
        arr_p = payload.get("array") or payload.get("data") or []
        if not arr_p:
            break
        out.extend(arr_p)
        if len(arr_p) < page_size:
            break
        page += 1
    return out


# ---------------------------------------------------------------------------
# Flatten the group tree
#
# A group in the API response has roughly:
#   { id, displayName / name, description,
#     children: { cameras: [...], cameraGroups: [...] }   (older shape)
#     cameras: [...], cameraGroups: [...]                  (newer shape)
#   }
#
# We walk depth-first, emitting one row per group with the cameras
# directly attached AT THAT LEVEL (we do NOT roll subgroup cameras up
# into the parent — operators should see "Bryant HS" with the cameras
# directly under it, and each child subgroup as its own row).
#
# If you want roll-up behaviour, do it downstream by walking parentGroupId.
# ---------------------------------------------------------------------------
def _kids(node: dict, key: str) -> list:
    """Get child list 'key' tolerantly: newer API exposes it flat, older
    nests it under .children. Always returns a list (possibly empty)."""
    v = node.get(key)
    if isinstance(v, list):
        return v
    children = node.get("children")
    if isinstance(children, dict):
        v2 = children.get(key)
        if isinstance(v2, list):
            return v2
    return []


def flatten_groups(
    root_groups: list[dict],
) -> list[dict]:
    """Walk the group tree, emit one flat row per group.

    Each row carries:
        id, name, description, path (slash-separated lineage),
        parentGroupId,
        cameraIds[], hardwareIds[] (deduped from this group's cameras),
        cameraCount, hardwareCount
    """
    out: list[dict] = []

    def visit(node: dict, parent_id: str | None, parent_path: str) -> None:
        if not isinstance(node, dict):
            return
        gid = node.get("id")
        if not gid:
            return
        name = (
            node.get("displayName")
            or node.get("name")
            or node.get("description")
            or gid
        )
        path = f"{parent_path}/{name}" if parent_path else name

        # Cameras directly under this group.
        cameras = _kids(node, "cameras")
        cam_ids: list[str] = []
        hw_ids: list[str] = []
        for cam in cameras:
            if not isinstance(cam, dict):
                continue
            cid = cam.get("id")
            if cid:
                cam_ids.append(cid)
            # Camera record carries its hardware via relations.parent.id;
            # tolerate the older flat 'parentId' shape too.
            rel = cam.get("relations") or {}
            parent = rel.get("parent") if isinstance(rel, dict) else None
            hwid = (
                parent.get("id") if isinstance(parent, dict) else None
            ) or cam.get("hardwareId") or cam.get("parentId")
            if hwid:
                hw_ids.append(hwid)

        # De-dup hardware ids (one hardware can host several cameras).
        hw_unique = list(dict.fromkeys(hw_ids))

        out.append({
            "id": gid,
            "name": name,
            "description": node.get("description") or "",
            "path": path,
            "parentGroupId": parent_id,
            "cameraCount": len(cam_ids),
            "hardwareCount": len(hw_unique),
            "cameraIds": cam_ids,
            "hardwareIds": hw_unique,
        })

        # Recurse into subgroups.
        for sub in _kids(node, "cameraGroups"):
            visit(sub, gid, path)

    for g in root_groups or []:
        visit(g, None, "")

    return out


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("host",
                    help="API Gateway host (no scheme), "
                         "e.g. milestone.example.com")
    ap.add_argument("username")
    ap.add_argument("password")
    ap.add_argument("--scheme", default="https",
                    choices=("http", "https"))
    ap.add_argument("--verify-tls", action="store_true",
                    help="Enforce TLS cert validation (default: off)")
    ap.add_argument("--timeout", type=float, default=60.0,
                    help="Per-request timeout in seconds (default: 60)")
    ap.add_argument("--client-id", default="GrantValidatorClient")
    ap.add_argument("--idp-path", default="/IDP/connect/token",
                    help="IDP token endpoint path. Default "
                         "/IDP/connect/token; some installs use "
                         "/API/IDP/connect/token.")
    ap.add_argument("--api-base", default="/api/rest/v1",
                    help="REST API base path (default /api/rest/v1)")
    ap.add_argument("--page-size", type=int, default=500,
                    help="Pagination page size for fallback path "
                         "(default 500)")
    ap.add_argument("--no-cameras", action="store_true",
                    help="Skip camera enumeration per group. Groups "
                         "still get a row with cameraCount=0; useful "
                         "for diagnosing just the group tree shape.")
    args = ap.parse_args()

    base = f"{args.scheme}://{args.host}"
    ctx = _ssl_ctx(args.verify_tls) if args.scheme == "https" else None

    # Step 1: token.
    try:
        token = get_token(
            base, args.idp_path, args.username, args.password,
            args.client_id, ctx, args.timeout,
        )
    except RuntimeError as e:
        msg = str(e)
        if any(s in msg for s in ("IDP HTTP 400", "IDP HTTP 401",
                                   "invalid_username_or_password",
                                   "LockedOut")):
            print(json.dumps({"error": "auth_failed", "detail": msg}),
                  file=sys.stderr)
            return 2
        print(json.dumps({"error": "idp_error", "detail": msg}),
              file=sys.stderr)
        return 3
    except urllib.error.URLError as e:
        print(json.dumps({"error": "network_error",
                          "detail": repr(e)}),
              file=sys.stderr)
        return 3
    except (TimeoutError, OSError) as e:
        print(json.dumps({"error": "timeout", "detail": repr(e)}),
              file=sys.stderr)
        return 4

    # Step 2: camera groups.
    try:
        groups_raw = fetch_camera_groups(
            base, token, ctx, args.timeout,
            args.api_base, args.page_size,
            include_cameras=not args.no_cameras,
        )
    except RuntimeError as e:
        print(json.dumps({"error": "api_error", "detail": str(e)}),
              file=sys.stderr)
        return 3
    except urllib.error.URLError as e:
        print(json.dumps({"error": "network_error",
                          "detail": repr(e)}),
              file=sys.stderr)
        return 3
    except (TimeoutError, OSError) as e:
        print(json.dumps({"error": "timeout", "detail": repr(e)}),
              file=sys.stderr)
        return 4
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "unexpected", "detail": repr(e)}),
              file=sys.stderr)
        return 1

    # Step 3: flatten the tree.
    flat = flatten_groups(groups_raw)
    keyed: dict[str, dict] = {row["id"]: row for row in flat}

    # Diagnostic top-level fields (same __-prefix convention as
    # cameras_state.py so they can never collide with a group GUID).
    out = {
        "__count": len(keyed),
        "__fetched_at": dt.datetime.now(dt.timezone.utc)
                          .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "__root_count": len(groups_raw),
        "__total_cameras": sum(r["cameraCount"] for r in flat),
        "__total_hardware": sum(r["hardwareCount"] for r in flat),
        "__array": flat,
    }
    out.update(keyed)

    sys.stdout.write(json.dumps(out, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
