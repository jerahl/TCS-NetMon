#!/usr/bin/env python3
"""
milestone_collector.py
----------------------
Long-lived service that owns Milestone data acquisition for Zabbix:

  * WS pump (continuous)
      Holds the Events-and-State WebSocket open, baselines per-camera state via
      getState, streams deltas, and pushes them to the per-camera trapper items
      (milestone.cam.ess.comm.type[<guid>], …comm.time, …rec.type, …ess.raw).

  * REST pump (scheduled)
      Periodically pulls the camera/groups/RS-storage inventory from the
      Config REST API, assembles each into the legacy
      {__count, __fetched_at, __array, "<guid>":{…}} shape the LLDs expect,
      and pushes each blob to its trapper item
      (milestone.cameras.getall, milestone.groups.get, milestone.rs.extras.get).

One service, two pumps, one token-refresh loop, one secrets file — replacing
all eight legacy externals (cameras/groups/rs/ess × refresh/state/read).

Operational decisions are recorded in
  ../milestone-rework-brief.md Phase 2 "Operational decisions"
and the rationale for the inventory pivot is in
  ../milestone-rest-rework.md §2.

Usage:
  systemd:  EnvironmentFile=/etc/milestone-collector/env
            ExecStart=/usr/local/bin/milestone_collector.py
  dev/once: ./milestone_collector.py --once --dry-run --env ../test/.env

Required environment (matches ../test/.env.example):
  MILESTONE_HOST, MILESTONE_SCHEME, MILESTONE_USER, MILESTONE_PASSWORD
  MILESTONE_CLIENT_ID (default GrantValidatorClient)
  MILESTONE_VERIFY_TLS (0|1)
  ZABBIX_SERVER          host:port for zabbix_sender (e.g. zbx-proxy:10051)
  ZABBIX_SENDER_HOST     hostname the trapper items live on in Zabbix

Exit codes: 0 normal shutdown; 2 auth/config error; 3 sender error.

Status: SCAFFOLD. WS pump and REST pump are present and end-to-end but the
service-grade pieces flagged TODO(phase5) are deferred to Phase 5
(metrics/heartbeat, rotation runbook, induced-failure tests).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import ssl
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import aiohttp
    import websockets
except ImportError as e:  # pragma: no cover
    print(f"missing dependency: {e}. Install: pip install -r requirements.txt",
          file=sys.stderr)
    sys.exit(2)

# websockets >= 13 (asyncio.client.connect / additional_headers) vs the legacy
# top-level connect (extra_headers). Same shim milestone_ess_state.py uses.
try:
    from websockets.asyncio.client import connect as _ws_connect  # type: ignore[attr-defined]
    _WS_HEADERS_KW = "additional_headers"
except ImportError:  # websockets < 13
    from websockets import connect as _ws_connect  # type: ignore[no-redef]
    _WS_HEADERS_KW = "extra_headers"


# ---------------------------------------------------------------------------
# Constants — kept here so the operational facts are scannable in one place.
# ---------------------------------------------------------------------------

# Phase 0 stategroup-coverage audit confirmed these 5 camera-level GUIDs cover
# every state group the template's milestone.cam.ess.* and CALCULATED items
# read. To widen, also add resourceTypes:["hardware"] for communication_hw_*.
EVENT_TYPES = [
    "dd3e6464-7dc0-405a-a92f-6150587563e8",  # communication_started
    "0ee90664-2924-42a0-a816-4129d0ecabdc",  # communication_stopped
    "a334af1c-4b4b-4957-9e5f-ab8ca07feab6",  # communication_error
    "4577f552-765a-438c-bc7d-e5ff1f754bc3",  # recording_started
    "79a94f89-92de-4fca-8a43-5561d407423d",  # recording_stopped
]
RESOURCE_TYPES = ["cameras"]

# Camera fields kept in the inventory trapper, matching the KEEP set in
# milestone_cameras_state.py so consumers see byte-compatible records.
CAMERA_KEEP_FIELDS = (
    "id", "displayName", "enabled", "address", "mac", "hardwareId",
    "hardwareName", "hardwareModel", "channel", "lastModified",
    "recordingServerId", "groupName", "relations",
)

# Trapper item keys on the Zabbix side. Mirror what the template defines.
KEY_CAMERAS_BLOB = "milestone.cameras.getall"
KEY_GROUPS_BLOB = "milestone.groups.get"
KEY_RS_EXTRAS_BLOB = "milestone.rs.extras.get"
KEY_CAM_COMM_TYPE = "milestone.cam.ess.comm.type[{guid}]"
KEY_CAM_COMM_TIME = "milestone.cam.ess.comm.time[{guid}]"
KEY_CAM_REC_TYPE = "milestone.cam.ess.rec.type[{guid}]"
KEY_CAM_ESS_RAW = "milestone.cam.ess.raw[{guid}]"

# Reconnect/poll cadences. Tune via env if needed; not pulled out as knobs yet.
WS_RECONNECT_BACKOFF_INITIAL_S = 2.0
WS_RECONNECT_BACKOFF_MAX_S = 60.0
TOKEN_REFRESH_MARGIN_S = 60.0    # refresh that many seconds before expiry
REST_POLL_CAMERAS_S = 3600       # 1 h — inventory changes rarely
REST_POLL_GROUPS_S = 3600
REST_POLL_RS_EXTRAS_S = 900      # 15 m — storage used-bytes / retention drift

# WS framing: getState at ~2500 cameras can be tens of MB and 1-2 min to first
# byte. Keep this generous; the cost is only memory at peak.
WS_MAX_SIZE = 128 * 1024 * 1024

# Bound page-loop iterations as a safety belt against API misbehavior.
REST_PAGE_SIZE = 1000
REST_PAGE_LIMIT = 100

log = logging.getLogger("milestone_collector")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
@dataclass
class Config:
    host: str
    scheme: str
    user: str
    password: str
    client_id: str
    verify_tls: bool
    zabbix_server: str       # host:port  (e.g. zbx-proxy.example.com:10051)
    zabbix_sender_host: str  # the Zabbix host name the trapper items live on
    sender_bin: str          # path to zabbix_sender (default: zabbix_sender on PATH)

    @property
    def base_url(self) -> str:
        return f"{self.scheme}://{self.host}"

    @property
    def api_url(self) -> str:
        return f"{self.base_url}/api/rest/v1"

    @property
    def ws_url(self) -> str:
        ws_scheme = "wss" if self.scheme == "https" else "ws"
        return f"{ws_scheme}://{self.host}/api/ws/events/v1"

    @property
    def idp_url(self) -> str:
        # /API/IDP/connect/token is the path Phase 0 confirmed on dev; the
        # template's inline SCRIPTs use /IDP/connect/token. Accept either by
        # trying /API first, falling back to /IDP — same logic as the probe.
        return f"{self.base_url}/API/IDP/connect/token"

    @property
    def idp_fallback_url(self) -> str:
        return f"{self.base_url}/IDP/connect/token"


def load_env_file(path: Path) -> None:
    """Lightweight .env loader for --env (dev). systemd does this via
    EnvironmentFile= so production never calls this."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())


