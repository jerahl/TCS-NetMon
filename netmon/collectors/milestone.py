"""Milestone collector — recording-server + camera state and inventory.

State (device_state): recording servers → ``source_status``; cameras →
``source_status`` from ESS Communication, and ``recording`` = **unknown**,
because nothing NetMon can reach measures whether a camera is actually
recording (see the note at the write site). Blind on unreachable.

Inventory (Phase 10.4, spec 10 §3/§5): the same Config API responses —
previously discarded — persist to ``recording_servers`` / ``cameras`` +
per-RS storage rollup, and a ``milestone.overview`` snapshot_cache blob.
The Config API lacks live fps/bitrate/host metrics (§7) — those columns
stay NULL and the UI renders "—", never fabricated. The camera's linked
switch port is the FDB payoff at query time (cameras.mac ⋈ fdb_entries).

The live Events/State WebSocket (ws.py) needs the ``websockets`` dependency
(⛔ D5, owner approval pending); until then this poll gives state and the
Alarms tab shows NetMon alerts scoped to surveillance devices.

    python -m netmon.collectors.milestone --once|--loop
"""

from __future__ import annotations

import asyncio
import logging
import sys
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy.engine import Engine

from netmon import db
from netmon.collectors.base import Collector, run_standalone
from netmon.collectors.milestone_client import MilestoneClient, MilestoneError
from netmon.config import Config
from netmon.seed import canon_mac
from netmon.snapshots import write_snapshot
from netmon.state import write_state, write_states
from netmon.collectors.ws_milestone import MilestoneEss

# ESS event-type names → camera source_status. Resolved authoritatively from
# /api/rest/v1/eventTypes (spec 19 §11), not inferred from the GUIDs.
#
# Only the Communication group is mapped. Recording is deliberately excluded:
# recording here is motion-triggered, so `RecordingStopped` is the ordinary
# resting state for most cameras most of the time and would manufacture an
# outage out of normal operation (owner, 2026-09-04). FPS groups are likewise
# left alone until someone decides what Critical means operationally.
ESS_COMMUNICATION = {
    "CommunicationStarted": ("up", "ok"),
    "CommunicationError": ("down", "crit"),
    "CommunicationStopped": ("down", "crit"),
}

# Recording-server ESS states → the four columns migration 027 adds. Keyed by
# the *prefix* of the resolved state name, because the name carries the verdict
# in its tail ("Retention time Normal" / "Retention time Warning") and the group
# is what identifies the dimension.
#
# Only Communication drives `device_state`. The other three are descriptive:
# half this estate reads "Service Available Critical" with a timestamp four
# months old, which looks like a state group that was never cleared rather than
# eleven simultaneous outages — and turning it into eleven alerts would repeat
# the storm spec 19 §12 spent a day undoing.
ESS_RS_COLUMNS = (
    ("Communication", "comm_state"),
    ("CPU Usage", "cpu_state"),
    ("Retention time", "retention_state"),
    ("Service Available", "service_state"),
)

log = logging.getLogger("netmon.collectors.milestone")


def _truthy(*vals: Any) -> bool:
    for v in vals:
        if isinstance(v, bool):
            return v
        if isinstance(v, str) and v.strip().lower() in ("running", "true", "enabled", "online", "ok"):
            return True
    return False


def _num(*vals: Any):
    for v in vals:
        if isinstance(v, (int, float)):
            return v
        if isinstance(v, str):
            try:
                return float(v) if "." in v else int(v)
            except ValueError:
                continue
    return None


def _ess_time(raw: Any) -> datetime | None:
    """Parse an Events/State timestamp.

    Milestone emits ISO-8601 with **seven** fractional digits and a trailing Z
    ("2026-08-15T04:32:51.5226035Z"). `datetime.fromisoformat` accepts at most
    six, and handing the raw string to a TIMESTAMP column fails outright —
    MariaDB rejected the whole recording-server upsert with "Incorrect datetime
    value", so one unparsed field cost the entire table its refresh.
    """
    s = str(raw or "").strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    # Truncate over-long fractional seconds rather than rounding: the extra
    # digit is 100ns precision nothing here needs.
    if "." in s:
        head, _, tail = s.partition(".")
        digits = "".join(ch for ch in tail if ch.isdigit())[:6]
        rest = tail[len(digits):] if tail[len(digits):].startswith(("+", "-")) else ""
        if not rest:
            plus = max(tail.rfind("+"), tail.rfind("-"))
            rest = tail[plus:] if plus > 0 else ""
        s = f"{head}.{digits}{rest}"
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        log.debug("unparseable ESS timestamp %r", raw)
        return None


def _yes_no(v: Any) -> int | None:
    """Milestone's string booleans: 'Yes'/'No' (hardwareDriverSettings).

    Returns None for anything unrecognised, so "we were not told" stays
    distinct from "no" — the column feeds the snapshot proxy's scheme choice
    and a wrong default there is a request to the wrong port.
    """
    if isinstance(v, bool):
        return 1 if v else 0
    s = str(v or "").strip().lower()
    if s in ("yes", "true", "1", "enabled"):
        return 1
    if s in ("no", "false", "0", "disabled"):
        return 0
    return None


def _first(d: dict, *keys: str):
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return None


