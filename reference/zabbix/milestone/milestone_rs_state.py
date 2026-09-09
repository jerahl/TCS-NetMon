#!/usr/bin/env python3
"""Milestone XProtect Recording Server state collector.

Fetches per-RS service state, camera / hardware counts, and storage
configuration from the Milestone API Gateway REST API. Writes a JSON
snapshot to /var/lib/zabbix/milestone_rs_state.json keyed by RS GUID
(top-level) plus a flat __array list for Zabbix LLD — same shape as
milestone_cameras_state.py / milestone_groups_state.py.

The top-level GUID keys are what makes JSONPath $["{#RS.ID}"] work in
the per-RS dependent items; the milestone_groups_state.py snapshot in
the field only emits __array, which is what was breaking the Sites tab
labels (the per-group dependent items returned blank because their
master's $["<id>"] resolved to nothing). This script follows the
cameras-snapshot shape on purpose.

Usage:
  milestone_rs_state.py HOST USER PASSWORD [--scheme https]
                                           [--client-id GrantValidatorClient]
                                           [--out /path/to/snapshot.json]
                                           [--log /path/to/log]
                                           [--timeout 30]
                                           [--insecure]

Run by milestone_rs_refresh.sh on cron (every 15 min recommended).
The Zabbix EXTERNAL item milestone_rs_read.sh[3600] cats the file
on each poll, with a staleness check.

REST endpoints used (Milestone API Gateway /api/rest/v1):
  GET /recordingServers?disabled&includeChildren=storages,hardware,cameras
                                                 (one-shot pull of every RS,
                                                  its storages config, the
                                                  hardware list, and each
                                                  hardware's cameras — was
                                                  1 + N(RS) + N(RS)·M(HW)
                                                  round trips, now one)
  GET /storageInformation/{id}                   (live usedSpace + mount state
                                                  per storage; not available via
                                                  includeChildren on /storages)
"""

import argparse
import fcntl
import json
import logging
import os
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote, urljoin

OUT_DEFAULT  = "/var/lib/zabbix/milestone_rs_state.json"
LOG_DEFAULT  = "/var/log/zabbix/milestone_rs_state.log"
LOCK_DEFAULT = "/var/lock/milestone_rs_state.lock"


def parse_args():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("host")
    p.add_argument("user")
    p.add_argument("password")
    p.add_argument("--scheme", default="https", choices=["http", "https"])
    p.add_argument("--client-id", default="GrantValidatorClient")
    p.add_argument("--out", default=OUT_DEFAULT)
    p.add_argument("--log", default=LOG_DEFAULT)
    p.add_argument("--lock", default=LOCK_DEFAULT)
    p.add_argument("--timeout", type=int, default=30)
    p.add_argument("--insecure", action="store_true",
                   help="Skip TLS verification (self-signed API Gateway).")
    return p.parse_args()