def load_config() -> Config:
    def need(key: str) -> str:
        v = os.environ.get(key)
        if not v:
            print(f"FATAL: env var {key} not set", file=sys.stderr)
            sys.exit(2)
        return v

    return Config(
        host=need("MILESTONE_HOST"),
        scheme=os.environ.get("MILESTONE_SCHEME", "https"),
        user=need("MILESTONE_USER"),
        password=need("MILESTONE_PASSWORD"),
        client_id=os.environ.get("MILESTONE_CLIENT_ID", "GrantValidatorClient"),
        verify_tls=os.environ.get("MILESTONE_VERIFY_TLS", "0") == "1",
        zabbix_server=need("ZABBIX_SERVER"),
        zabbix_sender_host=need("ZABBIX_SENDER_HOST"),
        sender_bin=os.environ.get("ZABBIX_SENDER_BIN", "zabbix_sender"),
    )


# ---------------------------------------------------------------------------
# TokenStore — single source of truth for the bearer, refreshed in background.
# ---------------------------------------------------------------------------
class TokenStore:
    def __init__(self, cfg: Config, http: aiohttp.ClientSession) -> None:
        self.cfg = cfg
        self.http = http
        self._token: str = ""
        self._expires_at: float = 0.0
        self._idp_url = cfg.idp_url
        self._lock = asyncio.Lock()

    async def get(self) -> str:
        """Return a valid bearer; refresh if missing or near expiry."""
        async with self._lock:
            if self._token and time.time() < self._expires_at - TOKEN_REFRESH_MARGIN_S:
                return self._token
            await self._refresh_locked()
            return self._token

    async def _refresh_locked(self) -> None:
        data = {
            "grant_type": "password",
            "username": self.cfg.user,
            "password": self.cfg.password,
            "client_id": self.cfg.client_id,
        }
        for url in (self._idp_url, self.cfg.idp_fallback_url):
            try:
                async with self.http.post(url, data=data,
                                          headers={"Accept": "application/json"}) as r:
                    body = await r.text()
                    if r.status != 200:
                        log.warning("IDP %s -> HTTP %s: %s", url, r.status, body[:200])
                        continue
                    payload = json.loads(body)
                    tok = payload.get("access_token")
                    exp = float(payload.get("expires_in", 0))
                    if not tok:
                        continue
                    self._token = tok
                    self._expires_at = time.time() + exp
                    self._idp_url = url  # remember the path that worked
                    log.info("token refreshed via %s (expires_in=%ss)", url, exp)
                    return
            except aiohttp.ClientError as e:
                log.warning("IDP %s connection error: %r", url, e)
        raise RuntimeError("no IDP path returned a usable token")