def _hardware_key(cam: dict) -> str:
    """Resolve a camera's parent-hardware id.

    ``/cameras`` does **not** return ``hardwareId`` on this XProtect (confirmed
    live 2026-07-28) — the link is ``relations.parent = {type: "hardware", id}``.
    The previous lookup keyed on ``hardwareId``, so the key was always ``""``,
    the hardware dict was always empty, and ``cameras.ip`` was unconditionally
    NULL even though the fallback to hardware was written. The camera-level
    aliases are kept last for XProtect versions that do expose them.
    """
    rel = cam.get("relations")
    if isinstance(rel, dict):
        candidates: list[Any] = []
        parent = rel.get("parent")
        candidates.extend(parent if isinstance(parent, list) else [parent])
        for extra in ("related", "children", "parents"):
            v = rel.get(extra)
            if isinstance(v, list):
                candidates.extend(v)
        for cand in candidates:
            if not isinstance(cand, dict):
                continue
            if str(cand.get("type") or "").strip().lower() != "hardware":
                continue
            hid = _first(cand, "id", "guid")
            if hid:
                return str(hid)
    return str(_first(cam, "hardwareId", "hardware") or "")


def _relation_id(rec: dict, want_type: str) -> str:
    """The id of a record's parent of a given type.

    Milestone links downward through ``relations.parent = {type, id}``, and the
    type has to be checked rather than assumed — a camera's parent is a
    hardware, a hardware's parent is a recording server, and a recording
    server's parent is the site.
    """
    rel = rec.get("relations")
    if not isinstance(rel, dict):
        return ""
    parent = rel.get("parent")
    for cand in (parent if isinstance(parent, list) else [parent]):
        if isinstance(cand, dict) and str(cand.get("type") or "").lower() == want_type.lower():
            return str(cand.get("id") or "")
    return ""


def _host_from_address(raw: Any) -> str | None:
    """Bare host from Milestone's URL-shaped hardware address.

    Hardware carries ``http://10.x.x.x/`` (100% http, 100% RFC1918, a handful on
    a non-default port). ``cameras.ip`` wants the host alone. The port and scheme
    matter to the D7 snapshot proxy, which must re-derive them from hardware
    rather than assume https — see docs/milestone-camera-addressing.md.
    """
    s = str(raw or "").strip()
    if not s:
        return None
    if "://" not in s:
        s = "//" + s          # bare host/host:port — give urlsplit an authority
    try:
        return urlsplit(s).hostname or None
    except ValueError:
        return None


def _port_from_address(raw: Any) -> int | None:
    """Explicit port from the hardware address, or None for the default.

    Six of 2,489 hardware carry one, and five of those are ``http://<ip>:443/``
    — an http scheme on the port conventionally reserved for TLS. Inferring the
    scheme from the port would contradict what the field says, and dropping the
    port would send D7's snapshot proxy to the wrong socket. Both are easy
    mistakes and neither shows up in a fixture, because a hand-built fixture
    would not contain six oddities out of 2,489.
    """
    s = str(raw or "").strip()
    if not s:
        return None
    if "://" not in s:
        s = "//" + s
    try:
        return urlsplit(s).port
    except ValueError:
        return None


def build_recording_servers(servers: list[dict], reg: dict[str, dict],
                            storage_by_rs: dict[str, dict], now: datetime,
                            ess_rs: dict[str, dict] | None = None) -> list[dict]:
    """Recording-server rows.

    ``ess_rs`` maps the server's Milestone id to the four state verdicts the
    Events/State interface publishes (migration 027). Absent when the ESS could
    not be read, and the columns then stay NULL rather than being guessed from
    the Config API — a NULL renders "—", a guess renders a claim.
    """
    ess_rs = ess_rs or {}
    rows: list[dict] = []
    for srv in servers:
        r = reg.get(str(srv.get("id")))
        if r is None:
            continue
        st = storage_by_rs.get(str(srv.get("id")), {})
        states = ess_rs.get(str(srv.get("id")), {})
        rows.append({
            "device_id": int(r["id"]),
            "hostname": _first(srv, "hostName", "hostname", "name"),
            "role": _first(srv, "role", "serverType"),
            "version": _first(srv, "productVersion", "version"),
            # The Config API reports neither on this deployment (both NULL for
            # all 22), so the real counts come from the cameras table in the
            # API layer, where the link already exists. Kept for versions that
            # do populate them.
            "chans_total": _num(srv.get("cameraCount"), srv.get("channels")),
            "chans_recording": _num(srv.get("recordingCameraCount")),
            "comm_state": states.get("comm_state"),
            "cpu_state": states.get("cpu_state"),
            "retention_state": states.get("retention_state"),
            "service_state": states.get("service_state"),
            "states_at": states.get("states_at"),
            "storage_used_gb": st.get("used_gb"),
            "storage_total_gb": st.get("total_gb"),
            "retention_days": _num(st.get("retention_days"), srv.get("retentionDays")),
            "updated_at": now,
        })
    return rows


