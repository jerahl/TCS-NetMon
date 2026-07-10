#!/usr/bin/env python3
"""
milestone_cameras_state.py
--------------------------
One-shot fetcher for Milestone XProtect cameras with their parent
hardware data (most importantly, the IP/network address).

Why this script exists:
    The cameras returned by /api/rest/v1/cameras don't carry the IP
    address — that lives on the parent hardware object. Per Milestone
    engineering guidance on the developer forum, the recommended bulk
    pattern is:
        GET /api/rest/v1/hardware?includeChildren=cameras
    which returns every hardware record together with its child
    cameras in a single call. We then flatten that tree into a flat
    list of camera records, each carrying its parent hardware's
    address/name/id/model.

    Doing this in Python (rather than a Zabbix Script item with JS) gives:
      - structured logging
      - testability with --dry-run
      - graceful handling of paginated responses
      - URL-to-IP normalisation in real Python rather than embedded JS
      - identical operational pattern (refresh.sh writes file,
        read.sh cats file) as milestone_ess_state.py

Output (default):
    JSON keyed by camera GUID:
        {
          "count": N,
          "fetched_at": "2026-04-29T12:34:56Z",
          "cameras": {
              "<camera-guid>": {
                  "id": "<camera-guid>",
                  "displayName": "Front door cam",
                  "enabled": true,
                  "address": "10.172.18.79",            # bare host
                  "mac": "00:40:8C:F3:46:C9",           # normalized
                  "macRaw": "00408CF346C9",             # as Milestone stores it
                  "hardwareId": "<hw-guid>",
                  "hardwareName": "AXIS-encoder-01",
                  "hardwareModel": "AXIS Q7411",
                  "recordingServerId": "<rs-guid>",     # grandparent RS
                  "relations": {...},                    # full original record
                  ...
              },
              ...
          }
        }

The MAC address lives on the parent hardware as a "hardware setting" named
MacAddress, not as a top-level hardware property. We try to pull it inline
via includeChildren=cameras,settings; if the API version doesn't expose it
that way, we fall back to per-hardware GET /hardware/{id}/settings calls,
parallelized with a small thread pool. Use --no-mac to skip MAC enrichment
entirely if the extra round-trips are unwelcome.

The recordingServerId is the camera's grandparent in the XProtect tree
(ManagementServer > RecordingServer > Hardware > Camera). Neither the camera
nor its hardware record exposes it directly, so we build a hardware->RS map
from /recordingServers/{id}/hardware (the same walk milestone_rs_state.py
uses) and stamp each camera from its hardwareId. Use --no-rs-map to skip the
extra calls (recordingServerId stays empty; the dashboard's per-camera
Recording server field then shows "—").

Usage:
    milestone_cameras_state.py <host> <username> <password>
                              [--scheme https] [--verify-tls]
                              [--timeout 60] [--client-id GrantValidatorClient]
                              [--idp-path /IDP/connect/token]
                              [--api-base /api/rest/v1]
                              [--page-size 500]
                              [--no-mac] [--mac-workers 8] [--no-rs-map]

Exit codes:
    0  success (JSON on stdout)
    2  authentication failure
    3  HTTP / API error
    4  timeout
    1  other error

Requires: python3.8+ (uses urllib only; no third-party deps).
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
from typing import Any


# ---------------------------------------------------------------------------
# Address normalisation
#
# Milestone returns hardware.address as a URL like "http://10.172.18.79/".
# Zabbix ICMP needs a bare host, so strip the scheme/path/port here once.
# ---------------------------------------------------------------------------
def bare_host(value: str | None) -> str:
    """Strip scheme, path, and port from a URL-shaped address.

    Examples:
        http://10.172.18.79/             -> 10.172.18.79
        https://cam-01.example.com:8080/ -> cam-01.example.com
        https://[2001:db8::1]:443/       -> 2001:db8::1
        10.172.18.79                     -> 10.172.18.79
        ''                               -> ''
        None                             -> ''
    """
    if not value:
        return ""
    s = str(value).strip()
    # Drop scheme.
    i = s.find("://")
    if i != -1:
        s = s[i + 3:]
    # Drop trailing slash and anything after it.
    j = s.find("/")
    if j != -1:
        s = s[:j]
    # IPv6 literals are wrapped in [...]
    if s.startswith("["):
        k = s.find("]")
        if k != -1:
            return s[1:k]
        return s
    # Drop port.
    p = s.find(":")
    if p != -1:
        s = s[:p]
    return s


# ---------------------------------------------------------------------------
# MAC normalisation
#
# Milestone's hardware "MacAddress" setting is sometimes 12 raw hex chars
# ("00408CF346C9"), sometimes already colon-separated, sometimes hyphen-
# separated, occasionally lowercase, and not infrequently empty (cameras
# behind encoders that the recording server never enumerated, ONVIF
# devices the driver couldn't probe, etc.). Normalise to canonical
# "AA:BB:CC:DD:EE:FF" form so downstream consumers (Zabbix items,
# alerting, inventory) compare cleanly.
# ---------------------------------------------------------------------------
def mac_norm(value: str | None) -> str:
    """Normalize a MAC string to colon-separated uppercase form.

    Returns '' for None, empty, all-zero, or anything that doesn't yield
    exactly 12 hex digits after stripping separators.

    Examples:
        '00408CF346C9'        -> '00:40:8C:F3:46:C9'
        '00:40:8c:f3:46:c9'   -> '00:40:8C:F3:46:C9'
        '00-40-8C-F3-46-C9'   -> '00:40:8C:F3:46:C9'
        '00.40.8c.f3.46.c9'   -> '00:40:8C:F3:46:C9'
        '000000000000'        -> ''   (all-zero is "no MAC")
        ''                    -> ''
        None                  -> ''
        'garbage'             -> ''
    """
    if not value:
        return ""
    hexchars = "".join(c for c in str(value) if c.isalnum()).upper()
    if len(hexchars) != 12:
        return ""
    if not all(c in "0123456789ABCDEF" for c in hexchars):
        return ""
    if hexchars == "0" * 12:
        return ""
    return ":".join(hexchars[i:i + 2] for i in range(0, 12, 2))


# ---------------------------------------------------------------------------
# HTTP helpers (urllib only — no aiohttp/requests dependency)
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


def _http_get_json(
    url: str, token: str, ctx: ssl.SSLContext | None, timeout: float,
) -> dict:
    """Tiny GET wrapper that returns parsed JSON or raises on HTTP error."""
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
        return json.loads(r.read().decode())


# ---------------------------------------------------------------------------
# Camera-group name map
#
# The dashboard's Cameras tab buckets cameras under their Milestone group
# (the Smart-Client folder tree). The groups snapshot already covers this,
# but a stripped/stale groups reader leaves the dashboard with no camera→
# group mapping at all. Walking /cameraGroups here gives the cameras
# snapshot its own copy of the membership, so the dashboard has a second
# independent path that survives a broken groups reader.
# ---------------------------------------------------------------------------
def fetch_camera_groupname_map(
    base: str, token: str, ctx: ssl.SSLContext | None,
    timeout: float, api_base: str,
) -> dict[str, str]:
    """Return {camera-guid: group-display-name}. Empty on any error."""
    out: dict[str, str] = {}
    try:
        gr = _http_get_json(f"{base}{api_base}/cameraGroups", token, ctx, timeout)
    except Exception as e:  # noqa: BLE001
        print(f"[grpmap] cameraGroups fetch failed: {e}", file=sys.stderr)
        return out
    groups = gr.get("array") or gr.get("data") or []
    for g in groups:
        if not isinstance(g, dict):
            continue
        gid = g.get("id")
        if not gid:
            continue
        gname = (g.get("displayName") or g.get("name")
                 or g.get("description") or str(gid))
        try:
            ch = _http_get_json(
                f"{base}{api_base}/cameraGroups/{gid}/cameras",
                token, ctx, timeout)
        except Exception as e:  # noqa: BLE001
            print(f"[grpmap] cameras fetch failed for grp {gid}: {e}",
                  file=sys.stderr)
            continue
        for c in (ch.get("array") or ch.get("data") or []):
            cid = c.get("id") if isinstance(c, dict) else None
            # First group claiming a camera wins (Milestone groups are
            # effectively exclusive at the leaf folder).
            if cid and cid not in out:
                out[cid] = gname
    return out


# ---------------------------------------------------------------------------
# Recording-server map
#
# A camera's relations.parent is its hardware; the recording server is the
# grandparent (ManagementServer > RecordingServer > Hardware > Camera) and
# isn't exposed on the camera or hardware record. Walk the RS endpoints —
# the authoritative source, same as milestone_rs_state.py — to build a
# hardware GUID -> recording-server GUID map so flatten can stamp each camera.
# ---------------------------------------------------------------------------
def fetch_hardware_recordingserver_map(
    base: str, token: str, ctx: ssl.SSLContext | None,
    timeout: float, api_base: str,
) -> dict[str, str]:
    """Return {hardware-guid: recording-server-guid}.

    Returns {} (and logs to stderr) on any error so a failure here just
    leaves recordingServerId empty rather than killing the whole snapshot.
    """
    out: dict[str, str] = {}
    try:
        rs_resp = _http_get_json(
            f"{base}{api_base}/recordingServers", token, ctx, timeout)
    except Exception as e:  # noqa: BLE001
        print(f"[rsid] recordingServers fetch failed: {e}", file=sys.stderr)
        return out
    rs_list = rs_resp.get("array") or rs_resp.get("data") or []
    for rs in rs_list:
        rs_id = rs.get("id") if isinstance(rs, dict) else None
        if not rs_id:
            continue
        try:
            hw_resp = _http_get_json(
                f"{base}{api_base}/recordingServers/{rs_id}/hardware",
                token, ctx, timeout)
        except Exception as e:  # noqa: BLE001
            print(f"[rsid] hardware fetch failed for RS {rs_id}: {e}",
                  file=sys.stderr)
            continue
        for hw in (hw_resp.get("array") or hw_resp.get("data") or []):
            hwid = hw.get("id") if isinstance(hw, dict) else None
            if hwid:
                out[hwid] = rs_id
    return out


def fetch_hardware_with_cameras(
    base: str, token: str, ctx: ssl.SSLContext | None,
    timeout: float, api_base: str, page_size: int,
    include_settings: bool = True,
) -> list[dict]:
    """Page through /hardware?includeChildren=cameras and return all records.

    The API paginates at 500 by default; we honor that and follow pages.
    We also try a single oversize page first (size=10000) which works on
    most installs and avoids N round-trips. If it errors with 400/4xx, we
    fall back to proper pagination.

    If include_settings is True we ask for cameras+settings inline; some
    API versions accept this and we get MAC addresses for free. If the
    server rejects 'settings' as an unknown child type (older releases),
    we transparently retry with cameras-only and the MAC enrichment
    pass picks up the slack.
    """
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }

    # Build the includeChildren value. We try with settings first, and
    # if the server complains we retry without. Across API versions the
    # MAC has been exposed under different child names — "settings",
    # "hardwareSettings", and (canonically, per the REST docs)
    # "hardwareDriverSettings". Unknown ones cause a 404 from at least
    # one version, so the caller's _try_fast/_paginate fallback handles
    # that by retrying with cameras-only.
    if include_settings:
        children_param = "cameras,hardwareDriverSettings"
    else:
        children_param = "cameras"

    def _try_fast(children: str) -> list[dict] | None:
        """Single big-page request. Returns None if 4xx so caller can retry."""
        url = (
            f"{base}{api_base}/hardware"
            f"?disabled&includeChildren={children}&page=0&size=10000"
        )
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
                payload = json.loads(r.read().decode())
            arr = payload.get("array") or payload.get("data") or []
            return arr if isinstance(arr, list) else []
        except urllib.error.HTTPError as e:
            if e.code in (400, 404, 413, 414):
                return None  # fall back to pagination, possibly w/o settings
            body = e.read().decode(errors="replace")[:500]
            raise RuntimeError(f"hardware HTTP {e.code}: {body}") from None

    # Try the fast path with settings, then without, then paginate.
    arr = _try_fast(children_param)
    if arr is None and include_settings:
        # Server rejected the with-settings request — retry without.
        arr = _try_fast("cameras")
    if arr is not None:
        return arr

    # Paginated path. Same fallback dance for the children param.
    def _paginate(children: str) -> list[dict]:
        out: list[dict] = []
        page = 0
        while True:
            url = (
                f"{base}{api_base}/hardware"
                f"?disabled&includeChildren={children}"
                f"&page={page}&size={page_size}"
            )
            req = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(req, context=ctx,
                                             timeout=timeout) as r:
                    payload = json.loads(r.read().decode())
            except urllib.error.HTTPError as e:
                body = e.read().decode(errors="replace")[:500]
                # On the very first page, a 400 or 404 may mean the
                # children param is unsupported; bubble up so caller
                # can retry with cameras-only.
                if e.code in (400, 404, 413, 414) and page == 0:
                    raise _BadChildrenParam() from None
                raise RuntimeError(
                    f"hardware HTTP {e.code} on page {page}: {body}"
                ) from None
            arr_p = payload.get("array") or payload.get("data") or []
            if not arr_p:
                break
            out.extend(arr_p)
            if len(arr_p) < page_size:
                break
            page += 1
        return out

    try:
        return _paginate(children_param)
    except _BadChildrenParam:
        if include_settings:
            return _paginate("cameras")
        raise RuntimeError(
            "hardware HTTP 400 on page 0 with cameras-only children"
        )


class _BadChildrenParam(Exception):
    """Raised internally when includeChildren value is rejected by server."""


# ---------------------------------------------------------------------------
# MAC enrichment
#
# The MAC address lives on the parent hardware as a driver-level setting
# named MacAddress (originally from the SDK ConfigurationApi
# HardwareDriverSettingsFolder). The REST equivalent is the
# /api/rest/v1/hardwareDriverSettings/{hardware-id} resource — note the
# id is the hardware GUID, even though the URL doesn't say "hardware".
# The fields exposed there include macAddress, productID, firmwareVersion,
# serialNumber, detectedModelName, and a few HTTPS knobs.
#
# We try to pull these inline via includeChildren=hardwareDriverSettings
# on the bulk hardware fetch first; if the API version doesn't accept
# that, we fan out per-hardware GETs of /hardwareDriverSettings/{id} in
# a small thread pool.
# ---------------------------------------------------------------------------
def _settings_to_dict(settings_obj: Any) -> dict[str, str]:
    """Coerce a generic Milestone settings response into {name: value}.

    Two legacy response shapes seen in the wild:
        1. List of {"name": ..., "value": ...} (or "key"/"value")
        2. Flat object: {"MacAddress": "...", "FirmwareVersion": "..."}

    Both are handled. Names are kept as the API returned them; lookups
    should be case-insensitive (see _find_mac). This is kept around as
    a backstop for unusual API shapes; for hardwareDriverSettings
    specifically we use _driver_settings_to_dict, which understands
    the documented {"data": {"HardwareDriverSettings": {...}}} envelope.
    """
    out: dict[str, str] = {}
    if not settings_obj:
        return out

    # If it's wrapped in {"array": [...]} or {"data": [...]}, unwrap.
    if isinstance(settings_obj, dict):
        if isinstance(settings_obj.get("array"), list):
            settings_obj = settings_obj["array"]
        elif isinstance(settings_obj.get("data"), (list, dict)):
            settings_obj = settings_obj["data"]

    if isinstance(settings_obj, list):
        for entry in settings_obj:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name") or entry.get("key")
            value = entry.get("value")
            if name is not None:
                out[str(name)] = "" if value is None else str(value)
    elif isinstance(settings_obj, dict):
        for k, v in settings_obj.items():
            out[str(k)] = "" if v is None else str(v)
    return out


def _driver_settings_to_dict(payload: Any) -> dict[str, str]:
    """Parse a hardwareDriverSettings response into {field: value}.

    Per the REST API reference, the canonical shape is:
        {
          "data": {
            "displayName": "Settings",
            "HardwareDriverSettings": {
              "displayName": "General",
              "detectedModelName": "AXIS Q1647 Network Camera",
              "macAddress": "...",
              ...
            }
          }
        }

    But because Milestone's REST surface has shifted across versions
    (and includeChildren can produce a slightly different inline shape),
    we walk the payload defensively:
      * unwrap "data" if present,
      * pull HardwareDriverSettings out if it's a key,
      * accept the leaf object directly if neither wrapper is present,
      * skip the "displayName" decorator field that just labels the
        folder for UI purposes.
    """
    if not isinstance(payload, dict):
        return {}
    obj: Any = payload
    # Unwrap REST envelope.
    if isinstance(obj.get("data"), dict):
        obj = obj["data"]
    # Drill into the HardwareDriverSettings sub-object (case-insensitive
    # — older docs use HardwareDriverSettings, newer ones might
    # lowerCamelCase it).
    if isinstance(obj, dict):
        for key in ("HardwareDriverSettings", "hardwareDriverSettings"):
            if isinstance(obj.get(key), dict):
                obj = obj[key]
                break
    if not isinstance(obj, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in obj.items():
        if k == "displayName":
            # Folder/section label, not a real setting.
            continue
        if isinstance(v, (dict, list)):
            # Skip nested structures (definitions, sub-folders, etc.).
            continue
        out[str(k)] = "" if v is None else str(v)
    return out


def _find_mac(settings: dict[str, str]) -> str:
    """Case-insensitively find a MAC value in a settings dict.

    Tries the canonical 'MacAddress' / 'macAddress' first, then a few
    common variants (different capitalizations, hyphen/underscore
    variants). Returns the raw string or '' if not found.
    """
    if not settings:
        return ""
    # Build a lowercase-keyed view for case-insensitive lookup.
    lower = {k.lower(): v for k, v in settings.items()}
    for key in ("macaddress", "mac_address", "mac-address", "mac"):
        v = lower.get(key)
        if v:
            return v
    return ""


def fetch_hardware_settings_one(
    base: str, token: str, ctx: ssl.SSLContext | None,
    timeout: float, api_base: str, hw_id: str,
) -> dict[str, str]:
    """GET /hardwareDriverSettings/{id}; return {} on any error.

    The hardwareDriverSettings resource is keyed by the *hardware*
    GUID and exposes the driver-discovered properties (ProductID,
    MacAddress, FirmwareVersion, SerialNumber, DetectedModelName,
    HTTPSPort, ...). Per the REST API reference, the response shape is

        { "data": {
            "displayName": "Settings",
            "HardwareDriverSettings": {
                "detectedModelName": "...",
                "macAddress": "...",
                ...
            }
          }
        }

    We swallow per-hardware errors because one broken record shouldn't
    kill the whole 2500-camera snapshot. A missing/blank MAC for some
    hardware is recoverable; a missing snapshot is not.
    """
    if not hw_id:
        return {}
    for path in (
        f"{api_base}/hardwareDriverSettings/{hw_id}",
        f"{api_base}/hardware/{hw_id}/settings",   # legacy fallback
    ):
        url = f"{base}{path}"
        try:
            payload = _http_get_json(url, token, ctx, timeout)
            result = _driver_settings_to_dict(payload) or _settings_to_dict(payload)
            if result:
                return result
        except Exception as exc:
            import sys
            print(f"[MAC] {url}: {exc}", file=sys.stderr)
    return {}


def enrich_hardware_with_settings(
    hw_list: list[dict], base: str, token: str,
    ctx: ssl.SSLContext | None, timeout: float, api_base: str,
    workers: int,
) -> None:
    """Fill in hw['settings'] in-place for hardware that has cameras.

    Skips hardware that already has inline settings (from
    includeChildren=settings) or that has no cameras (saves work for
    speakers/mics-only hardware which Zabbix doesn't ping). Uses a
    bounded thread pool so we don't open thousands of sockets at once.
    """
    # Lazy import — keeps the dependency footprint zero for users
    # who pass --no-mac on Python builds without threading? In
    # practice ThreadPoolExecutor is always available; this just
    # avoids importing it when the function isn't called.
    from concurrent.futures import ThreadPoolExecutor, as_completed

    todo: list[dict] = []
    for hw in hw_list:
        if not isinstance(hw, dict):
            continue
        # Already have settings inline? Newest API uses
        # 'hardwareDriverSettings'; older shapes used 'settings' or
        # 'hardwareSettings'. Check the canonical name first, then
        # legacy fallbacks.
        if isinstance(hw.get("hardwareDriverSettings"), dict):
            hw["__settings_dict"] = _driver_settings_to_dict(
                hw["hardwareDriverSettings"]
            )
            continue
        if isinstance(hw.get("settings"), (list, dict)):
            hw["__settings_dict"] = _settings_to_dict(hw["settings"])
            continue
        if isinstance(hw.get("hardwareSettings"), (list, dict)):
            hw["__settings_dict"] = _settings_to_dict(hw["hardwareSettings"])
            continue
        # Only fetch for hardware that has at least one camera —
        # everything else is moot for our purposes.
        kids = hw.get("cameras")
        if not isinstance(kids, list):
            children = hw.get("children") or {}
            kids = (children.get("cameras")
                    if isinstance(children, dict) else None)
        if not kids:
            continue
        if hw.get("id"):
            todo.append(hw)

    if not todo:
        return

    workers = max(1, min(workers, 32))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(
                fetch_hardware_settings_one,
                base, token, ctx, timeout, api_base, hw["id"],
            ): hw
            for hw in todo
        }
        for fut in as_completed(futures):
            hw = futures[fut]
            try:
                hw["__settings_dict"] = fut.result()
            except Exception:  # noqa: BLE001
                hw["__settings_dict"] = {}


# ---------------------------------------------------------------------------
# Flatten hardware -> cameras
# ---------------------------------------------------------------------------
def flatten_cameras(hw_list: list[dict], hw_to_rs: dict[str, str] | None = None,
                    cam_groups: dict[str, str] | None = None) -> list[dict]:
    """Walk hardware -> child cameras, injecting hardware fields per camera.

    Injected per camera:
        address           — bare host (URL/port stripped) for ICMP
        mac               — normalized MAC, "AA:BB:CC:DD:EE:FF" or ""
        macRaw            — the value as Milestone returned it (for debugging)
        hardwareId        — parent hardware GUID
        hardwareName      — parent hardware display name
        hardwareModel     — parent hardware model string
        recordingServerId — grandparent recording-server GUID (from
                            hw_to_rs[hardwareId]); "" when unknown
        groupName         — Milestone camera-group label (from cam_groups);
                            "" when the camera isn't in any group / map missing
    """
    hw_to_rs = hw_to_rs or {}
    cam_groups = cam_groups or {}
    cameras: list[dict] = []
    for hw in hw_list or []:
        if not isinstance(hw, dict):
            continue
        # includeChildren returns children either as hw.cameras (newer
        # API versions) or hw.children.cameras (older). Accept both.
        kids = hw.get("cameras")
        if not isinstance(kids, list):
            children = hw.get("children") or {}
            if isinstance(children, dict):
                kids = children.get("cameras") or []
            else:
                kids = []

        # Pull MAC once per hardware — every camera under this hardware
        # shares the same parent MAC. Per-hardware fetches stash the
        # parsed setting dict under hw["__settings_dict"] (see
        # enrich_hardware_with_settings); inline children may live
        # under hw["hardwareDriverSettings"] (canonical, newer API),
        # hw["settings"] (older shape), or hw["hardwareSettings"]
        # (intermediate shape). Try in that order.
        settings_dict: dict[str, str] = {}
        if isinstance(hw.get("__settings_dict"), dict):
            settings_dict = hw["__settings_dict"]
        elif isinstance(hw.get("hardwareDriverSettings"), dict):
            settings_dict = _driver_settings_to_dict(
                hw["hardwareDriverSettings"]
            )
        elif isinstance(hw.get("settings"), (list, dict)):
            settings_dict = _settings_to_dict(hw["settings"])
        elif isinstance(hw.get("hardwareSettings"), (list, dict)):
            settings_dict = _settings_to_dict(hw["hardwareSettings"])
        mac_raw = _find_mac(settings_dict)
        mac = mac_norm(mac_raw)

        hw_id = hw.get("id") or ""
        # The recording server is the hardware's parent. Prefer the
        # authoritative RS-walk map; fall back to a recordingServerId the
        # hardware record may carry inline on some API versions.
        rs_id = hw_to_rs.get(hw_id, "")
        if not rs_id:
            rs_id = hw.get("recordingServerId") or ""
            rel = hw.get("relations") or {}
            parent = rel.get("parent") if isinstance(rel, dict) else None
            if not rs_id and isinstance(parent, dict) \
                    and str(parent.get("type", "")).lower() in (
                        "recordingservers", "recordingserver"):
                rs_id = parent.get("id") or ""

        for cam in kids:
            if not isinstance(cam, dict):
                continue
            if not cam.get("id"):
                continue
            cam["address"] = bare_host(hw.get("address"))
            cam["mac"] = mac
            cam["macRaw"] = mac_raw
            cam["hardwareId"] = hw_id
            cam["hardwareName"] = (
                hw.get("name") or hw.get("displayName") or ""
            )
            cam["hardwareModel"] = hw.get("model") or ""
            cam["recordingServerId"] = rs_id
            cam["groupName"] = cam_groups.get(cam.get("id") or "", "")
            cameras.append(cam)
    return cameras


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
    ap.add_argument("--timeout", type=float, default=120.0,
                    help="Per-request timeout in seconds (default: 120)")
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
    ap.add_argument("--no-mac", action="store_true",
                    help="Skip MAC enrichment. Cameras still get a "
                         "'mac' field but it will always be empty. "
                         "Saves up to one extra HTTP call per parent "
                         "hardware on installs where the API doesn't "
                         "return settings inline.")
    ap.add_argument("--mac-workers", type=int, default=8,
                    help="Parallelism for per-hardware /settings "
                         "fetches when MAC isn't available inline "
                         "(default 8, capped at 32). Higher values "
                         "are faster on big installs but put more "
                         "concurrent load on the API Gateway.")
    ap.add_argument("--no-rs-map", action="store_true",
                    help="Skip building the hardware->recording-server "
                         "map (1 + N_recording_servers extra API calls). "
                         "recordingServerId will be empty on every camera, "
                         "and the dashboard's per-camera Recording server "
                         "field will show '—'.")
    ap.add_argument("--no-group-map", action="store_true",
                    help="Skip building the camera->group map "
                         "(1 + N_groups extra API calls via /cameraGroups). "
                         "groupName will be empty on every camera, and the "
                         "dashboard's Cameras navigator will fall back to "
                         "the site host label for grouping.")
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

    # Step 2: hardware-with-cameras.
    try:
        hw_list = fetch_hardware_with_cameras(
            base, token, ctx, args.timeout,
            args.api_base, args.page_size,
            include_settings=not args.no_mac,
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

    # Step 2b: enrich with MAC addresses where settings weren't
    # included inline. Per-hardware errors are swallowed inside the
    # enrichment helper — a missing MAC is recoverable, a missing
    # snapshot is not.
    if not args.no_mac:
        try:
            enrich_hardware_with_settings(
                hw_list, base, token, ctx, args.timeout,
                args.api_base, args.mac_workers,
            )
        except Exception as e:  # noqa: BLE001
            # Belt and suspenders: even if the helper has a bug, we'd
            # rather emit cameras without MACs than fail the whole run.
            print(json.dumps({"error": "mac_enrichment_warning",
                              "detail": repr(e)}),
                  file=sys.stderr)

    # Step 2c: hardware -> recording-server map, so each camera can be
    # stamped with the grandparent RS GUID. Failure here is non-fatal —
    # recordingServerId just stays empty.
    hw_to_rs: dict[str, str] = {}
    if not args.no_rs_map:
        try:
            hw_to_rs = fetch_hardware_recordingserver_map(
                base, token, ctx, args.timeout, args.api_base,
            )
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"error": "rs_map_warning",
                              "detail": repr(e)}),
                  file=sys.stderr)

    # Step 2d: camera -> group-name map. Gives the cameras snapshot its own
    # copy of the Smart Client group membership so the dashboard's Cameras
    # navigator can attribute cameras even when the groups snapshot reader
    # is stale or strips the cameraIds arrays.
    cam_groups: dict[str, str] = {}
    if not args.no_group_map:
        try:
            cam_groups = fetch_camera_groupname_map(
                base, token, ctx, args.timeout, args.api_base,
            )
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"error": "group_map_warning",
                              "detail": repr(e)}),
                  file=sys.stderr)

    # Step 3: flatten and key by camera GUID.
    cameras_flat = flatten_cameras(hw_list, hw_to_rs, cam_groups)
    keyed: dict[str, dict[str, Any]] = {}
    for cam in cameras_flat:
        keyed[cam["id"]] = cam

    # Diagnostic: how many cameras ended up with a usable MAC / RS id.
    mac_count = sum(1 for c in cameras_flat if c.get("mac"))
    rsid_count = sum(1 for c in cameras_flat if c.get("recordingServerId"))

    # Output shape:
    #   - top-level fields (count, fetched_at, etc.) for diagnostics
    #   - <guid> -> camera record at the root for O(1) JSONPath lookup
    #     by dependent items (e.g. $["a1b2..."].address)
    #   - __array: flat list at the root for the LLD rule to iterate
    #     ($.__array[*])
    #
    # We put the by-GUID lookup AND the array at the root rather than
    # nesting them under a "cameras" key so the Zabbix item needs no
    # JavaScript preprocessing — just stores the file as-is. At 2500
    # cameras the embedded JSON is large enough that Duktape JS
    # preprocessing in Zabbix would time out (default 10s), so we do
    # the reshape here in Python where it's free.
    out: dict[str, Any] = {
        "__count": len(keyed),
        "__fetched_at": dt.datetime.now(dt.timezone.utc)
                          .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "__hardware_count": len(hw_list),
        "__mac_count": mac_count,
        "__rsid_count": rsid_count,
        "__array": cameras_flat,
    }
    # Camera GUIDs are added at the root, but we use __-prefixed keys
    # for diagnostics so they can never collide with a real camera GUID.
    out.update(keyed)

    sys.stdout.write(json.dumps(out, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
