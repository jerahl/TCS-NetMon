"""XIQ collector — federate ExtremeCloud IQ into NetMon.

Cycles inside one supervised task (each independently intervalled and
disableable — spec 10 §5; ≈1,500–1,800 calls/h total at fleet scale, ≤ ~25%
of the 7,500/h tenant quota shared with every other integration):

  * status (base interval, 180 s): fleet list → ``source_status`` up/down, but
    only for devices XIQ actually manages — a non-MANAGED ``device_admin_state``
    is always ``connected: false`` and maps to ``unknown``, never crit
    (``source_state``). Unreachable XIQ (401/transport/5xx) marks all XIQ
    devices ``blind``; a 429 is a throttle, not blind.
  * detail (5 min): ``views=FULL`` fleet sweep → ``ap_details`` (when due, the
    same fetch also serves the status cycle — no extra calls). Only devices the
    registry types as ``ap`` get AP-detail rows; switches federated from XIQ get
    up/down ``source_status`` only — their port/PoE/FDB detail comes from the
    SNMP inventory sweep, never the AP endpoints.
  * radios (5 min): ``/devices/radio-information`` → ``ap_radios``. Radios are
    NOT on the device payload (``XiqDevice`` has no ``radios`` property), so
    this needs its own fetch — ~16 extra calls per cycle for 783 APs, batched 50
    ids at a time because ``deviceIds`` is required and ``limit`` caps at 50.
    Disable with ``[xiq] radios_enabled = false``.
  * clients (10 min): ``/clients/active?views=FULL`` → ``wireless_clients``.
    Carries usernames/MACs (PII — spec 10 Q8): disable with
    ``[xiq] clients_enabled = false``. ``radio_type`` is an **integer** enum
    (see ``_CLIENT_RADIO_TYPES``), not a band string.
  * ssids (30 min): network policies → per-policy SSID list → ``ssids``.

Read-only.    python -m netmon.collectors.xiq --once|--loop
"""

from __future__ import annotations

import logging
import re
import sys
import time
from collections import Counter
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
from netmon.snapshots import write_snapshot
from netmon.state import write_state

log = logging.getLogger("netmon.collectors.xiq")

DIMENSION = "source_status"
RATE_LIMIT_WARN = 500

_AP_FUNCTIONS = {"AP", "ACCESS_POINT"}
# AP radio band, from ``XiqRadio.frequency`` — a *string* enum whose only values
# are "2.4GHz" / "5GHz" / "6GHz". The bare "2.4G"/"5G"/"6G" spellings are kept
# for tenants/views that shorten it.
_BANDS = {"2.4G": "2.4", "2.4GHZ": "2.4", "5G": "5", "5GHZ": "5", "6G": "6", "6GHZ": "6"}
# Client band, from ``XiqClient.radio_type`` — an *integer* enum, NOT a band
# string. Verbatim from this tenant's own published schema (read-only
# ``GET /openapi``, ExtremeCloud IQ API 25.11.1-3): "The radio type. Represented
# by an integer code for each standard: 1 - 2.4G, 2 - 5G, 3 - WIRED, 4 - 6G,
# 5 - THREAD". Corroborated on live data (2026-07-28): every radio_type=2 client
# sat on a 5 GHz channel (36–165) with a 5 GHz mac_protocol (802.11a/na/ac/
# ax-5g), and every radio_type=3 client sat on a switch, on a port-notation
# interface ("1:51"), with mac_protocol "N/A". ``/clients/active`` returns wired
# clients too, so WIRED and THREAD are real, expected values here — they are
# labelled, not silently dropped, because NULL is what a *bug* looks like.
_CLIENT_RADIO_TYPES = {1: "2.4", 2: "5", 3: "wired", 4: "6", 5: "thread"}
_MANAGED_ADMIN_STATE = "MANAGED"