def build_cameras(cameras: list[dict], reg: dict[str, dict],
                  hw_by_id: dict[str, dict], rs_devid: dict[str, int], now: datetime,
                  identity: dict[str, dict] | None = None) -> list[dict]:
    """Camera rows.

    ``identity`` maps hardware id → the ``hardwareDriverSettings`` block, which
    is the only place Milestone exposes a MAC, serial or firmware. It is keyed
    by *hardware*, so every camera sharing a physical device gets the same
    values — correct, because they share one NIC (migration 022).

    It is passed in rather than fetched here because it costs one request per
    hardware record and is filled in bounded batches across cycles; a camera
    whose hardware has not been reached yet keeps NULL rather than blocking the
    whole cycle on 2,489 requests.
    """
    identity = identity or {}
    rows: list[dict] = []
    for cam in cameras:
        r = reg.get(str(cam.get("id")))
        if r is None:
            continue
        hw_id = _hardware_key(cam)
        hw = hw_by_id.get(hw_id, {})
        ident = identity.get(hw_id) or {}
        mac = canon_mac(str(_first(cam, "mac", "macAddress")
                            or _first(hw, "mac", "macAddress")
                            or ident.get("macAddress") or ""))
        # The camera→recorder link is TWO hops: camera → relations.parent
        # (hardware) → hardware's relations.parent (recordingServers).
        # `/cameras` carries no recording-server reference at all, so the old
        # lookup for `recordingServerId` was always empty and
        # `recording_server_device_id` has been NULL for every one of the 2,651
        # cameras since Phase 10.4 — which is why the detail page showed "—"
        # for the recorder and why per-recorder camera counts were impossible.
        rs_id = (_relation_id(hw, "recordingServers")
                 or str(_first(cam, "recordingServerId", "recordingServer") or ""))
        rows.append({
            "device_id": int(r["id"]),
            "model": _first(cam, "model", "shortName") or _first(hw, "model"),
            "resolution": _first(cam, "resolution"),
            "fps_target": _num(cam.get("framerate"), cam.get("fps")),
            "codec": _first(cam, "codec"),
            "bitrate_mode": _first(cam, "bitrateMode"),
            "recording_mode": _first(cam, "recordingMode", "recordingType"),
            "state_msg": _first(cam, "stateMessage", "state"),
            "ip": _first(cam, "address", "ip") or _host_from_address(_first(hw, "address", "ip")),
            "http_port": _port_from_address(_first(hw, "address", "ip")),
            # Milestone stores every hardware address as http://, so whether the
            # camera actually speaks TLS has to come from hardwareDriverSettings
            # rather than from the address. `httpSEnabled` is the STRING
            # 'Yes'/'No' — a truthiness test on the raw value would mark every
            # camera TLS-enabled, which is the D7 correction in one line.
            "https_enabled": _yes_no(ident.get("httpSEnabled")),
            "https_port": _num(ident.get("httpSPort")),
            # The physical device. 61 hardware records carry more than one
            # camera here (up to 11 on one AXIS M3007 panoramic), so this is
            # what tells "one device, several cameras" apart from "two devices
            # fighting over an IP" — which the poller's guard cannot otherwise
            # distinguish. See migration 022.
            "hardware_id": hw_id or None,
            # Which imager on a multi-camera device. D7's snapshot path needs
            # it: for a camera that is a channel on a shared encoder a bare
            # /snap.jpg returns the wrong imager (spec 11 D7).
            "channel": _num(cam.get("channel")),
            "mac": mac or None,
            # Per-hardware identity from hardwareDriverSettings (migration 025).
            # Serial is the only stable identity for a camera that has been
            # re-addressed.
            #
            # `firmware` is deliberately NOT here. It is the one identity field
            # with a second writer — `cameras.runner` records what a camera
            # itself reported after a flash — and this row is built from
            # identity captured at the start of the cycle and written by
            # `replace_rows` at the end. Echoing a value read minutes ago would
            # silently undo a verified flash that landed in between, which is
            # exactly what happened on 2026-09-09: 50 updated cameras kept
            # showing their pre-flash version and stayed on the "needs
            # updating" list. Firmware is now written only when Milestone was
            # actually just asked — see `_write_fresh_firmware`. Omitting the
            # key means `replace_rows` does not touch the column, so a stored
            # value survives untouched rather than being blanked.
            "serial": (ident.get("serialNumber") or None),
            "vendor": (ident.get("productID") or None),
            # The marker the backfill gates on. Set whenever settings for this
            # hardware are in hand — freshly fetched or read back from the row —
            # so a hardware that reports nothing is asked once, not every cycle.
            "identity_at": (now if ident else None),   # `ident` non-empty ⇒ asked
            "recording_server_device_id": rs_devid.get(rs_id),
            "enabled": 1 if _truthy(cam.get("enabled"), cam.get("recordingEnabled")) else 0,
            "updated_at": now,
        })
    return rows


def group_children(node: dict, key: str) -> list[dict]:
    """Child records of a camera-group node, whichever shape the API used.

    2025 R2 returns children inline at the top level (``node["cameras"]``); the
    documented/older shape nests them under ``node["children"]``. Reading only
    one of the two is how the reference collector ended up with every camera
    under a single label on some installs.
    """
    v = node.get(key)
    if isinstance(v, list):
        return [x for x in v if isinstance(x, dict)]
    kids = node.get("children")
    if isinstance(kids, dict):
        v = kids.get(key)
        if isinstance(v, list):
            return [x for x in v if isinstance(x, dict)]
    # A bare list of children means subgroups in the one shape that omits the key.
    if isinstance(kids, list) and key == "cameraGroups":
        return [x for x in kids if isinstance(x, dict)]
    return []


def flatten_camera_groups(roots: list[dict], reg: dict[str, dict], now: datetime,
                          ) -> tuple[list[dict], list[dict]]:
    """Depth-first walk → (`camera_groups` rows, `camera_group_members` rows).

    Ported from `reference/zabbix/externalscripts-deployed/milestone_groups_state.py`
    so the tree NetMon renders and the tree Smart Client shows are built by the
    same rules.

    `camera_count` is what Milestone reports for the group — every child camera,
    including ones NetMon has no registry device for. The membership rows only
    cover cameras that *are* in the registry, so a group whose count exceeds its
    membership rows is a real signal (cameras present in the VMS but never
    imported), and the API surfaces the gap rather than papering over it.
    """
    groups: list[dict] = []
    members: list[dict] = []
    seen_members: set[tuple[str, int]] = set()

    def visit(node: dict, parent_id: str | None, parent_path: str) -> None:
        gid = str(node.get("id") or "")
        if not gid:
            return
        name = str(node.get("displayName") or node.get("name")
                   or node.get("description") or gid)
        path = f"{parent_path}/{name}" if parent_path else name
        cams = group_children(node, "cameras")
        groups.append({
            "id": gid,
            "name": name[:128],
            "description": (str(node.get("description")) or None) if node.get("description") else None,
            "parent_id": parent_id,
            "path": path[:512],
            "camera_count": len(cams),
            "updated_at": now,
        })
        for cam in cams:
            r = reg.get(str(cam.get("id")))
            if r is None:
                continue
            # 25 cameras on this estate belong to two groups; the PK tolerates
            # that. What it must not see twice is the same pair, which a
            # malformed payload could produce.
            key = (gid, int(r["id"]))
            if key in seen_members:
                continue
            seen_members.add(key)
            members.append({"group_id": gid, "device_id": int(r["id"]), "updated_at": now})
        for sub in group_children(node, "cameraGroups"):
            visit(sub, gid, path)

    for g in roots or []:
        if isinstance(g, dict):
            visit(g, None, "")
    return groups, members


