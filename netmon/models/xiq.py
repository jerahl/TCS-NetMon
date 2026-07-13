"""Pydantic validation for XIQ payloads (collector-input contract).

Insulates the collector from XIQ field-name churn and normalizes the two known
quirks carried over from the reference client: colon-less MACs (G3) and
unix-milliseconds timestamps.
"""

from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, field_validator

_HEX = re.compile(r"[^0-9A-Fa-f]")


def _mac_with_colons(raw: str) -> str:
    clean = _HEX.sub("", raw or "")
    if len(clean) != 12:
        return raw or ""
    return ":".join(clean[i : i + 2] for i in range(0, 12, 2)).upper()


class XiqDevice(BaseModel):
    """One row of `GET /devices?views=BASIC`, tolerant of unknown extras."""

    model_config = ConfigDict(extra="ignore")

    id: int
    hostname: str = ""
    connected: bool = False
    ip_address: str | None = None
    device_function: str | None = None
    product_type: str | None = None
    software_version: str | None = None
    mac_address: str = ""

    @field_validator("mac_address")
    @classmethod
    def _normalize_mac(cls, v: str) -> str:
        return _mac_with_colons(v)

    @field_validator("ip_address")
    @classmethod
    def _blank_to_none(cls, v: str | None) -> str | None:
        return v or None