#: A value the maps above don't cover is logged at most this often per value, so
#: a source-side enum change is loud in the log without flooding it (§4.5).
UNMAPPED_WARN_INTERVAL_S = 300.0
#: snapshot_cache key carrying the per-cycle tally of unmapped enum values.
UNMAPPED_SNAPSHOT_KEY = "xiq.unmapped_enums"
_unmapped_last_warn: dict[str, float] = {}


def source_state(dev: XiqDevice) -> tuple[str, str]:
    """XIQ connectivity → (value, severity) for the ``source_status`` dimension.

    XIQ reports ``connected: false`` for every device it is not actively
    managing — ``UNMANAGED`` (onboarded then released), ``NEW`` (onboarded,
    never adopted), ``BOOTSTRAP``. That is XIQ having *no opinion*, not the
    device being down: when this mapping read ``connected`` alone, 11 of the 13
    switches it flagged crit were answering SNMP at the time (2026-07-27 —
    Verner alone showed 3 "switches down" with every switch up). Absent an
    opinion the honest state is ``unknown``, the mirror of CLAUDE.md §6's
    "blind must never render as healthy": a source that isn't watching a device
    must never render it as failing.

    An admin state XIQ didn't send is treated as managed, so the connectivity
    signal is preserved on any tenant/view that omits the field.
    """
    admin = (dev.device_admin_state or "").strip().upper()
    if admin and admin != _MANAGED_ADMIN_STATE:
        return "unknown", "unknown"
    return ("up", "ok") if dev.connected else ("down", "crit")


def _note_unmapped(field: str, raw: Any, tally: Counter | None) -> None:
    """Make an unmapped source enum value visible instead of silently NULL.

    ``radio_type`` shipped as an int while ``_BANDS`` only held band *strings*,
    so ``band`` was NULL for every wireless client for weeks and nothing said a
    word (2026-07-28). Per §4.5 an unrecognised value is now loud: a
    rate-limited WARNING plus a per-cycle tally the collector persists to
    ``snapshot_cache`` — a future enum change cannot be silent again.
    """
    key = f"{field}={raw!r}"
    if tally is not None:
        tally[key] += 1
    now = time.monotonic()
    last = _unmapped_last_warn.get(key)
    if last is None or (now - last) >= UNMAPPED_WARN_INTERVAL_S:
        _unmapped_last_warn[key] = now
        log.warning(
            "XIQ %s: unmapped value %r — column left NULL. The source enum likely "
            "changed (or a new value shipped); update the mapping in "
            "netmon/collectors/xiq.py.", field, raw,
        )


def _band(raw: Any, tally: Counter | None = None) -> str | None:
    """AP radio band from the radio's own frequency field — never from the radio
    index (dual-5G APs exist; spec 00 G10)."""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    band = _BANDS.get(str(raw).strip().upper())
    if band is None:
        _note_unmapped("radios[].frequency", raw, tally)
    return band