class MilestoneCollector(Collector):
    name = "milestone"

    def __init__(self, engine: Engine, client: MilestoneClient, interval_s: float = 120.0,
                 ess_enabled: bool = True, blind_after_failures: int = 3,
                 identity_batch: int = 150, identity_concurrency: int = 6) -> None:
        super().__init__(engine)
        self.client = client
        # One WebSocket getState per cycle (~4 MB on this estate). Default on
        # because it replaces 2,659 stale `blind` rows with a real verdict;
        # disableable without a deploy, and failure is soft either way.
        self.ess_enabled = ess_enabled
        self._etypes: dict[str, str] = {}
        # Consecutive failures before declaring every device blind. One blip
        # must not erase good state; a real outage must not read as healthy.
        self.blind_after_failures = blind_after_failures
        self._consecutive_failures = 0
        # Per-cycle ceiling on the MAC/serial/firmware backfill. 150 at a
        # 120s interval fills 2,489 hardware in roughly half an hour and then
        # costs nothing. 0 disables the backfill outright (§4.3) — the rest of
        # the cycle is unaffected and MACs already stored are kept.
        self.identity_batch = identity_batch
        #: Hardware ids Milestone answered for this cycle. Gates the firmware
        #: write so an echoed value can never undo a verified flash.
        self._fresh_identity: set[str] = set()
        self.identity_concurrency = max(1, identity_concurrency)
        self.interval_s = interval_s
        # Headroom over the interval, not equal to it. The cycle's own work is
        # ~20s (measured: 21s of HTTP, three batched statements of DB), but this
        # collector shares a box with the SNMP inventory sweep, which runs 156s
        # — so a perfectly healthy Milestone cycle measures 110s when the two
        # overlap. Tying the boundary to the interval killed those cycles, and
        # three killed cycles in a row used to blind 940 cameras.
        #
        # 2.5× the interval: long enough that contention alone cannot trip it,
        # short enough that a genuinely hung cycle is still cancelled rather
        # than waited out forever. Overlapping runs are not a risk — the
        # supervisor reschedules after completion, it does not fire concurrently.
        self.timeout_s = max(300.0, interval_s * 2.5)

    @classmethod
    def from_config(cls, engine: Engine, cfg: Config) -> "MilestoneCollector":
        s = (cfg.sources.get("milestone").settings if cfg.sources.get("milestone") else {})
        client = MilestoneClient(
            host=(s.get("host") or "").strip(),
            user=(s.get("user") or "").strip(),
            password=s.get("pass") or "",
            scheme=(s.get("scheme") or "https").strip(),
            client_id=(s.get("client_id") or "GrantValidatorClient").strip(),
            verify_ssl=str(s.get("verify_ssl", "true")).strip().lower() in ("1", "true", "yes", "on"),
        )
        return cls(engine, client, interval_s=int(s.get("interval_s") or 120),
                   identity_batch=int(s.get("identity_batch", 150) or 0),
                   identity_concurrency=int(s.get("identity_concurrency") or 6))

    def _by_milestone_id(self) -> dict[str, dict]:
        rows = db.fetch_all(
            self.engine,
            "SELECT id, device_type, milestone_hardware_id FROM devices "
            "WHERE enabled = 1 AND milestone_hardware_id IS NOT NULL AND milestone_hardware_id <> ''",
        )
        return {str(r["milestone_hardware_id"]): r for r in rows}

    def _sync_camera_addresses(self, cam_rows: list[dict]) -> int:
        """Push the Milestone-derived address into the registry.

        The address lives on the hardware parent, so it only ever reached the
        `cameras` snapshot — `devices.mgmt_ip` was NULL for all 2,659 cameras.
        That is the M0 gap: the registry is what the poller, the D7 proxy and
        D10 read, so an address that never lands there gates all three.

        Milestone is authoritative for a camera's address, so this syncs rather
        than fills-if-empty: a camera that is re-addressed should follow, and a
        stale manual value would be worse than no value. Only rows whose
        address actually changed are written, so a steady state costs nothing.
        """
        updates = [(c["device_id"], c["ip"]) for c in cam_rows if c.get("ip")]
        if not updates:
            return 0
        current = {r["id"]: r["mgmt_ip"] for r in db.fetch_all(
            self.engine,
            "SELECT id, mgmt_ip FROM devices WHERE device_type = 'camera'")}
        changed = [(did, ip) for did, ip in updates if current.get(did) != ip]
        for did, ip in changed:
            db.execute(self.engine,
                       "UPDATE devices SET mgmt_ip = :ip WHERE id = :id",
                       {"ip": ip, "id": did})
        if changed:
            log.info("milestone: synced mgmt_ip for %d camera(s)", len(changed))
        return len(changed)

    def _write_fresh_firmware(self, cam_rows: list[dict], identity: dict[str, dict]) -> int:
        """Write `cameras.firmware`, but only for hardware asked this cycle.

        The bulk row write no longer carries firmware (see `_camera_rows`),
        because echoing a stale value undid verified flashes. This writes it
        where Milestone genuinely just answered — a first-time backfill, or a
        replaced device arriving as new hardware — and stays silent otherwise,
        leaving whatever the runner recorded in place.

        Cameras sharing one hardware all get the same value, which is right:
        one device, one NIC, one firmware.
        """
        if not self._fresh_identity:
            return 0
        written = 0
        for row in cam_rows:
            hw_id = row.get("hardware_id")
            if not hw_id or hw_id not in self._fresh_identity:
                continue
            version = (identity.get(hw_id) or {}).get("firmwareVersion")
            version = str(version).strip() if version else ""
            if not version:
                continue
            written += db.execute(
                self.engine,
                "UPDATE cameras SET firmware = :f WHERE device_id = :d "
                "AND (firmware IS NULL OR firmware <> :f)",
                {"f": version, "d": int(row["device_id"])},
            )
        if written:
            log.info("milestone identity: firmware written for %d camera(s) "
                     "freshly read this cycle", written)
        return written

    def _known_identity(self) -> tuple[dict[str, dict], set[str]]:
        """Identity already stored, and which hardware has been asked.

        Two different questions, and conflating them blanked 2,496 MACs on the
        live estate for as long as it took the backfill to come round again:

          * **what do we already know** — every hardware with anything stored.
            ``replace_rows`` rewrites the whole camera row, so this has to be
            supplied on every cycle or the fields are silently cleared for any
            hardware not in this cycle's batch.
          * **what still needs asking** — hardware whose ``identity_at`` is
            NULL. A record that reports no MAC has nothing stored but has been
            asked, and must not be asked again every cycle forever.

        Returns ``(stored, asked)``.
        """
        out: dict[str, dict] = {}
        # Completeness is "we asked and stored the answer" (`identity_at`), not
        # "a field came back non-empty". Two reasons, both found the hard way:
        # keying on the MAC meant a hardware that reports none was re-fetched
        # every cycle forever, and when migration 027 added two more fields from
        # the same response, a MAC-only gate skipped the whole estate as already
        # done so the new columns were never collected for a single camera.
        # Migration 027 leaves the marker NULL, which re-runs the backfill once.
        asked: set[str] = set()
        for r in db.fetch_all(
                self.engine,
                "SELECT hardware_id, mac, firmware, serial, vendor, "
                "       https_enabled, https_port, "
                "       MAX(identity_at) AS identity_at FROM cameras "
                "WHERE hardware_id IS NOT NULL "
                "GROUP BY hardware_id, mac, firmware, serial, vendor, "
                "         https_enabled, https_port"):
            if r["identity_at"] is not None:
                asked.add(str(r["hardware_id"]))
            if not any(r[k] is not None for k in
                       ("mac", "firmware", "serial", "vendor", "https_enabled")):
                continue
            out[str(r["hardware_id"])] = {
                "macAddress": r["mac"],
                "firmwareVersion": r["firmware"],
                "serialNumber": r["serial"],
                "productID": r["vendor"],
                # None stays None: "the device did not tell us" must not be
                # rewritten as "No", which the proxy would act on.
                "httpSEnabled": (None if r["https_enabled"] is None
                                 else ("Yes" if r["https_enabled"] else "No")),
                "httpSPort": r["https_port"],
            }
        return out, asked

    async def _device_identity(self, cameras: list[dict],
                               degraded: list[str]) -> dict[str, dict]:
        """MAC/serial/firmware per hardware, backfilled a batch at a time.

        There is no collection form of ``hardwareDriverSettings`` — asking for
        one answers 400 telling you to prefix it with a parent — so this is one
        request per hardware record, ~300 ms each. Sweeping all 2,489 every
        cycle would be ~12 minutes of gateway traffic every 2 minutes, so
        instead each cycle fetches at most ``identity_batch`` of the records
        that have no MAC yet. At the defaults the estate fills in about half an
        hour and then costs nothing, because everything is known.

        These are near-static facts — a MAC changes when the hardware is
        replaced, which also changes the hardware id — so there is no refresh
        pass. A replaced device arrives as a new hardware record with no MAC and
        is picked up by the same backfill.

        Failure is soft and per-record: a camera whose hardware could not be
        read keeps NULL rather than losing the cycle. `identity` is added to
        `degraded` so a stalled backfill is visible instead of looking finished.
        """
        known, asked = self._known_identity()
        if not self.identity_batch:
            return known

        # Queue on "not asked", not on "nothing stored": a hardware that
        # reports no MAC has nothing to store and must still count as done.
        pending = []
        seen = set()
        for cam in cameras:
            hw_id = _hardware_key(cam)
            if hw_id and hw_id not in asked and hw_id not in seen:
                seen.add(hw_id)
                pending.append(hw_id)
        if not pending:
            return known

        batch = pending[:self.identity_batch]
        sem = asyncio.Semaphore(self.identity_concurrency)
        failures = 0
        # Which hardware Milestone answered for *this cycle*. Only these may
        # write `cameras.firmware`; see `_camera_rows`.
        fresh: set[str] = set()

        async def one(hw_id: str) -> None:
            nonlocal failures
            async with sem:
                try:
                    settings = await self.client.hardware_driver_settings(hw_id)
                except MilestoneError:
                    failures += 1
                    return
            # Stored whatever came back, including an empty response: the point
            # of the marker is that this hardware has been asked. The empty dict
            # would be falsy, so mark it explicitly.
            known[hw_id] = settings or {"__asked": True}
            fresh.add(hw_id)

        await asyncio.gather(*(one(h) for h in batch))
        self._fresh_identity = fresh
        if failures:
            degraded.append("identity")
        log.info("milestone identity backfill: %d fetched, %d failed, "
                 "%d of %d hardware still unknown",
                 len(batch) - failures, failures,
                 max(0, len(pending) - (len(batch) - failures)), len(pending))
        return known

    async def _ess_state(self) -> tuple[dict[str, tuple[str, str]], dict[str, dict]] | None:
        """One Events/State snapshot → camera verdicts and recorder states.

        The subscription asked for ``resourceTypes: ["cameras"]``, so recording
        servers were never delivered and their status came from the Config API's
        `running` flag. Asking for both in the same filter — still the three
        approved read-only verbs (D5) — yields 152 recorder states across all 22
        servers, including a retention warning and a CPU verdict nothing else
        here can see.

        Returns ``(camera_verdicts, rs_states)`` or ``None`` on any failure: the
        ESS is enrichment, and a WebSocket problem must not fail a Config-API
        cycle that otherwise succeeded. The caller records the degradation so it
        is visible rather than silent (§4.5).
        """
        try:
            ess = MilestoneEss(self.client, resource_types=("cameras", "recordingServers"))
            async with ess.connect() as conn:
                await ess.handshake(conn)
                states = (ess.initial_state or {}).get("states") or []
            if not states:
                return None
            names = await self._event_type_names()
            cams: dict[str, tuple[str, str]] = {}
            servers: dict[str, dict] = {}
            for st in states:
                source = str(st.get("source") or "")
                guid = source.split("/")[-1]
                name = names.get(str(st.get("type"))) or ""
                if not guid or not name:
                    continue
                if source.startswith("recordingServers/"):
                    row = servers.setdefault(guid, {})
                    for prefix, column in ESS_RS_COLUMNS:
                        if name.startswith(prefix):
                            row[column] = name
                            break
                    # Newest state timestamp, so the UI can age the whole set
                    # rather than implying every verdict is current.
                    when = _ess_time(st.get("time"))
                    if when and (row.get("states_at") is None or when > row["states_at"]):
                        row["states_at"] = when
                elif source.startswith("cameras/"):
                    verdict = ESS_COMMUNICATION.get(name)
                    if verdict:
                        cams[guid] = verdict
            return cams, servers
        except Exception as exc:                      # noqa: BLE001 — enrichment
            log.warning("milestone ESS state unavailable, status left "
                        "as-is rather than guessed: %s", exc)
            return None

    async def _event_type_names(self) -> dict[str, str]:
        """GUID → event-type name, from the Config API. Cached for the process."""
        if getattr(self, "_etypes", None):
            return self._etypes
        rows = await self.client.event_types()
        self._etypes = {str(t.get("id")): str(t.get("name") or "") for t in rows}
        return self._etypes

    async def run_once(self) -> int:
        registry = self._by_milestone_id()
        try:
            servers = await self.client.recording_servers()
            cameras = await self.client.cameras()
        except MilestoneError:
            # Do NOT blind every device on a single transport error. CLAUDE.md
            # §4.5 says a failing collector records the failure and leaves prior
            # state *visibly stale*, never overwrites it — and this path was
            # doing the overwrite. On 2026-09-06 one transient error on
            # /cameras wiped ESS-derived status for all 2,659 cameras 90 seconds
            # after a clean cycle, and the result read as "0 cameras down": a
            # total recovery, from losing the signal. That is the most dangerous
            # shape a monitoring bug can take.
            #
            # Blind is still written when the source is *persistently* gone,
            # because then "we cannot see" is the truth and stale rows would
            # read as healthy. The threshold distinguishes a blip from an
            # outage; collector_health records the failure either way.
            self._consecutive_failures += 1
            if self._consecutive_failures >= self.blind_after_failures:
                # One more question before declaring the estate blind: is the
                # gateway actually unreachable, or was a bulk endpoint merely
                # slow? `/cameras` is 2.9 MB and its latency swings from 5s to
                # 19s, so three timeouts in a row is weak evidence that the VMS
                # is gone — and blinding on it manufactured an estate-wide
                # outage roughly eleven times a day, 940 cameras at a time,
                # about 19,000 state events daily. `/sites` is one small record
                # and answers in milliseconds; if it answers, the source is not
                # blind and the honest state is the previous one, left visibly
                # stale (§4.5).
                alive = False
                try:
                    alive = bool(await self.client.site_info())
                except MilestoneError:
                    alive = False
                if alive:
                    log.warning(
                        "milestone bulk endpoint failed %d cycle(s) in a row but the "
                        "gateway answers /sites — leaving prior state stale rather "
                        "than blinding %d device(s); the slow endpoint is the fault",
                        self._consecutive_failures, len(registry))
                    raise
                blind_rows = [(int(r["id"]), "source_status", "blind", "warn", "milestone")
                              for r in registry.values()]
                write_states(self.engine, blind_rows)
                log.warning("milestone unreachable for %d consecutive cycle(s) — "
                            "marking %d device(s) blind",
                            self._consecutive_failures, len(registry))
            else:
                log.warning("milestone cycle failed (%d/%d before blinding); prior "
                            "state left stale rather than overwritten",
                            self._consecutive_failures, self.blind_after_failures)
            raise

        self._consecutive_failures = 0
        now = datetime.now(timezone.utc)
        written = 0
        # Declared here because the ESS status fetch below can degrade, and it
        # runs before the Config-API enrichment block that used to own this.
        degraded: list[str] = []

        # Per-camera status, which the Config API cannot answer at all. Cameras
        # carried `source_status = blind` for exactly that reason — an honest
        # "cannot tell" — but nothing on the success path ever cleared it, so
        # 2,659 rows sat two days stale and held 2,659 open alerts. The ESS can
        # tell; None means it could not be reached, and prior state is then left
        # untouched rather than downgraded to a guess.
        ess = await self._ess_state() if self.ess_enabled else None
        if self.ess_enabled and ess is None:
            degraded.append("ess")
        ess_status, ess_rs = (ess if ess else ({}, {}))
        # An empty camera map means the ESS could not be read at all; prior
        # state is then left untouched rather than downgraded to a guess.
        ess_status = ess_status or None

        # State writes (unchanged contract) + RS device-id map for camera links.
        rs_devid: dict[str, int] = {}
        linked_servers = linked_cameras = 0
        for srv in servers:
            r = registry.get(str(srv.get("id")))
            if r is None:
                continue
            linked_servers += 1
            rs_devid[str(srv.get("id"))] = int(r["id"])
            # The ESS's Communication state is the better verdict where it is
            # available: the Config API's `running` flag describes the server
            # object's configuration, not whether the VMS is currently talking
            # to it. Falls back to the flag when the ESS could not be read.
            states = ess_rs.get(str(srv.get("id"))) or {}
            comm = states.get("comm_state") or ""
            if comm:
                # Milestone is inconsistent with its own state names: cameras
                # and recorders both report "CommunicationStarted" with no
                # space, while the sibling groups are "CPU Usage Normal" and
                # "Retention time Normal" *with* spaces. Matching the spaced
                # form alone marked all 22 recorders down.
                up = "started" in comm.replace(" ", "").lower()
                write_state(self.engine, int(r["id"]), "source_status",
                            "up" if up else "down", "ok" if up else "crit",
                            "milestone-ess")
            else:
                running = _truthy(srv.get("running"), srv.get("state"), srv.get("enabled"))
                write_state(self.engine, int(r["id"]), "source_status",
                            "up" if running else "down",
                            "ok" if running else "crit", "milestone")
            written += 1
        # Batched rather than one call per camera per dimension. Per-call, this
        # loop was over 5,000 write_state invocations — each a SELECT plus an
        # upsert in its own transaction, so more than 10,000 round trips — which
        # measured 68s of the collector's 120s supervisor boundary and timed out
        # 61 of 517 cycles. The HTTP it looked like a network problem for
        # totals 21s.
        cam_states: list[tuple[int, str, str, str, str]] = []
        for cam in cameras:
            r = registry.get(str(cam.get("id")))
            if r is None:
                continue
            linked_cameras += 1
            # `recording` is NOT measured, and must not claim to be.
            #
            # It used to be derived from `recordingEnabled`/`enabled`, which are
            # *configuration* — "is this camera set up to record" — so it read
            # `up`/`ok` for all 2,659 devices on this estate and never moved.
            # On 2026-09-11 at 19:49:14 all 234 cameras behind NHS-BCD-DVR
            # stopped recording when the recorder filled up; this dimension went
            # on reporting `recording = up, severity = ok` for every one of
            # them, which is precisely the fabricated-health failure §4.5 exists
            # to forbid.
            #
            # Nothing available measures the real thing. ESS publishes Recording
            # events, but recording here is motion-triggered, so
            # `RecordingStopped` is the ordinary resting state (owner,
            # 2026-09-04) and consumed disk space needs WinRM, which NetMon does
            # not have (OpenProject #111). So the honest value is `unknown`.
            #
            # The configuration flag itself is not lost: `build_cameras` already
            # persists it as `cameras.enabled` from the same fields, where it
            # reads as the inventory fact it is.
            cam_states.append((int(r["id"]), "recording", "unknown", "unknown",
                               "milestone"))
            if ess_status is not None:
                # A camera absent from the snapshot has no Communication state
                # published, which is not the same as being down.
                verdict = ess_status.get(str(cam.get("id")))
                if verdict:
                    cam_states.append((int(r["id"]), "source_status",
                                       verdict[0], verdict[1], "milestone-ess"))
        write_states(self.engine, cam_states)
        written += len(cam_states)

        # Fail loud on the silent-empty trap: Milestone answered, but none of its
        # entities are linked to a registry device (nothing seeded
        # milestone_hardware_id). Without this the run "succeeds" writing 0 rows
        # and the page is mysteriously blank (§4.5). The overview snapshot below
        # carries the discovered-vs-linked counts so the UI can point at the fix.
        if (servers or cameras) and not (linked_servers or linked_cameras):
            log.warning(
                "Milestone returned %d server(s) + %d camera(s) but NONE are "
                "linked to a registry device — import them via Registry → Import "
                "from Milestone (nothing populates milestone_hardware_id otherwise).",
                len(servers), len(cameras),
            )

        # Optional enrichment — fail-soft (older XProtect lacks these
        # endpoints), but NOT silent. A degradation nobody can see is the
        # failure mode §4.5 exists to prevent: /storages has been answering
        # HTTP 400 on this deployment and the storage roll-up was empty while
        # the collector reported success (found 2026-07-28 by
        # scripts/validate_payloads.py). Record which enrichments degraded so
        # the NetMon Status page and the overview blob can say so.
        storage_by_rs: dict[str, dict] = {}
        try:
            for st in await self.client.storage([str(x.get("id")) for x in servers if x.get("id")]):
                rs = str(st.get("recordingServerId") or "")
                agg = storage_by_rs.setdefault(
                    rs, {"used_gb": None, "total_gb": 0.0, "retention_days": None})
                # maxSize is MEGABYTES, confirmed against the estate: NHS's live
                # storage reads 103,014,400, which is its documented 100,600 GB
                # (103,014,400 / 1024). Dividing by 1e9 as though it were bytes
                # rendered every recorder as 0 GB.
                agg["total_gb"] += (_num(st.get("maxSize")) or 0) / 1024
                for arc in st.get("archives") or []:
                    agg["total_gb"] += (_num(arc.get("maxSize")) or 0) / 1024
                # Archive retention in XProtect is CUMULATIVE from the moment of
                # recording, not additive on top of the live storage — so the
                # total a recorder actually holds is MAX(retainMinutes), never
                # SUM. Summing NHS would claim 106 days where it keeps 61.
                mins = [_num(st.get("retainMinutes")) or 0]
                mins += [_num(a.get("retainMinutes")) or 0 for a in st.get("archives") or []]
                days = max(mins) / 1440 if mins else 0
                agg["retention_days"] = max(agg["retention_days"] or 0, round(days))
        except MilestoneError as exc:
            degraded.append("storage")
            log.warning("milestone storage walk failed — storage roll-up "
                        "will be empty, not zero: %s", exc)

        hw_by_id: dict[str, dict] = {}
        try:
            hw_by_id = {str(h.get("id")): h for h in await self.client.hardware()}
        except MilestoneError as exc:
            degraded.append("hardware")
            log.warning("milestone hardware endpoint unavailable — camera hardware "
                        "enrichment missing: %s", exc)

        identity = await self._device_identity(cameras, degraded)

        # Environment facts for the page header and the XProtect roll-up. Both
        # are single small GETs; both fail soft, because a missing version
        # should cost the version and nothing else.
        site_info: dict = {}
        try:
            site_info = await self.client.site_info()
        except MilestoneError as exc:
            degraded.append("site")
            log.warning("milestone /sites unavailable — management server and "
                        "version will read '—': %s", exc)
        licences: list[dict] = []
        try:
            licences = await self.client.license_details()
        except MilestoneError as exc:
            degraded.append("license")
            log.warning("milestone /licenseDetails unavailable: %s", exc)
        # "Device License" is the row that counts cameras. `activated` arrives
        # as a string, and there is NO total in this response or in
        # /licenseInformations — Professional+ is licensed per activated device,
        # so the "used of total" ratio ZCD draws as a bar does not exist to be
        # read. What is here is reported; nothing is inferred.
        device_lic = next((l for l in licences
                           if str(l.get("licenseType") or "").lower().startswith("device")), {})

        rs_rows = build_recording_servers(servers, registry, storage_by_rs, now, ess_rs)
        cam_rows = build_cameras(cameras, registry, hw_by_id, rs_devid, now, identity)
        written += db.replace_rows(self.engine, "recording_servers", ["device_id"], rs_rows)
        written += db.replace_rows(self.engine, "cameras", ["device_id"], cam_rows)
        written += self._write_fresh_firmware(cam_rows, identity)
        written += self._sync_camera_addresses(cam_rows)

        # The Smart Client organisational tree (migration 026) — how the
        # surveillance team navigates, as distinct from `devices.site`, which is
        # how the network is organised.
        #
        # Fetched and written AFTER the inventory above, deliberately: this is
        # one more request against the same gateway, and a tree that fails must
        # cost only the tree. Doing it earlier meant an error here skipped the
        # camera and recording-server writes entirely — a navigation aid taking
        # the estate's inventory down with it.
        group_rows: list[dict] = []
        member_rows: list[dict] = []
        try:
            group_rows, member_rows = flatten_camera_groups(
                await self.client.camera_groups(), registry, now)
        except MilestoneError as exc:
            degraded.append("groups")
            log.warning("milestone cameraGroups walk failed — the camera tree "
                        "will be stale, not empty: %s", exc)
        # Only on a successful walk: replace_rows prunes what it did not see, so
        # writing an empty list after a failed fetch would delete the tree —
        # exactly the "overwrite prior state on error" shape §4.5 forbids.
        if group_rows:
            written += db.replace_rows(self.engine, "camera_groups", ["id"], group_rows)
            written += db.replace_rows(self.engine, "camera_group_members",
                                       ["group_id", "device_id"], member_rows)

        # Environment overview singleton. `discovered_*` is what Milestone
        # returned; `recording_servers`/`cameras` are what actually linked to the
        # registry — a gap between them means devices need importing (surfaced on
        # the Surveillance page).
        write_snapshot(self.engine, "milestone.overview", {
            "recording_servers": len(rs_rows),
            "cameras": len(cam_rows),
            "cameras_recording": sum(1 for c in cam_rows if c["enabled"]),
            "discovered_servers": len(servers),
            "discovered_cameras": len(cameras),
            "linked_servers": linked_servers,
            "linked_cameras": linked_cameras,
            "storage_used_gb": round(sum(r["storage_used_gb"] or 0 for r in rs_rows), 1),
            "storage_total_gb": round(sum(r["storage_total_gb"] or 0 for r in rs_rows), 1),
            # The camera tree. `group_memberships` counts registry-linked
            # cameras and `group_cameras` what Milestone reports, so a gap
            # between them is visible rather than inferred.
            "management_server": _first(site_info, "displayName", "computerName") or None,
            "version": site_info.get("version") or None,
            "time_zone": site_info.get("timeZone") or None,
            "license_product": _first(device_lic, "displayName") or None,
            "license_activated": _num(device_lic.get("activated")),
            "license_not_licensed": _num(device_lic.get("notLicensed")),
            "license_in_grace": _num(device_lic.get("inGrace")),
            "camera_groups": len(group_rows),
            "group_memberships": len(member_rows),
            "group_cameras": sum(r["camera_count"] for r in group_rows),
            # Which enrichments failed this cycle. Without this a 0 GB storage
            # roll-up is indistinguishable from "the endpoint 400s", and the UI
            # would render an outright absence of data as "nothing used".
            "degraded": degraded,
        }, self.name)
        return written


def main(argv: list[str] | None = None) -> int:
    try:
        return run_standalone(lambda engine, cfg: MilestoneCollector.from_config(engine, cfg), argv)
    except MilestoneError as exc:
        print(f"error: {exc} — set [milestone] host/user/pass in the config.", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
