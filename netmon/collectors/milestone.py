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

import logging
import sys
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.collectors.base import Collector, run_standalone
from netmon.collectors.milestone_client import MilestoneClient, MilestoneError
from netmon.config import Config
from netmon.seed import canon_mac
from netmon.snapshots import write_snapshot
from netmon.state import write_state

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
                  hw_by_id: dict[str, dict], rs_devid: dict[str, int], now: datetime) -> list[dict]:
    rows: list[dict] = []
    for cam in cameras:
        r = reg.get(str(cam.get("id")))
        if r is None:
            continue
        hw = hw_by_id.get(str(_first(cam, "hardwareId", "hardware") or ""), {})
        mac = canon_mac(str(_first(cam, "mac", "macAddress") or _first(hw, "mac", "macAddress") or ""))
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
            "ip": _first(cam, "address", "ip") or _first(hw, "address", "ip"),
            "mac": mac or None,
            "recording_server_device_id": rs_devid.get(rs_id),
            "enabled": 1 if _truthy(cam.get("enabled"), cam.get("recordingEnabled")) else 0,
            "updated_at": now,
        })
    return rows


class MilestoneCollector(Collector):
    name = "milestone"

    def __init__(self, engine: Engine, client: MilestoneClient, interval_s: float = 120.0) -> None:
        super().__init__(engine)
        self.client = client
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
        return cls(engine, client, interval_s=int(s.get("interval_s") or 120))

    def _by_milestone_id(self) -> dict[str, dict]:
        rows = db.fetch_all(
            self.engine,
            "SELECT id, device_type, milestone_hardware_id FROM devices "
            "WHERE enabled = 1 AND milestone_hardware_id IS NOT NULL AND milestone_hardware_id <> ''",
        )
        return {str(r["milestone_hardware_id"]): r for r in rows}

    async def run_once(self) -> int:
        registry = self._by_milestone_id()
        try:
            servers = await self.client.recording_servers()
            cameras = await self.client.cameras()
        except MilestoneError:
            for r in registry.values():
                write_state(self.engine, int(r["id"]), "source_status", "blind", "warn", "milestone")
            raise

        now = datetime.now(timezone.utc)
        written = 0

        # State writes (unchanged contract) + RS device-id map for camera links.
        rs_devid: dict[str, int] = {}
        for srv in servers:
            r = registry.get(str(srv.get("id")))
            if r is None:
                continue
            rs_devid[str(srv.get("id"))] = int(r["id"])
            running = _truthy(srv.get("running"), srv.get("state"), srv.get("enabled"))
            write_state(self.engine, int(r["id"]), "source_status",
                        "up" if running else "down", "ok" if running else "crit", "milestone")
            written += 1
        for cam in cameras:
            r = registry.get(str(cam.get("id")))
            if r is None:
                continue
            recording = _truthy(cam.get("recordingEnabled"), cam.get("recording"), cam.get("enabled"))
            write_state(self.engine, int(r["id"]), "recording",
                        "up" if recording else "down", "ok" if recording else "crit", "milestone")
            written += 1

        # Optional enrichment — fail-soft (older XProtect lacks these endpoints).
        storage_by_rs: dict[str, dict] = {}
        try:
            for s in await self.client.storage():
                rs = str(_first(s, "recordingServerId", "recordingServer") or "")
                agg = storage_by_rs.setdefault(rs, {"used_gb": 0.0, "total_gb": 0.0, "retention_days": None})
                used, total = _num(s.get("usedSpace"), s.get("used")), _num(s.get("size"), s.get("total"))
                if used is not None:
                    agg["used_gb"] += used / 1_000_000_000 if used > 1_000_000 else used
                if total is not None:
                    agg["total_gb"] += total / 1_000_000_000 if total > 1_000_000 else total
                agg["retention_days"] = _num(s.get("retentionDays")) or agg["retention_days"]
        except MilestoneError as exc:
            log.info("milestone storage endpoint unavailable: %s", exc)
        hw_by_id: dict[str, dict] = {}
        try:
            hw_by_id = {str(h.get("id")): h for h in await self.client.hardware()}
        except MilestoneError as exc:
            log.info("milestone hardware endpoint unavailable: %s", exc)

        rs_rows = build_recording_servers(servers, registry, storage_by_rs, now)
        cam_rows = build_cameras(cameras, registry, hw_by_id, rs_devid, now)
        written += db.replace_rows(self.engine, "recording_servers", ["device_id"], rs_rows)
        written += db.replace_rows(self.engine, "cameras", ["device_id"], cam_rows)

        # Environment overview singleton.
        write_snapshot(self.engine, "milestone.overview", {
            "recording_servers": len(rs_rows),
            "cameras": len(cam_rows),
            "cameras_recording": sum(1 for c in cam_rows if c["enabled"]),
            "storage_used_gb": round(sum(r["storage_used_gb"] or 0 for r in rs_rows), 1),
            "storage_total_gb": round(sum(r["storage_total_gb"] or 0 for r in rs_rows), 1),
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