def _client_band(raw: Any, tally: Counter | None = None) -> str | None:
    """Client band from ``/clients/active``'s integer ``radio_type`` enum.

    Absent/blank stays None (XIQ said nothing). Anything present but unmapped is
    reported through :func:`_note_unmapped`. Textual values are still accepted
    so a tenant or ``fields=RADIO_TYPE`` view that returns "5G" keeps working.
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()) or isinstance(raw, bool):
        if isinstance(raw, bool):
            _note_unmapped("clients.radio_type", raw, tally)
        return None
    code = _to_int(raw)
    band = (_CLIENT_RADIO_TYPES.get(code) if code is not None
            else _BANDS.get(str(raw).strip().upper()))
    if band is None:
        _note_unmapped("clients.radio_type", raw, tally)
    return band


def _width_mhz(raw: Any, tally: Counter | None = None):
    """Channel width in MHz from ``XiqRadio.channel_width``.

    The published enum puts the digits at the **end**:
    ``MHZ_20|MHZ_40|MHZ_80|MHZ_160|MHZ_320``. This used to anchor the match at
    the start (``re.match``), so every real radio parsed to None — and every
    live radio on this fleet is ``MHZ_20`` (1,574/1,574 on 2026-07-28), so the
    column would have been 100% NULL the moment radios started arriving. A
    plain ``"20"`` / ``"20MHz"`` / ``20`` is still accepted for any view or
    tenant that spells it that way.

    Absent/blank → None (XIQ said nothing). Present but unparseable →
    :func:`_note_unmapped`, never a silent None (§4.5).
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    m = re.search(r"(\d+)", str(raw))
    if m is None:
        _note_unmapped("radios[].channel_width", raw, tally)
        return None
    return int(m.group(1))


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
) -> list[dict]:
    """FULL fleet rows → ``ap_details`` rows for registry APs.

    NetMon's own registry ``device_type`` is authoritative — ``ap_ids`` is the
    set of device ids NetMon classifies as APs. A device the operator has
    typed as a ``switch`` never gets AP-detail rows even when XIQ still reports
    its ``device_function`` as "AP" (switch port/PoE/FDB detail comes from the
    SNMP inventory sweep, not the AP path). When ``ap_ids`` is None we fall
    back to the XIQ payload's ``device_function`` (legacy behaviour).

    Radios are **not** here: see :func:`build_radio_rows`. Nothing on this path
    maps a source enum any more, so it takes no unmapped-value ``tally``.
    """
    details: list[dict] = []
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
    return details


def build_radio_rows(
    entities: list[dict], xiq_to_dev: dict[str, int], now: datetime,
    ap_ids: set[int] | None = None, tally: Counter | None = None,
) -> list[dict]:
    """``GET /devices/radio-information`` entities → ``ap_radios`` rows.

    One ``XiqRadioEntity`` per device (``{"device_id", "radios": [XiqRadio…]}``).
    Field names are *not* the ones the fleet payload was assumed to carry —
    ``channel_number``, not ``channel``; ``channel_width`` as ``"MHZ_20"``, not
    ``"20MHz"``. Band still comes from the radio's own ``frequency`` (a genuine
    string enum, ``2.4GHz|5GHz|6GHz``) and never from the radio index, because
    dual-5G APs are the norm on this fleet — 783 of 783 APs run wifi0 *and*
    wifi1 at 5 GHz (spec 00 G10).

    ``ap_ids`` (registry ``device_type == 'ap'``) is authoritative, as in
    :func:`build_ap_rows`: a device NetMon types as a switch gets no radio rows
    even if XIQ answers for it.
    """
    out: dict[tuple[int, str], dict] = {}
    for ent in entities:
        dev_id = xiq_to_dev.get(str(ent.get("device_id")))
        if dev_id is None or (ap_ids is not None and dev_id not in ap_ids):
            continue
        for radio in ent.get("radios") or []:
            name = str(radio.get("name") or "").strip()
            if not name:
                continue
            out[(dev_id, name)] = {
                "device_id": dev_id,
                "radio": name,
                "band": _band(radio.get("frequency"), tally),
                "channel": _to_int(radio.get("channel_number")),
                "width_mhz": _width_mhz(radio.get("channel_width"), tally),
                "tx_power_dbm": _to_int(radio.get("power")),
                # Deliberately NULL, and NOT len(radio["clients"]).
                # ``XiqRadio.clients`` is an array of ``XiqWirelessClient``,
                # whose only fields are network_policy_name / ssid /
                # ssid_status / ssid_security_type — SSID descriptors, with no
                # client identity in them at all. It is a per-WLAN list, not a
                # client list: across 1,574 live radios (2026-07-28) its ssid
                # set was identical to ``wlans[]``'s on 1,574/1,574, no radio
                # ever repeated an ssid, and the per-AP total took just two
                # values (3 or 6 = SSIDs × radios) while XIQ's own
                # ``active_clients`` for those same APs ranged 1..30+ and
                # agreed with it on 1 of 783. len() would stamp the same "3"
                # onto every radio in the fleet — a plausible-looking
                # fabrication, which §4.5 forbids far more than an empty
                # column. The AP Detail page renders NULL as "—" honestly.
                # A real per-radio count is derivable from /clients/active's
                # ``interface_name`` ("wifi0.1"); that is a follow-up, not a
                # guess to ship here.
                "clients": None,
                "updated_at": now,
            }
    return list(out.values())