def get_token(base, user, password, client_id, ctx, timeout):
    body = ("grant_type=password"
            f"&username={quote(user)}"
            f"&password={quote(password)}"
            f"&client_id={quote(client_id)}").encode()
    req = urllib.request.Request(
        f"{base}/IDP/connect/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        data = json.loads(r.read())
    tok = data.get("access_token")
    if not tok:
        raise RuntimeError(f"IDP returned no access_token: {data}")
    return tok


def api_get(base, token, path, ctx, timeout):
    req = urllib.request.Request(
        urljoin(base, path),
        headers={"Authorization": f"Bearer {token}",
                 "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return json.loads(r.read())


def _as_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


# Size fields on /storages and /storageInformation are documented in MB
# (see the OpenAPI spec's storages.maxSize and storageInformation.usedSpace).
# Snapshot exposes bytes so the dashboard can format TB/GB without converting.
_MB = 1024 * 1024


def _collect_storage_info(base, token, ctx, timeout, sid):
    """Fetch live usage + mount state for one storage via /storageInformation/{id}.

    Returns ({}, error_msg) on failure so the caller can fall through to
    zero-usage without losing the snapshot. storageInformation isn't a
    valid includeChildren target on /storages (per the OpenAPI spec
    storageInformation is a sibling top-level resource, not a child of
    storages), so this is a separate call per storage. Total storages
    across a fleet is typically tiny (1-3 per RS), so the cost is bounded.
    """
    try:
        si = api_get(base, token,
                     f"/api/rest/v1/storageInformation/{sid}",
                     ctx, timeout)
        return si, None
    except Exception as e:  # noqa: BLE001
        return {}, str(e)


def _normalize_storages(storages_raw, base, token, ctx, timeout, rs_id):
    """Turn the /storages array (with embedded /storageInformation per row)
    into the snapshot's storages list. Pulls /storageInformation per storage
    for live usedSpace / lockedUsedSpace / isMounted / isAvailable, which
    aren't exposed on /storages itself."""
    out = []
    for s in (storages_raw or []):
        sid = s.get("id")
        # Configured capacity from /storages.maxSize (MB per spec).
        # Older API versions returned 'size' — keep that as a fallback.
        max_mb = _as_int(s.get("maxSize")) or _as_int(s.get("size"))
        size_bytes = max_mb * _MB

        used_bytes = 0
        locked_bytes = 0
        is_mounted = None
        is_available = None
        if sid:
            si, err = _collect_storage_info(base, token, ctx, timeout, sid)
            if err:
                logging.warning("storageInformation fetch failed for "
                                "storage %s on RS %s: %s", sid, rs_id, err)
            else:
                used_bytes   = _as_int(si.get("usedSpace")) * _MB
                locked_bytes = _as_int(si.get("lockedUsedSpace")) * _MB
                is_mounted   = si.get("isMounted")
                is_available = si.get("isAvailable")

        out.append({
            "id":               sid,
            "name":             s.get("name") or s.get("displayName") or "",
            "path":             s.get("diskPath") or s.get("path") or "",
            "sizeBytes":        size_bytes,
            "usedBytes":        used_bytes,
            "lockedUsedBytes":  locked_bytes,
            "isMounted":        is_mounted,
            "isAvailable":      is_available,
            "retentionMinutes": _as_int(s.get("retainMinutes")),
            "default":          bool(s.get("isDefault", False)),
        })
    return out


def collect_rs(rs, base, token, ctx, timeout):
    """Return the per-RS record dict (augmented with storages + counts).

    Expects the top-level call to have already populated rs['storages']
    and rs['hardware'] (with each hardware carrying nested 'cameras')
    via includeChildren. Falls back to direct subpath fetches if any of
    them are missing — covers older API versions that didn't propagate
    nested includes.
    """
    rs_id = rs.get("id")

    # Storages — prefer the embedded copy from the top-level call. Fall
    # back to a direct fetch if it wasn't included.
    storages_raw = rs.get("storages")
    if not isinstance(storages_raw, list):
        try:
            sr = api_get(base, token,
                         f"/api/rest/v1/recordingServers/{rs_id}/storages",
                         ctx, timeout)
            storages_raw = sr.get("array", []) or []
        except Exception as e:
            logging.warning("storages fetch failed for RS %s: %s", rs_id, e)
            storages_raw = []
    storages = _normalize_storages(storages_raw, base, token, ctx, timeout, rs_id)

    # Hardware + cameras — prefer embedded. /recordingServers?include
    # Children=hardware,cameras yields each hardware with a nested
    # 'cameras' array, so counting is a walk through the embedded data
    # without any per-hardware round-trips.
    hw_arr = rs.get("hardware") if isinstance(rs.get("hardware"), list) else None
    if hw_arr is None:
        try:
            hr = api_get(
                base, token,
                f"/api/rest/v1/recordingServers/{rs_id}/hardware"
                f"?includeChildren=cameras",
                ctx, timeout)
            hw_arr = hr.get("array", []) or []
        except Exception as e:
            logging.warning("hardware fetch failed for RS %s: %s", rs_id, e)
            hw_arr = []

    hw_count  = len(hw_arr)
    cam_count = 0
    for hw in hw_arr:
        cams = hw.get("cameras")
        if isinstance(cams, list):
            cam_count += len(cams)
        else:
            # includeChildren=cameras wasn't honoured by this API version
            # for the embedded hardware — fall back to a direct fetch.
            hw_id = hw.get("id")
            if not hw_id:
                continue
            try:
                ch = api_get(base, token,
                             f"/api/rest/v1/hardware/{hw_id}/cameras",
                             ctx, timeout)
                cam_count += len(ch.get("array", []) or [])
            except Exception as e:
                logging.warning("camera count fetch failed for HW %s: %s",
                                hw_id, e)

    size_total   = sum(s["sizeBytes"]       for s in storages)
    used_total   = sum(s["usedBytes"]       for s in storages)
    locked_total = sum(s["lockedUsedBytes"] for s in storages)
    retentions = [s["retentionMinutes"] for s in storages
                  if s["retentionMinutes"] > 0]
    retention_min = min(retentions) if retentions else 0

    return {
        "id":                          rs_id,
        "displayName":                 rs.get("displayName") or rs.get("name") or "",
        "hostName":                    rs.get("hostName") or "",
        "version":                     rs.get("version") or "",
        "enabled":                     rs.get("enabled"),
        "lastStatusHandshake":         rs.get("lastStatusHandshake") or "",
        # Milestone REST exposes the runtime state under different field
        # names depending on API version — take the first non-empty.
        "state":                       (rs.get("state")
                                        or rs.get("serviceState")
                                        or rs.get("recorderState")
                                        or ""),
        "cameraCount":                 cam_count,
        "hardwareCount":               hw_count,
        "storageTotalBytes":           size_total,
        "storageUsedBytes":            used_total,
        "storageLockedBytes":          locked_total,
        "storageRetentionMinutesMin":  retention_min,
        "storages":                    storages,
    }


def collect(host, user, password, scheme, client_id, timeout, insecure):
    base = f"{scheme}://{host}"
    ctx = ssl.create_default_context()
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode    = ssl.CERT_NONE

    token = get_token(base, user, password, client_id, ctx, timeout)

    # One round-trip pulls every RS, their storages config, all parent
    # hardware, and (transitively) the cameras under each hardware. If the
    # server rejects the deep include (older API versions, or a quirk where
    # only single-level children are honoured), fall back to the flat RS
    # list — collect_rs handles the missing-child case by sub-fetching.
    deep_url = ("/api/rest/v1/recordingServers"
                "?disabled&includeChildren=storages,hardware,cameras")
    try:
        rs_resp = api_get(base, token, deep_url, ctx, timeout)
    except Exception as e:
        logging.warning("deep includeChildren rejected (%s); "
                        "falling back to flat /recordingServers list", e)
        rs_resp = api_get(base, token,
                          "/api/rest/v1/recordingServers?disabled",
                          ctx, timeout)
    rs_list = rs_resp.get("array", []) or []

    out_array     = []
    out_keyed     = {}
    storages_flat = []

    for rs in rs_list:
        if not rs.get("id"):
            continue
        rec = collect_rs(rs, base, token, ctx, timeout)
        out_array.append(rec)
        out_keyed[rec["id"]] = rec
        for s in rec["storages"]:
            storages_flat.append({
                "rsId":             rec["id"],
                "rsName":           rec["displayName"],
                "id":               s["id"],
                "name":             s["name"],
                "path":             s["path"],
                "sizeBytes":        s["sizeBytes"],
                "usedBytes":        s["usedBytes"],
                "lockedUsedBytes":  s["lockedUsedBytes"],
                "isMounted":        s["isMounted"],
                "isAvailable":      s["isAvailable"],
                "retentionMinutes": s["retentionMinutes"],
                "default":          s["default"],
            })

    snapshot = dict(out_keyed)
    snapshot["__count"]       = len(out_array)
    snapshot["__fetched_at"]  = datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    snapshot["__endpoint"]    = "recordingServers"
    snapshot["__array"]       = out_array
    snapshot["__storages"]    = storages_flat
    snapshot["__total_storages"] = len(storages_flat)
    return snapshot


def main():
    args = parse_args()
    os.makedirs(os.path.dirname(args.log) or ".", exist_ok=True)
    logging.basicConfig(
        filename=args.log,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    os.makedirs(os.path.dirname(args.lock) or ".", exist_ok=True)
    lock_f = open(args.lock, "w")
    try:
        fcntl.flock(lock_f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        logging.info("another instance is running, exiting")
        return 0

    t0 = time.time()
    try:
        snap = collect(args.host, args.user, args.password, args.scheme,
                       args.client_id, args.timeout, args.insecure)
    except Exception as e:
        logging.exception("collection failed")
        snap = {
            "error":         str(e),
            "__fetched_at":  datetime.now(timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"),
            "__array":       [],
            "__storages":    [],
            "__count":       0,
        }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(args.out),
                               prefix=".rs_state.")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(snap, f)
        os.replace(tmp, args.out)
    except Exception:
        os.unlink(tmp)
        raise

    logging.info("wrote %s with %d RS rows, %d storages in %.1fs",
                 args.out,
                 snap.get("__count", 0),
                 snap.get("__total_storages", 0),
                 time.time() - t0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
