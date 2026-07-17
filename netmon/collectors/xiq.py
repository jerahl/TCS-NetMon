"""XIQ collector — federate ExtremeCloud IQ into NetMon.

Cycles inside one supervised task (each independently intervalled and
disableable — spec 10 §5; ≈1,300–1,600 calls/h total at fleet scale, ≤ ~25%
of the 7,500/h tenant quota):

  * status (base interval, 180 s): fleet list → ``source_status`` up/down.
    Unreachable XIQ (401/transport/5xx) marks all XIQ devices ``blind``;
    a 429 is a throttle, not blind.
  * detail (5 min): ``views=FULL`` fleet sweep → ``ap_details`` + ``ap_radios``
    (when due, the same fetch also serves the status cycle — no extra calls).
    Only devices the registry types as ``ap`` get AP-detail rows; switches
    federated from XIQ get up/down ``source_status`` only — their port/PoE/FDB
    detail comes from the SNMP inventory sweep, never the AP endpoints.
  * clients (10 min): ``/clients/active?views=FULL`` → ``wireless_clients``.
    Carries usernames/MACs (PII — spec 10 Q8): disable with
    ``[xiq] clients_enabled = false``.
  * ssids (30 min): network policies → per-policy SSID list → ``ssids``.

Read-only.    python -m netmon.collectors.xiq --once|--loop
"""

from __future__ import annotations

import logging
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import ValidationError
from sqlalchemy.engine import Engine

from netmon import db
from netmon.collectors.base import Collector, run_standalone
from netmon.collectors.xiq_client import (
    BASE_URL,
    XiqAuthError,
    XiqClient,
    XiqError,
    XiqRateLimitError,
)
from netmon.config import Config
from netmon.models.xiq import XiqDevice
from netmon.state import write_state

log = logging.getLogger("netmon.collectors.xiq")

DIMENSION = "source_status"
RATE_LIMIT_WARN = 500

_AP_FUNCTIONS = {"AP", "ACCESS_POINT"}
_BANDS = {"2.4G": "2.4", "2.4GHZ": "2.4", "5G": "5", "5GHZ": "5", "6G": "6", "6GHZ": "6"}


def _band(raw: Any) -> str | None:
    """Band from the radio's own frequency field — never from the radio index
    (dual-5G APs exist; spec 00 G10)."""
    return _BANDS.get(str(raw or "").strip().upper())


def _width_mhz(raw: Any):
    m = re.match(r"(\d+)", str(raw or ""))
    return int(m.group(1)) if m else None


def _to_int(v: Any):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _uptime_s(raw: Any, now_s: float):
    """XIQ timestamps are mixed unix-ms and unix-s (spec 00). Large values are
    boot timestamps; small ones are already uptime seconds."""
    v = _to_int(raw)
    if not v or v <= 0:
        return None
    if v > 10**12:  # epoch ms boot time
        up = now_s - v / 1000.0
    elif v > 10**9:  # epoch s boot time
        up = now_s - v
    else:  # already an uptime
        up = float(v)
    return int(up) if up > 0 else None


def build_ap_rows(
    raw: list[dict], xiq_to_dev: dict[str, int], now_s: float, now: datetime,
    ap_ids: set[int] | None = None,
) -> tuple[list[dict], list[dict]]:
    """FULL fleet rows → (ap_details rows, ap_radios rows) for registry APs.

    NetMon's own registry ``device_type`` is authoritative — ``ap_ids`` is the
    set of device ids NetMon classifies as APs. A device the operator has
    typed as a ``switch`` never gets AP-detail rows even when XIQ still reports
    its ``device_function`` as "AP" (switch port/PoE/FDB detail comes from the
    SNMP inventory sweep, not the AP path). When ``ap_ids`` is None we fall
    back to the XIQ payload's ``device_function`` (legacy behaviour)."""
    details: list[dict] = []
    radios: list[dict] = []
    for r in raw:
        dev_id = xiq_to_dev.get(str(r.get("id")))
        if dev_id is None:
            continue
        if ap_ids is not None:
            if dev_id not in ap_ids:
                continue
        elif str(r.get("device_function") or "").strip().upper() not in _AP_FUNCTIONS:
            continue
        mac = str(r.get("mac_address") or "").strip() or None
        details.append({
            "device_id": dev_id,
            "model": (r.get("product_type") or None),
            "serial": (r.get("serial_number") or None),
            "mgmt_mac": mac.lower() if mac else None,
            "fw_version": (r.get("software_version") or None),
            "ip": (r.get("ip_address") or None),
            "network_policy": (r.get("network_policy_name") or None),
            "uptime_s": _uptime_s(r.get("system_up_time"), now_s) if r.get("connected") else None,
            "clients_total": _to_int(r.get("active_clients")),
            "updated_at": now,
        })
        for radio in r.get("radios") or []:
            name = str(radio.get("name") or "").strip()
            if not name:
                continue
            radios.append({
                "device_id": dev_id,
                "radio": name,
                "band": _band(radio.get("frequency")),
                "channel": _to_int(radio.get("channel")),
                "width_mhz": _width_mhz(radio.get("channel_width")),
                "tx_power_dbm": _to_int(radio.get("power")),
                "clients": _to_int(radio.get("clients")),
                "updated_at": now,
            })
    return details, radios