def build_client_rows(
    raw: list[dict], xiq_to_dev: dict[str, int], now: datetime,
    tally: Counter | None = None,
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
            "band": _client_band(r.get("radio_type"), tally),
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
        radios_enabled: bool = True,
        radios_interval_s: float = 300.0,
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
        self.radios_enabled = radios_enabled
        self.radios_interval_s = radios_interval_s
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
            radios_enabled=_b("radios_enabled", True),
            radios_interval_s=int(settings.get("radios_interval_s") or 300),
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
        absent: list[dict[str, Any]] = []
        for r in registry:
            dev = fleet.get(str(r["xiq_device_id"]))
            if dev is None:
                # In our registry but absent from a *successful* fleet fetch.
                absent.append(r)
                continue
            value, severity = source_state(dev)
            write_state(self.engine, int(r["id"]), DIMENSION, value, severity, "xiq")
            if not r.get("mgmt_ip") and dev.ip_address:
                db.execute(
                    self.engine,
                    "UPDATE devices SET mgmt_ip = :ip "
                    "WHERE id = :id AND (mgmt_ip IS NULL OR mgmt_ip = '')",
                    {"ip": dev.ip_address, "id": int(r["id"])},
                )
            written += 1

        # A successful fetch means XIQ IS reachable, so nothing is truly
        # "blind". Present devices cleared to up/down above; also clear a STALE
        # blind on any registry device XIQ no longer lists (a re-typed switch,
        # a removed/renamed device, a stale xiq_device_id) — otherwise it stays
        # blind forever and lingers as a phantom XIQ problem the engine never
        # closes. Only `blind` is reset (→ unknown); a prior up/down is left as
        # honest, staleness-badged state and never fabricated.
        written += self._clear_stale_blind(absent)

        xiq_to_dev = {str(r["xiq_device_id"]): int(r["id"]) for r in registry}
        # Registry device_type is authoritative for which devices flow through
        # the AP-detail path; switches only get source_status (up/down) here —
        # their detail comes from the SNMP inventory sweep, never the AP API.
        ap_ids = {int(r["id"]) for r in registry if r.get("device_type") == "ap"}
        # XIQ's own ids for those APs — what /devices/radio-information takes.
        ap_xiq_ids = sorted({
            i for i in (_to_int(r.get("xiq_device_id")) for r in registry
                        if r.get("device_type") == "ap")
            if i is not None
        })
        now = datetime.now(timezone.utc)
        # Enum values the band maps don't cover, counted per cycle and published
        # so an upstream enum change is visible, not a silent NULL (§4.5).
        tally: Counter = Counter()
        band_cycle_ran = False

        if detail_due:
            details = build_ap_rows(raw, xiq_to_dev, time.time(), now, ap_ids)
            written += db.replace_rows(self.engine, "ap_details", ["device_id"], details)
            self._last_cycle["detail"] = mono
            log.info("xiq detail cycle: %d AP(s)", len(details))

        if self.radios_enabled and self._due("radios", self.radios_interval_s, mono):
            # Radios need their own fetch: they are absent from the device
            # payload entirely (see build_radio_rows), which is why ap_radios
            # sat at 0 rows while this collector reported clean successes.
            # A failed fetch raises before replace_rows, so the previous radio
            # rows stay visible-and-stale rather than being wiped (§4.5).
            entities = await self.client.get_radio_information(ap_xiq_ids)
            radios = build_radio_rows(entities, xiq_to_dev, now, ap_ids, tally)
            written += db.replace_rows(self.engine, "ap_radios", ["device_id", "radio"], radios)
            self._last_cycle["radios"] = mono
            band_cycle_ran = True
            by_band = Counter(r["band"] or "unknown" for r in radios)
            log.info("xiq radios cycle: %d radio row(s) on %d AP(s); by band: %s",
                     len(radios), len(entities), dict(sorted(by_band.items())))

        if self.clients_enabled and self._due("clients", self.clients_interval_s, mono):
            raw_clients = await self.client.get_active_clients()
            rows = build_client_rows(raw_clients, xiq_to_dev, now, tally)
            written += db.replace_rows(self.engine, "wireless_clients", ["mac"], rows)
            self._last_cycle["clients"] = mono
            band_cycle_ran = True
            by_band = Counter(r["band"] or "unknown" for r in rows)
            log.info("xiq clients cycle: %d client(s); by band: %s",
                     len(rows), dict(sorted(by_band.items())))

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

        if band_cycle_ran:
            self._publish_unmapped(tally)

        rem = self.client.rate_limit_remaining
        if rem is not None and rem < RATE_LIMIT_WARN:
            log.warning("XIQ quota low: %s requests remaining this window", rem)
        return written

    def _publish_unmapped(self, tally: Counter) -> None:
        """Persist this cycle's unmapped-enum tally to ``snapshot_cache``.

        Clean cycle → ``ok=1``, ``total: 0``. Anything unmapped → the offending
        values and counts in the payload *and* ``ok=0``, so the condition is
        queryable (and badge-able) rather than a log line that scrolled away.
        The payload is written first because ``write_snapshot(ok=False)``
        deliberately preserves the existing payload instead of replacing it.
        Fail-soft: this bookkeeping must never sink a cycle that wrote good rows.
        """
        try:
            write_snapshot(self.engine, UNMAPPED_SNAPSHOT_KEY,
                           {"counts": dict(sorted(tally.items())),
                            "total": sum(tally.values())},
                           source="xiq", ok=True)
            if tally:
                write_snapshot(self.engine, UNMAPPED_SNAPSHOT_KEY, None,
                               source="xiq", ok=False)
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("could not publish %s: %s", UNMAPPED_SNAPSHOT_KEY, exc)
        if tally:
            log.warning("xiq: %d value(s) the band maps don't cover this cycle: %s",
                        sum(tally.values()), dict(sorted(tally.items())))

    def _mark_blind(self, registry: list[dict[str, Any]]) -> None:
        for r in registry:
            write_state(self.engine, int(r["id"]), DIMENSION, "blind", "warn", "xiq")

    def _clear_stale_blind(self, absent: list[dict[str, Any]]) -> int:
        """Reset a lingering ``blind`` source_status to ``unknown`` for devices
        XIQ no longer lists (the fetch succeeded, so the source isn't blind).
        Returns the number of rows transitioned."""
        if not absent:
            return 0
        ids = [int(r["id"]) for r in absent]
        ph = ",".join(f":id{i}" for i in range(len(ids)))
        params = {f"id{i}": v for i, v in enumerate(ids)}
        stale = db.fetch_all(
            self.engine,
            f"SELECT device_id FROM device_state "
            f"WHERE dimension = :dim AND value = 'blind' AND device_id IN ({ph})",
            {"dim": DIMENSION, **params},
        )
        cleared = 0
        for row in stale:
            if write_state(self.engine, int(row["device_id"]), DIMENSION,
                           "unknown", "unknown", "xiq"):
                cleared += 1
        if cleared:
            log.info("xiq: cleared stale blind on %d device(s) XIQ no longer lists", cleared)
        return cleared


def main(argv: list[str] | None = None) -> int:
    try:
        return run_standalone(lambda engine, cfg: XiqCollector.from_config(engine, cfg), argv)
    except XiqError as exc:
        print(f"error: {exc} — set [xiq] api_token in the config.", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