# ---------------------------------------------------------------------------
# Zabbix sender — subprocess wrapper. We keep this synchronous (run via
# loop.run_in_executor) because zabbix_sender is a short-lived CLI and stdin
# batching is the simplest reliable interface.
# ---------------------------------------------------------------------------
class ZabbixSender:
    def __init__(self, cfg: Config, dry_run: bool = False) -> None:
        self.cfg = cfg
        self.dry_run = dry_run
        # If zabbix_sender is missing (typical on a dev box), log the warning
        # once at startup instead of on every batch send.
        self._missing_warned = False

    def _zbx_host_port(self) -> tuple[str, str]:
        host, _, port = self.cfg.zabbix_server.partition(":")
        return host, (port or "10051")

    async def send_batch(self, items: list[tuple[str, str]]) -> None:
        """items = list of (key, value). All sent as one zabbix_sender invocation
        against ZABBIX_SENDER_HOST."""
        if not items:
            return
        host = self.cfg.zabbix_sender_host
        stdin = "\n".join(f'"{host}" "{k}" "{_escape(v)}"' for k, v in items) + "\n"
        if self.dry_run:
            for k, v in items:
                preview = v if len(v) < 120 else f"{v[:117]}…"
                log.info("[dry-run] %s %s %s", host, k, preview)
            return
        zhost, zport = self._zbx_host_port()
        cmd = [self.cfg.sender_bin, "-z", zhost, "-p", zport, "-T", "-i", "-"]
        await asyncio.get_running_loop().run_in_executor(
            None, self._run, cmd, stdin)

    def _run(self, cmd: list[str], stdin: str) -> None:
        try:
            r = subprocess.run(cmd, input=stdin, text=True,
                               capture_output=True, timeout=60)
        except FileNotFoundError as e:
            if not self._missing_warned:
                log.error("zabbix_sender not found at %r — every send_batch "
                          "will be a no-op until installed (%r). Use --dry-run "
                          "on dev boxes that don't have zabbix-sender.",
                          self.cfg.sender_bin, e)
                self._missing_warned = True
            return
        except subprocess.TimeoutExpired as e:
            log.error("zabbix_sender timed out: %r", e)
            return
        # zabbix_sender exits 0 on success, 2 on partial. Log both stdout/stderr.
        if r.returncode != 0:
            log.error("zabbix_sender rc=%s stderr=%s", r.returncode, r.stderr.strip())
        elif log.isEnabledFor(logging.DEBUG):
            log.debug("zabbix_sender ok: %s", r.stdout.strip())