def build_client_rows(
    raw: list[dict], xiq_to_dev: dict[str, int], now: datetime
) -> list[dict]:
    """/clients/active FULL rows → wireless_clients rows (deduped by MAC)."""
    by_mac: dict[str, dict] = {}
    for r in raw:
        mac_raw = str(r.get("mac_address") or r.get("mac") or "").strip()
        hexs = re.sub(r"[^0-9a-fA-F]", "", mac_raw).lower()
        if len(hexs) != 12:
            continue
        mac = ":".join(hexs[i:i + 2] for i in range(0, 12, 2))
        dur_ms = _to_int(r.get("connection_duration")) or 0
        by_mac[mac] = {
            "mac": mac,
            "device_id": xiq_to_dev.get(str(r.get("device_id"))),
            "ssid": (r.get("ssid") or None),
            "band": _band(r.get("radio_type")),
            "rssi_dbm": _to_int(r.get("rssi")),
            "snr_db": _to_int(r.get("snr")),
            "os": (r.get("os_type") or None),
            "hostname": (r.get("hostname") or None),
            "username": (r.get("username") or r.get("user_name") or None),
            "ip": (r.get("ip_address") or r.get("ip") or None),
            "connected_since": now - timedelta(milliseconds=dur_ms) if dur_ms > 0 else None,
            "updated_at": now,
        }
    return list(by_mac.values())


def build_ssid_rows(policy_name: str | None, ssid_rows: list[dict], now: datetime) -> list[dict]:
    out: list[dict] = []
    for s in ssid_rows:
        name = str(s.get("broadcast_name") or s.get("name") or "").strip()
        if not name:
            continue
        sec = s.get("access_security") or {}
        out.append({
            "name": name,
            "auth": (sec.get("security_type") if isinstance(sec, dict) else None),
            "enabled": 1 if s.get("enabled", True) else 0,
            "network_policy": policy_name,
            "updated_at": now,
        })
    return out


