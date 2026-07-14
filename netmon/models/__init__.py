"""Pydantic models — the API contract and the collector-validation layer.

Same models validate collector output on the way in and shape JSON on the way
out (README §2). Kept deliberately close to the DB schema (CLAUDE.md §6).
"""

from netmon.models.schemas import (  # noqa: F401
    Device,
    DeviceState,
    Dimension,
    HealthResponse,
    Role,
    Severity,
    StateEvent,
    UserSession,
)
