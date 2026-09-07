"""Milestone collector — recording-server + camera state and inventory.

State (device_state, unchanged): recording servers → ``source_status``,
cameras → ``recording``. Blind on unreachable.

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
from netmon.state import write_state
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
                            storage_by_rs: dict[str, dict], now: datetime) -> list[dict]:
    rows: list[dict] = []
    for srv in servers:
        r = reg.get(str(srv.get("id")))
        if r is None:
            continue
        st = storage_by_rs.get(str(srv.get("id")), {})
        rows.append({
            "device_id": int(r["id"]),
            "hostname": _first(srv, "hostName", "hostname", "name"),
            "role": _first(srv, "role", "serverType"),
            "version": _first(srv, "productVersion", "version"),
            "chans_total": _num(srv.get("cameraCount"), srv.get("channels")),
            "chans_recording": _num(srv.get("recordingCameraCount")),
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
        rs_id = str(_first(cam, "recordingServerId", "recordingServer") or "")
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
            # The physical device. 61 hardware records carry more than one
            # camera here (up to 11 on one AXIS M3007 panoramic), so this is
            # what tells "one device, several cameras" apart from "two devices
            # fighting over an IP" — which the poller's guard cannot otherwise
            # distinguish. See migration 022.
            "hardware_id": hw_id or None,
            "mac": mac or None,
            # Per-hardware identity from hardwareDriverSettings (migration 025).
            # Firmware picks the SNMP profile for D10; serial is the only stable
            # identity for a camera that has been re-addressed.
            "firmware": (ident.get("firmwareVersion") or None),
            "serial": (ident.get("serialNumber") or None),
            "vendor": (ident.get("productID") or None),
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
        self.identity_concurrency = max(1, identity_concurrency)
        self.interval_s = interval_s
        self.timeout_s = max(60.0, interval_s)

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

    def _known_identity(self) -> dict[str, dict]:
        """Identity already in the DB, keyed by hardware id.

        Read back each cycle so the batch below only has to fetch what is
        missing, and so a camera keeps its MAC on cycles where its hardware is
        not in the batch — ``replace_rows`` rewrites the whole row, so anything
        not re-supplied would be blanked.
        """
        out: dict[str, dict] = {}
        for r in db.fetch_all(
                self.engine,
                "SELECT hardware_id, mac, firmware, serial, vendor FROM cameras "
                "WHERE hardware_id IS NOT NULL AND mac IS NOT NULL "
                "GROUP BY hardware_id, mac, firmware, serial, vendor"):
            out[str(r["hardware_id"])] = {"macAddress": r["mac"],
                                          "firmwareVersion": r["firmware"],
                                          "serialNumber": r["serial"],
                                          "productID": r["vendor"]}
        return out

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
        known = self._known_identity()
        if not self.identity_batch:
            return known

        pending = []
        seen = set()
        for cam in cameras:
            hw_id = _hardware_key(cam)
            if hw_id and hw_id not in known and hw_id not in seen:
                seen.add(hw_id)
                pending.append(hw_id)
        if not pending:
            return known

        batch = pending[:self.identity_batch]
        sem = asyncio.Semaphore(self.identity_concurrency)
        failures = 0

        async def one(hw_id: str) -> None:
            nonlocal failures
            async with sem:
                try:
                    settings = await self.client.hardware_driver_settings(hw_id)
                except MilestoneError:
                    failures += 1
                    return
            if settings.get("macAddress"):
                known[hw_id] = settings

        await asyncio.gather(*(one(h) for h in batch))
        if failures:
            degraded.append("identity")
        log.info("milestone identity backfill: %d fetched, %d failed, "
                 "%d of %d hardware still unknown",
                 len(batch) - failures, failures,
                 max(0, len(pending) - (len(batch) - failures)), len(pending))
        return known

    async def _ess_camera_status(self) -> dict[str, tuple[str, str]] | None:
        """Per-camera Communication state from the Events/State interface.

        The Config API has no per-camera status field at all, which is why
        cameras carried `source_status = blind` — an honest "cannot tell". The
        ESS can tell, so this replaces the blind rows with a real verdict.

        Returns ``None`` on any failure rather than raising: the ESS is
        enrichment, and a WebSocket problem must not fail a Config-API cycle
        that otherwise succeeded. The caller records the degradation so it is
        visible rather than silent (§4.5).
        """
        try:
            ess = MilestoneEss(self.client)
            async with ess.connect() as conn:
                await ess.handshake(conn)
                states = (ess.initial_state or {}).get("states") or []
            if not states:
                return None
            names = await self._event_type_names()
            out: dict[str, tuple[str, str]] = {}
            for st in states:
                verdict = ESS_COMMUNICATION.get(names.get(str(st.get("type"))) or "")
                if not verdict:
                    continue
                guid = str(st.get("source") or "").split("/")[-1]
                if guid:
                    out[guid] = verdict
            return out or None
        except Exception as exc:                      # noqa: BLE001 — enrichment
            log.warning("milestone ESS state unavailable, camera status left "
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
                for r in registry.values():
                    write_state(self.engine, int(r["id"]), "source_status",
                                "blind", "warn", "milestone")
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

        # State writes (unchanged contract) + RS device-id map for camera links.
        rs_devid: dict[str, int] = {}
        linked_servers = linked_cameras = 0
        for srv in servers:
            r = registry.get(str(srv.get("id")))
            if r is None:
                continue
            linked_servers += 1
            rs_devid[str(srv.get("id"))] = int(r["id"])
            running = _truthy(srv.get("running"), srv.get("state"), srv.get("enabled"))
            write_state(self.engine, int(r["id"]), "source_status",
                        "up" if running else "down", "ok" if running else "crit", "milestone")
            written += 1
        # Per-camera status, which the Config API cannot answer at all. Cameras
        # carried `source_status = blind` for exactly that reason — an honest
        # "cannot tell" — but nothing on the success path ever cleared it, so
        # 2,659 rows sat two days stale and held 2,659 open alerts. The ESS can
        # tell; None means it could not be reached, and prior state is then left
        # untouched rather than downgraded to a guess.
        ess_status = await self._ess_camera_status() if self.ess_enabled else None
        if self.ess_enabled and ess_status is None:
            degraded.append("ess")

        for cam in cameras:
            r = registry.get(str(cam.get("id")))
            if r is None:
                continue
            linked_cameras += 1
            recording = _truthy(cam.get("recordingEnabled"), cam.get("recording"), cam.get("enabled"))
            write_state(self.engine, int(r["id"]), "recording",
                        "up" if recording else "down", "ok" if recording else "crit", "milestone")
            written += 1
            if ess_status is not None:
                # A camera absent from the snapshot has no Communication state
                # published, which is not the same as being down.
                verdict = ess_status.get(str(cam.get("id")))
                if verdict:
                    write_state(self.engine, int(r["id"]), "source_status",
                                verdict[0], verdict[1], "milestone-ess")
                    written += 1

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

        rs_rows = build_recording_servers(servers, registry, storage_by_rs, now)
        cam_rows = build_cameras(cameras, registry, hw_by_id, rs_devid, now, identity)
        written += db.replace_rows(self.engine, "recording_servers", ["device_id"], rs_rows)
        written += db.replace_rows(self.engine, "cameras", ["device_id"], cam_rows)
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
