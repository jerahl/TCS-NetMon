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
    """A device plus its current poller-observed ping/snmp state."""

    id: int
    name: str
    site: str | None = None
    device_type: DeviceType = DeviceType.other
    mgmt_ip: str | None = None
    ping: DimensionState = DimensionState()
    snmp: DimensionState = DimensionState()


class UserSession(BaseModel):
    """The authenticated principal attached to a request."""

    username: str
    role: Role
    groups: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str
    version: str
    db_ok: bool