class XiqCollector(Collector):
    name = "xiq"

    def __init__(
        self,
        engine: Engine,
        client: XiqClient,
        interval_s: float = 180.0,
        *,
        detail_enabled: bool = True,
        detail_interval_s: float = 300.0,
        clients_enabled: bool = True,
        clients_interval_s: float = 600.0,
        ssids_enabled: bool = True,
        ssids_interval_s: float = 1800.0,
    ) -> None:
        super().__init__(engine)
        self.client = client
        self.interval_s = interval_s
        # One run may include the clients sweep (~90 pages at fleet scale) on
        # top of the FULL device sweep — budget generously, like snmp_inventory.
        self.timeout_s = max(300.0, interval_s)
        self.detail_enabled = detail_enabled
        self.detail_interval_s = detail_interval_s
        self.clients_enabled = clients_enabled
        self.clients_interval_s = clients_interval_s
        self.ssids_enabled = ssids_enabled
        self.ssids_interval_s = ssids_interval_s
        self._last_cycle: dict[str, float] = {}

    @classmethod
    def from_config(cls, engine: Engine, cfg: Config) -> "XiqCollector":
        src = cfg.sources.get("xiq")
        settings = src.settings if src else {}
        token = (settings.get("api_token") or "").strip()
        base_url = (settings.get("base_url") or BASE_URL).strip()

        def _b(key: str, default: bool) -> bool:
            raw = str(settings.get(key, default)).strip().lower()
            return raw in ("1", "true", "yes", "on")

        return cls(
            engine, XiqClient(token, base_url),
            interval_s=int(settings.get("status_interval_s") or 180),
            detail_enabled=_b("detail_enabled", True),
            detail_interval_s=int(settings.get("detail_interval_s") or 300),
            clients_enabled=_b("clients_enabled", True),
            clients_interval_s=int(settings.get("clients_interval_s") or 600),
            ssids_enabled=_b("ssids_enabled", True),
            ssids_interval_s=int(settings.get("ssids_interval_s") or 1800),
        )

    def _due(self, cycle: str, interval_s: float, now: float) -> bool:
        last = self._last_cycle.get(cycle)
        return last is None or (now - last) >= interval_s

    def _registry(self) -> list[dict[str, Any]]:
        return db.fetch_all(
            self.engine,
            "SELECT id, xiq_device_id, mgmt_ip, device_type FROM devices "
            "WHERE enabled = 1 AND xiq_device_id IS NOT NULL AND xiq_device_id <> ''",
        )

    async def run_once(self) -> int:
        registry = self._registry()
        mono = time.monotonic()
        detail_due = self.detail_enabled and self._due("detail", self.detail_interval_s, mono)
        try:
            # When the detail cycle is due, the FULL fetch serves BOTH the
            # status writes and the detail persistence — one sweep, not two.
            raw = await self.client.get_devices("FULL" if detail_due else "BASIC")
        except XiqRateLimitError:
            # Reachable but throttled — do NOT blind healthy devices; leave state.
            log.warning("XIQ rate limited; leaving device_state unchanged this cycle")
            raise
        except XiqError:
            # Auth/transport/5xx → source unreachable. Blind, loud, no stale-as-fresh.
            self._mark_blind(registry)
            raise

        fleet: dict[str, XiqDevice] = {}
        for row in raw:
            try:
                dev = XiqDevice.model_validate(row)
            except ValidationError as exc:
                log.warning("XIQ device row failed validation, skipping: %s", exc)
                continue
            fleet[str(dev.id)] = dev

        written = 0
        for r in registry:
            dev = fleet.get(str(r["xiq_device_id"]))
            if dev is None:
                # In our registry but absent from a *successful* fleet fetch —
                # leave prior state rather than fabricate a down/blind.
                continue
            value = "up" if dev.connected else "down"
            severity = "ok" if dev.connected else "crit"
            write_state(self.engine, int(r["id"]), DIMENSION, value, severity, "xiq")
            if not r.get("mgmt_ip") and dev.ip_address:
                db.execute(
                    self.engine,
                    "UPDATE devices SET mgmt_ip = :ip "
                    "WHERE id = :id AND (mgmt_ip IS NULL OR mgmt_ip = '')",
                    {"ip": dev.ip_address, "id": int(r["id"])},
                )
            written += 1

        xiq_to_dev = {str(r["xiq_device_id"]): int(r["id"]) for r in registry}
        # Registry device_type is authoritative for which devices flow through
        # the AP-detail path; switches only get source_status (up/down) here —
        # their detail comes from the SNMP inventory sweep, never the AP API.
        ap_ids = {int(r["id"]) for r in registry if r.get("device_type") == "ap"}
        now = datetime.now(timezone.utc)

        if detail_due:
            details, radios = build_ap_rows(raw, xiq_to_dev, time.time(), now, ap_ids)
            written += db.replace_rows(self.engine, "ap_details", ["device_id"], details)
            written += db.replace_rows(self.engine, "ap_radios", ["device_id", "radio"], radios)
            self._last_cycle["detail"] = mono
            log.info("xiq detail cycle: %d AP(s), %d radio row(s)", len(details), len(radios))

        if self.clients_enabled and self._due("clients", self.clients_interval_s, mono):
            raw_clients = await self.client.get_active_clients()
            rows = build_client_rows(raw_clients, xiq_to_dev, now)
            written += db.replace_rows(self.engine, "wireless_clients", ["mac"], rows)
            self._last_cycle["clients"] = mono
            log.info("xiq clients cycle: %d client(s)", len(rows))

        if self.ssids_enabled and self._due("ssids", self.ssids_interval_s, mono):
            ssid_rows: dict[str, dict] = {}
            for policy in await self.client.get_network_policies():
                pid = _to_int(policy.get("id"))
                if pid is None:
                    continue
                for row in build_ssid_rows(policy.get("name"),
                                           await self.client.get_policy_ssids(pid), now):
                    ssid_rows[row["name"]] = row
            written += db.replace_rows(self.engine, "ssids", ["name"], list(ssid_rows.values()))
            self._last_cycle["ssids"] = mono
            log.info("xiq ssids cycle: %d SSID(s)", len(ssid_rows))

        rem = self.client.rate_limit_remaining
        if rem is not None and rem < RATE_LIMIT_WARN:
            log.warning("XIQ quota low: %s requests remaining this window", rem)
        return written

    def _mark_blind(self, registry: list[dict[str, Any]]) -> None:
        for r in registry:
            write_state(self.engine, int(r["id"]), DIMENSION, "blind", "warn", "xiq")


def main(argv: list[str] | None = None) -> int:
    try:
        return run_standalone(lambda engine, cfg: XiqCollector.from_config(engine, cfg), argv)
    except XiqError as exc:
        print(f"error: {exc} — set [xiq] api_token in the config.", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
