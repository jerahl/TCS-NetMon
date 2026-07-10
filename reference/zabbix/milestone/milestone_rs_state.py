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
  GET /recordingServers                          (list + state + version)
  GET /recordingServers/{id}/storages            (per-RS storage config)
  GET /recordingServers/{id}/hardware            (parent-hardware list)
  GET /hardware/{id}/cameras                     (cameras under hardware)
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


def collect_rs(rs, base, token, ctx, timeout):
    """Return the per-RS record dict (augmented with storages + counts)."""
    rs_id = rs.get("id")

    # Storages on this RS — drives the Storage tab and Sites-row storage bar.
    storages = []
    try:
        sr = api_get(base, token,
                     f"/api/rest/v1/recordingServers/{rs_id}/storages",
                     ctx, timeout)
        for s in (sr.get("array", []) or []):
            storages.append({
                "id":               s.get("id"),
                "name":             s.get("name") or s.get("displayName") or "",
                "path":             s.get("path") or "",
                "sizeBytes":        _as_int(s.get("size")),
                "usedBytes":        _as_int(s.get("usedSpace")),
                "retentionMinutes": _as_int(s.get("retainMinutes")),
                "default":          bool(s.get("isDefault", False)),
            })
    except Exception as e:
        logging.warning("storages fetch failed for RS %s: %s", rs_id, e)

    # Hardware + cameras. /hardware/{id}/cameras avoids a flat /cameras call
    # at sites with thousands of cameras (the cameras snapshot covers that).
    # Here we only want the count rolled up by RS so the dashboard can show
    # "RS hosts N cameras" without re-walking the full cameras snapshot.
    hw_count  = 0
    cam_count = 0
    try:
        hr = api_get(base, token,
                     f"/api/rest/v1/recordingServers/{rs_id}/hardware",
                     ctx, timeout)
        hw_arr = hr.get("array", []) or []
        hw_count = len(hw_arr)
        for hw in hw_arr:
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
    except Exception as e:
        logging.warning("hardware fetch failed for RS %s: %s", rs_id, e)

    size_total = sum(s["sizeBytes"] for s in storages)
    used_total = sum(s["usedBytes"] for s in storages)
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
    rs_resp = api_get(base, token,
                      "/api/rest/v1/recordingServers?disabled", ctx, timeout)
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
