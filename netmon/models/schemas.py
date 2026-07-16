"""Pydantic schemas mirroring the §6 data model.

Enums are the single source of truth for the vocabularies the DB ENUMs also
encode; keep the two in sync (a mismatch is a migration).
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class Role(str, Enum):
    viewer = "viewer"
    operator = "operator"
    admin = "admin"


class DeviceType(str, Enum):
    switch = "switch"
    ap = "ap"
    camera = "camera"
    recording_server = "recording_server"
    trunk = "trunk"
    pbx = "pbx"
    other = "other"


class Dimension(str, Enum):
    ping = "ping"
    snmp = "snmp"
    source_status = "source_status"
    config_backup = "config_backup"
    recording = "recording"
    trunk = "trunk"


class Severity(str, Enum):
    ok = "ok"
    warn = "warn"
    crit = "crit"
    unknown = "unknown"


class Device(BaseModel):
    """A row in the unified registry.

    Doubles as the shape the seed importer produces (before insert, ``id`` is
    unset) and the shape the devices API returns.
    """

    id: int | None = None
    name: str
    site: str | None = None
    device_type: DeviceType = DeviceType.other
    mgmt_ip: str | None = None
    snmp_capable: bool = False
    enabled: bool = True
    xiq_device_id: str | None = None
    pf_node_mac: str | None = None
    milestone_hardware_id: str | None = None
    rconfig_device_id: str | None = None
    threecx_ref: str | None = None


class DeviceState(BaseModel):
    device_id: int
    dimension: Dimension
    value: str | None = None
    severity: Severity = Severity.unknown
    source: str
    updated_at: datetime | None = None


class StateEvent(BaseModel):
    device_id: int
    dimension: Dimension
    old_value: str | None = None
    new_value: str | None = None
    severity: Severity = Severity.unknown
    source: str
    occurred_at: datetime | None = None


class DimensionState(BaseModel):
    """Current state of one device dimension (from device_state)."""

    value: str | None = None
    severity: Severity = Severity.unknown
    updated_at: datetime | None = None


class DeviceStatus(BaseModel):
    """A device plus its current per-dimension state.

    Carries every ``device_state`` dimension the UI reads. Surveillance/VoIP/
    config pages dereference ``recording``/``trunk``/``config_backup``; omitting
    them here was a latent client-side TypeError (spec 10 §6). A device with no
    row for a dimension reports the ``unknown`` default, never a missing field.
    """

    id: int
    name: str
    site: str | None = None
    device_type: DeviceType = DeviceType.other
    mgmt_ip: str | None = None
    ping: DimensionState = DimensionState()
    snmp: DimensionState = DimensionState()
    source_status: DimensionState = DimensionState()
    config_backup: DimensionState = DimensionState()
    recording: DimensionState = DimensionState()
    trunk: DimensionState = DimensionState()


class SiteTier(str, Enum):
    hub = "hub"
    high = "high"
    middle = "middle"
    elementary = "elementary"
    other = "other"


class SiteStatus(str, Enum):
    """Roll-up vocabulary for sites AND fiber links (spec 09).

    unknown is displayed distinctly, never as up — blind must never render as
    healthy (§6 invariant).
    """

    up = "up"
    degraded = "degraded"
    down = "down"
    unknown = "unknown"


class Site(BaseModel):
    """A row in the curated ``sites`` table (also the importer's shape).

    ``name`` must equal ``devices.site`` — it is the roll-up join key.
    """

    id: int | None = None
    name: str
    display_name: str | None = None
    tier: SiteTier = SiteTier.other
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    enabled: bool = True


class FiberLinkSpec(BaseModel):
    """A curated ``fiber_links`` row as the topology importer consumes it."""

    site_a: str
    site_b: str
    capacity_gbps: float = Field(default=1.0, gt=0)
    path: list[tuple[float, float]] | None = None  # [[lat,lon],...] or None
    enabled: bool = True


class SiteRollup(BaseModel):
    """/api/sites: a curated site plus its live device roll-up."""

    name: str
    display_name: str | None = None
    tier: SiteTier = SiteTier.other
    lat: float
    lon: float
    status: SiteStatus = SiteStatus.unknown
    devices_total: int = 0
    devices_down: int = 0
    devices_degraded: int = 0


class FiberLink(BaseModel):
    """/api/links: a curated link plus its effective current state."""

    id: int
    site_a: str
    site_b: str
    capacity_gbps: float
    path: list[tuple[float, float]] | None = None
    status: SiteStatus = SiteStatus.unknown
    utilization_pct: float | None = None
    utilization_at: datetime | None = None
    utilization_source: str | None = None


class MapEvent(BaseModel):
    """/api/events: a state_events row joined to its device name/site/type.

    Serves both the Phase 9 map feed and the spec 10 Events/Problems console.
    ``device_id``/``device_type`` are additive (the map ignores them) and let
    the console filter and group without a second lookup.
    """

    id: int
    device: str
    device_id: int
    device_type: DeviceType = DeviceType.other
    site: str | None = None
    dimension: Dimension
    old_value: str | None = None
    new_value: str | None = None
    severity: Severity = Severity.unknown
    source: str
    occurred_at: datetime | None = None


class EventBucket(BaseModel):
    """One hour of the Events console 24 h severity histogram."""

    hour: datetime
    ok: int = 0
    warn: int = 0
    crit: int = 0
    unknown: int = 0
    total: int = 0


class EventStats(BaseModel):
    """/api/events/stats: KPI tiles + 24 h histogram, computed from
    ``state_events`` timestamps (a query, not a stored series — §1/§6)."""

    total: int = 0
    by_severity: dict[str, int] = Field(default_factory=dict)
    window_hours: int = 24
    buckets: list[EventBucket] = Field(default_factory=list)


class CollectorHealth(BaseModel):
    """/api/collector-health: one collector's heartbeat for the source-health
    pills + staleness banners (§6). ``status`` is derived, never stored."""

    name: str
    status: str = "unknown"  # ok | error | unknown
    last_start: datetime | None = None
    last_success: datetime | None = None
    last_error: str | None = None
    duration_ms: int | None = None
    records_written: int | None = None
    consecutive_failures: int = 0
    updated_at: datetime | None = None


class SupervisedTask(BaseModel):
    """/api/netmon-status: one supervised asyncio task's registration + run
    stats (the supervisor's in-process view — resets on restart)."""

    name: str
    enabled: bool = True
    running: bool = False
    interval_s: float
    timeout_s: float
    runs: int = 0
    failures: int = 0
    last_run_at: datetime | None = None
    last_error: str | None = None


class NetmonDbStats(BaseModel):
    """/api/netmon-status: registry/state/event/alert row counts."""

    devices_total: int = 0
    devices_enabled: int = 0
    state_rows: int = 0
    events_total: int = 0
    events_24h: int = 0
    alerts_open: int = 0
    notifications_shadow: int = 0
    sessions_active: int = 0


class NetmonStatus(BaseModel):
    """The NetMon Status page (spec 11 D2) — replaces ZCD's Zabbix Status:
    self-health over ``collector_health`` + supervisor stats + DB counts."""

    version: str
    started_at: datetime | None = None
    uptime_s: float | None = None
    db_ok: bool = False
    engine_enabled: bool = False
    engine_shadow: bool = True
    poller_enabled: bool = False
    snmp_inventory_enabled: bool = False
    tasks: list[SupervisedTask] = Field(default_factory=list)
    collectors: list[CollectorHealth] = Field(default_factory=list)
    db: NetmonDbStats = Field(default_factory=NetmonDbStats)


class UiMeta(BaseModel):
    """/api/meta: static facts the UI shell needs once per load (nav
    deep-links, footer version). No state, no secrets."""

    version: str
    zabbix_url: str = ""


class UserSession(BaseModel):
    """The authenticated principal attached to a request."""

    username: str
    role: Role
    groups: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str
    version: str
    db_ok: bool