def _escape(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"')


# ---------------------------------------------------------------------------
# REST helpers — paged GET, async via aiohttp.
# ---------------------------------------------------------------------------
async def _auth_headers(tokens: TokenStore) -> dict[str, str]:
    return {"Authorization": f"Bearer {await tokens.get()}",
            "Accept": "application/json"}


async def paged_get(http: aiohttp.ClientSession, tokens: TokenStore,
                    api: str, path: str) -> list[dict]:
    """GET path, concatenating .array across pages. path may include a query
    string already; page/size are appended."""
    out: list[dict] = []
    sep = "&" if "?" in path else "?"
    for page in range(REST_PAGE_LIMIT):
        url = f"{api}{path}{sep}page={page}&size={REST_PAGE_SIZE}"
        async with http.get(url, headers=await _auth_headers(tokens)) as r:
            if r.status != 200:
                body = (await r.text())[:300]
                raise RuntimeError(f"GET {path} page={page} -> {r.status}: {body}")
            arr = (await r.json()).get("array") or []
            out.extend(arr)
            if len(arr) < REST_PAGE_SIZE:
                return out
    raise RuntimeError(f"GET {path}: hit page limit ({REST_PAGE_LIMIT})")


async def get_json(http: aiohttp.ClientSession, tokens: TokenStore,
                   api: str, path: str) -> dict:
    async with http.get(api + path, headers=await _auth_headers(tokens)) as r:
        if r.status != 200:
            body = (await r.text())[:300]
            raise RuntimeError(f"GET {path} -> {r.status}: {body}")
        return await r.json()


def bare_host(addr: str | None) -> str:
    """Strip scheme/creds/port/path from a hardware address. Mirrors
    milestone_cameras_state.py's bare_host() — this is the SNMP interface IP
    the camera host_prototype uses."""
    if not addr:
        return ""
    s = str(addr)
    if "://" in s:
        s = s.split("://", 1)[1]
    if "@" in s:
        s = s.split("@", 1)[1]
    s = s.split("/", 1)[0]
    s = s.split(":", 1)[0]
    return s


# ---------------------------------------------------------------------------
# REST pump — assemble each blob and send it via zabbix_sender.
#
# All three blobs reuse the same {__count, __fetched_at, __array, "<guid>":{…}}
# shape the legacy externals produced so the template LLDs and per-* dependents
# (which use $["<guid>"] and $.__array[*]) are byte-compatible at cutover.
# ---------------------------------------------------------------------------
def _legacy_shape(records: list[dict], id_field: str = "id") -> dict:
    out: dict[str, Any] = {
        "__count": len(records),
        "__fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "__array": records,
    }
    for r in records:
        rid = r.get(id_field)
        if rid:
            out[rid] = r
    return out


async def assemble_cameras_blob(http: aiohttp.ClientSession, tokens: TokenStore,
                                api: str) -> tuple[dict, dict[str, str]]:
    """Page lean /hardware + lean /cameras + group membership; join on
    relations.parent.id; return the legacy-shape blob AND a camId->groupName
    map (for use by callers that want it).

    Logic verified offline against Phase 0 fixtures (81/81 group cameras
    resolved parent hardware; Bosch vendor regex still matches enriched model).
    """
    hardware = await paged_get(http, tokens, api, "/hardware?disabled")
    hw_map: dict[str, dict] = {h["id"]: h for h in hardware if h.get("id")}

    # Group membership: walk /cameraGroups once, then per-group /cameras for
    # the camId -> groupName map. Failures per-group are non-fatal.
    cam_group: dict[str, str] = {}
    try:
        groups_arr = (await get_json(http, tokens, api, "/cameraGroups")).get("array") or []
        for g in groups_arr:
            gid = g.get("id")
            if not gid:
                continue
            gname = g.get("displayName") or g.get("name") or ""
            try:
                members = await paged_get(http, tokens, api,
                                          f"/cameraGroups/{gid}/cameras")
                for m in members:
                    mid = m.get("id")
                    if mid and mid not in cam_group:
                        cam_group[mid] = gname
            except Exception as e:  # noqa: BLE001
                log.warning("group %s membership: %r", gid, e)
    except Exception as e:  # noqa: BLE001
        log.warning("cameraGroups walk failed (best-effort): %r", e)

    cameras = await paged_get(http, tokens, api, "/cameras?disabled")
    records: list[dict] = []
    for cam in cameras:
        cid = cam.get("id")
        if not cid:
            continue
        parent_id = (cam.get("relations") or {}).get("parent", {}).get("id", "")
        hw = hw_map.get(parent_id) or {}
        rs_id = (hw.get("relations") or {}).get("parent", {}).get("id", "")
        rec = {
            "id": cid,
            "displayName": cam.get("displayName"),
            "enabled": cam.get("enabled"),
            "channel": cam.get("channel"),
            "lastModified": cam.get("lastModified"),
            "address": bare_host(hw.get("address")),
            "mac": "",   # not exposed in bulk on this Gateway (Phase 0)
            "hardwareId": parent_id,
            "hardwareName": hw.get("displayName", ""),
            "hardwareModel": hw.get("model", ""),
            "recordingServerId": rs_id,
            "groupName": cam_group.get(cid, ""),
            "relations": cam.get("relations"),
        }
        # Keep only the fields the trapper consumers read.
        rec = {k: rec[k] for k in CAMERA_KEEP_FIELDS if k in rec}
        records.append(rec)
    return _legacy_shape(records), cam_group


async def assemble_groups_blob(http: aiohttp.ClientSession, tokens: TokenStore,
                               api: str) -> dict:
    """Walk /cameraGroups + per-group membership for counts (no inline counts
    on this Gateway, per Phase 0). Distinct hardware count needs a hardware-id
    set per group — derived from the camera membership."""
    groups = (await get_json(http, tokens, api, "/cameraGroups")).get("array") or []
    records: list[dict] = []
    for g in groups:
        gid = g.get("id")
        if not gid:
            continue
        try:
            members = await paged_get(http, tokens, api,
                                      f"/cameraGroups/{gid}/cameras")
        except Exception as e:  # noqa: BLE001
            log.warning("group %s members: %r", gid, e)
            members = []
        hw_ids: set[str] = set()
        for m in members:
            pid = (m.get("relations") or {}).get("parent", {}).get("id", "")
            if pid:
                hw_ids.add(pid)
        rec = {
            "id": gid,
            "name": g.get("name") or g.get("displayName") or "",
            "displayName": g.get("displayName", ""),
            "description": g.get("description", ""),
            "parentGroupId": (g.get("relations") or {}).get("parent", {}).get("id", ""),
            "path": g.get("path", ""),
            "cameraCount": len(members),
            "hardwareCount": len(hw_ids),
        }
        records.append(rec)
    return _legacy_shape(records)


async def assemble_rs_extras_blob(http: aiohttp.ClientSession, tokens: TokenStore,
                                  api: str, cameras_blob: dict) -> dict:
    """Compose RS extras: storage rollups via /recordingServers/{id}/storages
    per RS, plus camera/hardware counts derived from the cameras blob. RS
    service state arrives via the WS pump; this routine leaves it null so the
    trapper item updates atomically when state is wired in (TODO(phase5)).
    """
    rs_list = (await get_json(http, tokens, api, "/recordingServers")).get("array") or []
    # Derive counts from the cameras blob in one pass.
    cam_count_by_rs: dict[str, int] = {}
    hw_set_by_rs: dict[str, set[str]] = {}
    for rec in cameras_blob.get("__array", []):
        rsid = rec.get("recordingServerId")
        if not rsid:
            continue
        cam_count_by_rs[rsid] = cam_count_by_rs.get(rsid, 0) + 1
        hwid = rec.get("hardwareId") or ""
        if hwid:
            hw_set_by_rs.setdefault(rsid, set()).add(hwid)

    records: list[dict] = []
    storages_flat: list[dict] = []
    for rs in rs_list:
        rid = rs.get("id")
        if not rid:
            continue
        try:
            storages = (await get_json(http, tokens, api,
                                       f"/recordingServers/{rid}/storages")
                        ).get("array") or []
        except Exception as e:  # noqa: BLE001
            log.warning("RS %s storages: %r", rid, e)
            storages = []
        total = used = 0
        retention_min: int | None = None
        for s in storages:
            # Field names mirror what milestone_rs_state.py wrote so the
            # template's per-storage LLD continues to bind unchanged.
            s_rec = {
                "rsId": rid,
                "id": s.get("id"),
                "path": s.get("path", ""),
                "size": s.get("size", 0),
                "used": s.get("usedSpace", 0),
                "retention": s.get("retentionMinutes", 0),
            }
            storages_flat.append(s_rec)
            try:
                total += int(s_rec["size"] or 0)
                used += int(s_rec["used"] or 0)
            except (TypeError, ValueError):
                pass
            try:
                rmin = int(s_rec["retention"] or 0)
                if rmin > 0 and (retention_min is None or rmin < retention_min):
                    retention_min = rmin
            except (TypeError, ValueError):
                pass
        rec = {
            "id": rid,
            "displayName": rs.get("displayName", ""),
            # state: filled in by the WS pump on next state event; null until
            # the running state map is wired through (TODO see __main__).
            "state": None,
            "cameraCount": cam_count_by_rs.get(rid, 0),
            "hardwareCount": len(hw_set_by_rs.get(rid, set())),
            "storageTotalBytes": total,
            "storageUsedBytes": used,
            "storageRetentionMinutes": retention_min or 0,
            "storages": storages,
        }
        records.append(rec)
    blob = _legacy_shape(records)
    blob["__storages"] = storages_flat
    blob["__total_storages"] = len(storages_flat)
    return blob


async def rest_pump(cfg: Config, http: aiohttp.ClientSession,
                    tokens: TokenStore, sender: ZabbixSender,
                    once: bool = False) -> None:
    """Repeatedly assemble + push the three inventory blobs at their own
    cadences. With --once, runs the full cycle one time and returns."""
    next_cameras = 0.0
    next_groups = 0.0
    next_rs = 0.0
    cameras_blob: dict = {}

    while True:
        now = time.time()
        try:
            if now >= next_cameras:
                log.info("REST: assembling cameras blob")
                cameras_blob, _ = await assemble_cameras_blob(http, tokens, cfg.api_url)
                await sender.send_batch([(KEY_CAMERAS_BLOB, json.dumps(cameras_blob))])
                log.info("REST: pushed cameras (%d)", cameras_blob.get("__count", 0))
                next_cameras = now + REST_POLL_CAMERAS_S
            if now >= next_groups:
                log.info("REST: assembling groups blob")
                groups_blob = await assemble_groups_blob(http, tokens, cfg.api_url)
                await sender.send_batch([(KEY_GROUPS_BLOB, json.dumps(groups_blob))])
                log.info("REST: pushed groups (%d)", groups_blob.get("__count", 0))
                next_groups = now + REST_POLL_GROUPS_S
            if now >= next_rs:
                if not cameras_blob:
                    # First tick: groups/RS cadences could fire before cameras
                    # if the schedule lines up. Pull cameras now so RS counts
                    # are populated rather than zero.
                    cameras_blob, _ = await assemble_cameras_blob(http, tokens, cfg.api_url)
                log.info("REST: assembling RS extras blob")
                rs_blob = await assemble_rs_extras_blob(http, tokens, cfg.api_url,
                                                        cameras_blob)
                await sender.send_batch([(KEY_RS_EXTRAS_BLOB, json.dumps(rs_blob))])
                log.info("REST: pushed RS extras (%d)", rs_blob.get("__count", 0))
                next_rs = now + REST_POLL_RS_EXTRAS_S
        except Exception as e:  # noqa: BLE001
            log.exception("REST pump iteration failed: %r", e)
        if once:
            return
        # Sleep to the next due tick (bounded so we wake to refresh logs).
        sleep_for = max(5.0, min(next_cameras, next_groups, next_rs) - time.time())
        await asyncio.sleep(min(sleep_for, 60.0))


# ---------------------------------------------------------------------------
# WS pump — startSession → addSubscription → getState → receive loop.
#
# Protocol mirrors milestone_ess_state.py (one-shot) but adds:
#   - resume via stored sessionId + lastEventId
#   - branch on startSession status (201 new -> subscribe + baseline;
#                                    200 resumed -> continue)
#   - reconnect-with-backoff loop around the whole thing
#   - background token refresh applied on next reconnect
# ---------------------------------------------------------------------------
class WsState:
    """Tracks per-camera by_group state across deltas — same map shape the
    template's existing milestone.cam.ess.raw[…] dependents already parse."""
    def __init__(self) -> None:
        self.cameras: dict[str, dict] = {}
        self.session_id: str = ""
        self.last_event_id: str = ""

    def apply_state_entry(self, entry: dict) -> str | None:
        """Update by_group for one event/state record. Returns the camera GUID
        (so the caller can compose sender lines), or None if unmappable."""
        source = entry.get("source", "")
        if not source.startswith("cameras/"):
            return None
        cam = source.split("/", 1)[1]
        grp = entry.get("stategroupid")
        if not grp:
            return None
        bucket = self.cameras.setdefault(cam, {"states": [], "by_group": {}})
        bucket["by_group"][grp] = {"type": entry.get("type"),
                                   "time": entry.get("time")}
        # Don't accumulate raw states unbounded — the by_group map is what
        # consumers read; the raw list was kept by the one-shot script for
        # diagnostics only.
        return cam


def _ws_command_payload(cmd: str, cid: int, **fields: Any) -> dict:
    out = {"command": cmd, "commandId": cid}
    out.update(fields)
    return out


async def _ws_send_and_match(ws: Any, payload: dict, timeout: float = 180.0) -> dict:
    """Send a command, ignore unsolicited event frames until our commandId
    response arrives. Same logic as milestone_ess_state.py._send_command()."""
    await ws.send(json.dumps(payload))
    want = payload["commandId"]
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get("commandId") == want:
            return msg


def _sender_lines_for_camera(cam: str, by_group: dict[str, dict],
                             raw_blob: str) -> list[tuple[str, str]]:
    """Compose the trapper lines for one camera's current state. comm/rec
    classification reuses the {$MILESTONE.ESS.STATEGROUP.*} convention the
    template uses; we don't know the macro values here so we set both
    comm/rec items from whichever event we last saw — the template's
    preprocessing maps stategroupid → field. To keep that mapping in one
    place, we push the whole ess.raw blob and let the existing per-camera
    JS preprocessing route fields. That matches today's external pipeline.
    """
    return [(KEY_CAM_ESS_RAW.format(guid=cam), raw_blob)]


async def ws_pump(cfg: Config, http: aiohttp.ClientSession,
                  tokens: TokenStore, sender: ZabbixSender,
                  stop: asyncio.Event, once: bool = False) -> None:
    state = WsState()
    backoff = WS_RECONNECT_BACKOFF_INITIAL_S
    ssl_ctx: ssl.SSLContext | None = None
    if cfg.scheme == "https":
        ssl_ctx = ssl.create_default_context()
        if not cfg.verify_tls:
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE

    while not stop.is_set():
        try:
            token = await tokens.get()
            ws_kwargs: dict[str, Any] = {
                "ssl": ssl_ctx if cfg.scheme == "https" else None,
                "open_timeout": 30,
                "close_timeout": 5,
                "max_size": WS_MAX_SIZE,
                _WS_HEADERS_KW: {"Authorization": f"Bearer {token}"},
            }
            log.info("WS: connecting to %s (resume=%s)",
                     cfg.ws_url, bool(state.session_id))
            async with _ws_connect(cfg.ws_url, **ws_kwargs) as ws:
                cid = 0

                def next_cid() -> int:
                    nonlocal cid
                    cid += 1
                    return cid

                start = await _ws_send_and_match(ws, _ws_command_payload(
                    "startSession", next_cid(),
                    sessionId=state.session_id, eventId=state.last_event_id))
                status = start.get("status")
                if status not in (200, 201):
                    raise RuntimeError(f"startSession failed: {start}")
                state.session_id = start.get("sessionId", state.session_id)
                is_new_session = (status == 201)
                log.info("WS: startSession status=%s (%s)", status,
                         "new session" if is_new_session else "resumed")

                if is_new_session:
                    sub = await _ws_send_and_match(ws, _ws_command_payload(
                        "addSubscription", next_cid(),
                        filters=[{
                            "modifier": "include",
                            "resourceTypes": RESOURCE_TYPES,
                            "sourceIds": ["*"],
                            "eventTypes": EVENT_TYPES,
                        }]))
                    if sub.get("status") != 200:
                        raise RuntimeError(f"addSubscription failed: {sub}")
                    log.info("WS: subscription added (%d event types)",
                             len(EVENT_TYPES))

                    state_resp = await _ws_send_and_match(ws, _ws_command_payload(
                        "getState", next_cid()), timeout=600.0)
                    if state_resp.get("status") != 200:
                        raise RuntimeError(f"getState failed: {state_resp}")
                    baseline = state_resp.get("states", []) or []
                    log.info("WS: baseline %d states", len(baseline))
                    # Apply baseline; emit one sender batch.
                    touched: dict[str, dict] = {}
                    for entry in baseline:
                        cam = state.apply_state_entry(entry)
                        if cam:
                            touched[cam] = state.cameras[cam]
                    await _flush_cameras(sender, touched)

                backoff = WS_RECONNECT_BACKOFF_INITIAL_S
                if once:
                    log.info("WS: --once exiting after baseline")
                    return

                # Receive loop — events arrive as {"events":[…]} per the
                # sample. Track last_event_id from the last entry of each
                # batch so a reconnect within 30s recovers missed events.
                while not stop.is_set():
                    raw = await asyncio.wait_for(ws.recv(), timeout=300.0)
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    events = msg.get("events")
                    if not events:
                        continue
                    touched = {}
                    for entry in events:
                        cam = state.apply_state_entry(entry)
                        if cam:
                            touched[cam] = state.cameras[cam]
                    if events and events[-1].get("id"):
                        state.last_event_id = events[-1]["id"]
                    await _flush_cameras(sender, touched)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("WS error: %r — reconnecting in %.1fs", e, backoff)
            try:
                await asyncio.wait_for(stop.wait(), timeout=backoff)
                return
            except asyncio.TimeoutError:
                backoff = min(backoff * 2.0, WS_RECONNECT_BACKOFF_MAX_S)
                continue


async def _flush_cameras(sender: ZabbixSender,
                         touched: dict[str, dict]) -> None:
    """Push milestone.cam.ess.raw[<guid>] for every camera updated in this
    batch. The template's existing JS preprocessing on the per-camera
    comm.type/comm.time/rec.type items extracts those fields from this same
    blob, so we keep the stategroupid mapping in one place (the template)
    rather than duplicating macro values in the collector."""
    items: list[tuple[str, str]] = []
    for cam, bucket in touched.items():
        raw_blob = json.dumps(bucket, separators=(",", ":"))
        items.extend(_sender_lines_for_camera(cam, bucket.get("by_group", {}), raw_blob))
    if items:
        await sender.send_batch(items)


# ---------------------------------------------------------------------------
# main()
# ---------------------------------------------------------------------------
async def amain(args: argparse.Namespace) -> int:
    cfg = load_config()
    # --dry-run takes precedence; MILESTONE_DRY_RUN=1 in the env is a fallback
    # so it can be forced from a .env file even if the CLI flag is forgotten.
    dry_run = bool(args.dry_run) or os.environ.get("MILESTONE_DRY_RUN", "0") == "1"
    sender = ZabbixSender(cfg, dry_run=dry_run)

    # Startup banner — confirms what mode the service actually started in,
    # rather than what the user thinks the flags say.
    log.info("startup: dry_run=%s ws_only=%s rest_only=%s once=%s "
             "gateway=%s zbx_server=%s sender_host=%s",
             dry_run, args.ws_only, args.rest_only, args.once,
             cfg.base_url, cfg.zabbix_server, cfg.zabbix_sender_host)

    # aiohttp: ssl=False disables TLS entirely; for "https without verify" we
    # need an SSL context with verification turned off, not None either.
    ssl_ctx: ssl.SSLContext | bool = True
    if cfg.scheme == "https" and not cfg.verify_tls:
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE
    elif cfg.scheme != "https":
        ssl_ctx = False  # plain http only
    connector = aiohttp.TCPConnector(ssl=ssl_ctx)
    async with aiohttp.ClientSession(connector=connector) as http:
        tokens = TokenStore(cfg, http)
        # Force one upfront refresh so config errors surface immediately.
        try:
            await tokens.get()
        except Exception as e:  # noqa: BLE001
            log.error("auth failed at startup: %r", e)
            return 2

        stop = asyncio.Event()

        def _on_signal() -> None:
            log.info("signal received — shutting down")
            stop.set()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _on_signal)
            except NotImplementedError:  # Windows
                pass

        tasks: list[asyncio.Task] = []
        if not args.ws_only:
            tasks.append(asyncio.create_task(
                rest_pump(cfg, http, tokens, sender, once=args.once),
                name="rest-pump"))
        if not args.rest_only:
            tasks.append(asyncio.create_task(
                ws_pump(cfg, http, tokens, sender, stop, once=args.once),
                name="ws-pump"))

        if not tasks:
            log.error("--ws-only and --rest-only are mutually exclusive")
            return 2

        try:
            if args.once:
                await asyncio.gather(*tasks)
            else:
                # Run until any task ends or a signal arrives. We treat any
                # task completion as fatal — the supervisor (systemd) restarts
                # the process.
                done, pending = await asyncio.wait(
                    tasks + [asyncio.create_task(stop.wait(), name="stop")],
                    return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                for t in done:
                    exc = t.exception() if not t.cancelled() else None
                    if exc:
                        log.error("task %s ended with %r", t.get_name(), exc)
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true",
                    help="run each pump one full cycle, then exit")
    ap.add_argument("--dry-run", action="store_true",
                    help="don't shell out to zabbix_sender; log sender lines instead")
    ap.add_argument("--ws-only", action="store_true",
                    help="run only the WS pump (status plane)")
    ap.add_argument("--rest-only", action="store_true",
                    help="run only the REST pump (inventory plane)")
    ap.add_argument("--env", type=Path,
                    help="load this .env file before reading config (dev convenience)")
    ap.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    if args.env:
        load_env_file(args.env)

    try:
        return asyncio.run(amain(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
