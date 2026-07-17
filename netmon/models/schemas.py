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
    """/api/sites: a curated site plus its live device roll-up.

    ``problems``/``worst_severity`` are the Global-page site-tile additions
    (spec 10 §6 / phase 10.5): the count of open alerts scoped to the site and
    the worst of their severities. Additive — the map ignores them.
    """

    name: str
    display_name: str | None = None
    tier: SiteTier = SiteTier.other
    label_pos: str | None = None   # top|bottom|left|right; None → top
    lat: float
    lon: float
    status: SiteStatus = SiteStatus.unknown
    devices_total: int = 0
    devices_down: int = 0
    devices_degraded: int = 0
    problems: int = 0
    worst_severity: Severity = Severity.unknown


class FiberLink(BaseModel):
    """/api/links: a curated link plus its effective current state."""

    id: int
    site_a: str
    site_b: str
    capacity_gbps: float
    path: list[tuple[float, float]] | None = None
    link_kind: str = "owned"        # owned | leased
    provider: str | None = None     # carrier name when leased (e.g. C-Spire)
    status: SiteStatus = SiteStatus.unknown
    utilization_pct: float | None = None
    utilization_at: datetime | None = None
    utilization_source: str | None = None
    # Derived from the attached switch ports when set (else the port-agnostic
    # site-derived status stands): the negotiated link speed and whether the
    # link is wired to physical ports at all.
    speed_mbps: int | None = None
    port_backed: bool = False


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
    history_enabled: bool = False
    tasks: list[SupervisedTask] = Field(default_factory=list)
    collectors: list[CollectorHealth] = Field(default_factory=list)
    db: NetmonDbStats = Field(default_factory=NetmonDbStats)


class UiMeta(BaseModel):
    """/api/meta: static facts the UI shell needs once per load (nav
    deep-links, footer version). No state, no secrets."""

    version: str
    zabbix_url: str = ""
    ssheasy_url: str = ""
    # Whether web edits are enabled at all ([security] allow_web_edit). Lets the
    # UI show/hide edit affordances; the API still enforces it server-side.
    can_edit: bool = False


class UserSession(BaseModel):
    """The authenticated principal attached to a request."""

    username: str
    role: Role
    groups: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str
    version: str
    db_ok: bool


# ---------------------------------------------------------------- Global page
# (spec 10 §6 / phase 10.5) — /api/summary system cards + severity strip, and
# /api/search ⌘K palette. All DB-only roll-ups; zero source calls at render.

class SummaryKpi(BaseModel):
    """One number on a system card (e.g. "312 / 318 ports up")."""

    label: str
    value: str
    severity: Severity = Severity.unknown


class SystemDomain(BaseModel):
    """One system card on the Global page: a monitored domain, its worst
    current severity, the freshness of the backing source, and a few KPIs.

    ``status`` folds two honest signals (§4.5): the source's own health
    (``blind`` when its collector is failing) and the domain's device-state
    roll-up. A blind source never reports ``ok``.
    """

    key: str            # switching | wireless | nac | surveillance | voip | config
    label: str
    status: Severity = Severity.unknown
    blind: bool = False           # backing source is failing/unreachable
    source: str | None = None     # collector_health name
    updated_at: datetime | None = None   # source's last successful refresh
    headline: str | None = None
    href: str | None = None       # SPA route for the card's "open" affordance
    kpis: list[SummaryKpi] = Field(default_factory=list)


class SummaryFleet(BaseModel):
    """Top-line device counts for the Global severity strip."""

    total: int = 0
    up: int = 0
    down: int = 0
    unknown: int = 0
    blind: int = 0
    by_type: dict[str, int] = Field(default_factory=dict)


class SummaryAlerts(BaseModel):
    """Open-alert roll-up for the Global severity strip / triggers header."""

    open: int = 0
    crit: int = 0
    warn: int = 0
    acked: int = 0
    unacked: int = 0
    assigned: int = 0


class Summary(BaseModel):
    """/api/summary: everything the Global dashboard needs above the site
    heatmap / event stream (both of which have their own endpoints)."""

    generated_at: datetime
    fleet: SummaryFleet = Field(default_factory=SummaryFleet)
    severity: dict[str, int] = Field(default_factory=dict)  # device worst-of roll-up
    alerts: SummaryAlerts = Field(default_factory=SummaryAlerts)
    domains: list[SystemDomain] = Field(default_factory=list)


class SearchHit(BaseModel):
    """One ⌘K result row. ``href`` is the SPA route to navigate to; ``kind``
    groups the palette (device | endpoint | mac)."""

    kind: str
    title: str
    subtitle: str | None = None
    href: str | None = None
    badge: str | None = None          # source/provenance chip (POLLER/PF/SNMP)


class SearchResults(BaseModel):
    """/api/search?q= : grouped hits from devices + pf_nodes + fdb_entries."""

    query: str
    devices: list[SearchHit] = Field(default_factory=list)
    endpoints: list[SearchHit] = Field(default_factory=list)   # pf_nodes
    macs: list[SearchHit] = Field(default_factory=list)         # fdb_entries
    total: int = 0
