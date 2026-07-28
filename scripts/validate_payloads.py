#!/usr/bin/env python3
"""Live-source payload validation — does the real JSON match what NetMon parses?

Phases 10.2–10.4 (XIQ detail/clients/SSIDs, PacketFence nodes, Milestone
cameras/recording servers, 3CX trunks/extensions) were written by *inferring*
payload shapes from the ZCD reference add-on. Spec 11 records "live-source
payload validation" as the top cutover risk: parse code written against guessed
JSON silently yields NULL columns, "—" cells, and never-firing alerts.

This harness closes that gap. For each configured source it fetches **one
payload per endpoint** and diffs the live response against the contract the code
declares, reporting per endpoint:

  * ``MISSING``     — the code reads a key the payload never contains (dangerous:
                      the column stays NULL forever, or the row fails validation)
  * ``EXTRA``       — keys the source sends and the code ignores (possible data
                      we could be using; informational)
  * ``RETYPED``     — key present but the JSON type differs from the declared one
  * ``NULL``        — a non-nullable/required field arrived null
  * ``PARTIAL``     — key present in only some sampled rows
  * ``ALIAS-ONLY``  — the canonical key is absent; only a fallback alias matched

Read-only (§4.1). Every data fetch is a GET. The only POSTs are the sources'
*own* auth-token grants (Milestone ``/IDP/connect/token``, 3CX
``/connect/token``, PF ``/api/v1/login``) and PacketFence's ``/search`` query
idiom — PF has no GET for a filtered node/locationlog list. Nothing this script
sends creates, mutates, or deletes anything, and Milestone is touched through the
Config API only (never the Events/State WebSocket).

Sanitized by construction (§4.6): the report carries field **names, JSON types
and counts** only — never a payload value. Key names that look like identifiers
(MACs, IPs, UUIDs, emails, hex blobs) are redacted, free-text reasons are
scrubbed, and no payload is ever written to disk.

Usage::

    python -m scripts.validate_payloads --source all
    python -m scripts.validate_payloads --source xiq --json
    NETMON_CONF=/etc/netmon/netmon.conf python scripts/validate_payloads.py --source milestone

Config is loaded the way the collectors load it — file **plus** the
``app_settings`` DB overlay (spec 12) — so a source the file marks disabled but
the overlay enables is validated, and vice versa.

Exit codes (so a cutover checklist can gate on it):

    0  every attempted source validated with no MISSING/NULL findings
    1  at least one MISSING / NULL finding (``--fail-on required`` narrows this
       to fields the contract marks required — those are cutover blockers)
    2  a source or endpoint could not be validated (unreachable, unauthenticated,
       errored, or returned zero rows). Never a silent pass (§4.5).

A source that is disabled or has no credentials is reported ``SKIPPED`` and is
explicitly *not counted as validated* — it does not fail the run, but the
cutover checklist is only satisfied when every in-scope source reaches
``VALIDATED``.

Runbook: ``docs/runbooks/payload-validation.md``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import types as _types
import typing
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from netmon import db  # noqa: E402
from netmon.config import Config, ConfigError, load_config  # noqa: E402

SOURCES = ("xiq", "packetfence", "milestone", "threecx", "rconfig")

#: Rows examined per endpoint. Enough to distinguish "absent" from "sometimes
#: absent" without draining a 10,000-row fleet endpoint.
DEFAULT_LIMIT = 25

#: Cap on EXTRA keys listed per endpoint (informational; keeps the report short).
MAX_EXTRAS = 30


# --------------------------------------------------------------- sanitization
# Everything that reaches the report goes through these. Field names are schema
# (safe) *unless* the payload uses identifiers as keys — then they are values in
# disguise and get redacted.

_MAC = re.compile(r"(?:[0-9a-f]{2}[:\-]){5}[0-9a-f]{2}", re.I)
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_IPV4 = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_HEXBLOB = re.compile(r"\b[0-9a-f]{16,}\b", re.I)
_URL = re.compile(r"\bhttps?://[^\s'\"<>]+", re.I)
_SECRET_KV = re.compile(
    r"(?i)\b(token|api_?token|password|passwd|pass|secret|community|api_?key|"
    r"authorization|bearer|cookie|session)\b\s*[:=]\s*\S+"
)
_TOKENISH = re.compile(r"\b[A-Za-z0-9_\-]{24,}\b")
#: Field *names* whose value is a credential. Even a length is too much for
#: these (a password's length is a hint), so their shape summary is type-only.
_SECRET_NAME = re.compile(
    r"(?i)(passw|passwd|\bpass\b|_pass|token|secret|community|api_?key|"
    r"credential|cookie|private_?key|salt|hash)"
)


def scrub_text(text: Any, limit: int = 200) -> str:
    """Make a free-text string (an exception message, a note) safe to print.

    Redacts URLs, credentials, emails, MACs, UUIDs, IPs, long hex/token blobs,
    collapses whitespace and truncates. Used on every message that originates
    outside this file — a client exception may quote a response body.
    """
    s = " ".join(str(text or "").split())
    s = _SECRET_KV.sub(lambda m: f"{m.group(1)}=<redacted>", s)
    s = _URL.sub("<url>", s)
    s = _EMAIL.sub("<redacted-email>", s)
    s = _MAC.sub("<mac>", s)
    s = _UUID.sub("<uuid>", s)
    s = _IPV4.sub("<ip>", s)
    s = _HEXBLOB.sub("<hex>", s)
    s = _TOKENISH.sub("<redacted>", s)
    return s if len(s) <= limit else s[: limit - 1] + "…"


def scrub_key(name: Any) -> str:
    """Field names are schema and safe to print — unless the payload keys its
    objects by an identifier (MAC/IP/UUID/email/hex), in which case the "name"
    is really a value. Those are replaced with a placeholder."""
    s = str(name)
    if not s:
        return "<empty-key>"
    if len(s) > 64:
        return "<dynamic-key>"
    for pat in (_MAC, _UUID, _IPV4, _EMAIL, _HEXBLOB):
        if pat.fullmatch(s):
            return "<dynamic-key>"
    if _EMAIL.search(s) or _MAC.search(s):
        return "<dynamic-key>"
    if re.fullmatch(r"[\w.\-\[\]/ ]+", s):
        return s
    return "<dynamic-key>"


# ------------------------------------------------------------------ JSON types

def json_type(value: Any) -> str:
    """The JSON type name of a decoded value ("null"/"bool"/"int"/…)."""
    if value is None:
        return "null"
    if isinstance(value, bool):  # bool before int — bool is an int subclass
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "str"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "dict"
    return type(value).__name__


def accepted_types(declared: Sequence[str]) -> set[str]:
    """Expand a declared type list into the JSON types that satisfy it.

    ``number`` means int|float; a declared ``float`` also accepts ``int`` (JSON
    has one number type, so 0 and 0.0 are the same declaration).
    """
    out: set[str] = set()
    for t in declared:
        if t == "number":
            out |= {"int", "float"}
        elif t == "float":
            out |= {"float", "int"}
        else:
            out.add(t)
    return out


def shape(value: Any, field_name: str = "") -> str:
    """A value's shape summary — never the value itself (§4.6).

    For a credential-looking field name the summary degrades to the bare type: a
    password's *length* is a hint we have no reason to print.
    """
    t = json_type(value)
    if field_name and _SECRET_NAME.search(field_name):
        return t

    if t == "str":
        return f"str(len={len(value)})"
    if t == "list":
        inner = sorted({json_type(v) for v in value[:20]})
        return f"list[{'|'.join(inner) or 'empty'}](n={len(value)})"
    if t == "dict":
        return f"dict(keys={len(value)})"
    return t


# ------------------------------------------------------------------- contracts

@dataclass(frozen=True)
class FieldSpec:
    """One field the code expects in a payload row.

    ``aliases`` are the other key names the parser accepts (collectors written
    against guessed shapes read several) — the group is satisfied when any one
    of them is present, and the report says which one the source actually uses.
    ``consumer`` names what goes unpopulated when the group is missing.
    """

    name: str
    types: tuple[str, ...] = ()
    required: bool = False       # parser/model cannot proceed without it
    nullable: bool = True        # contract tolerates an explicit null
    aliases: tuple[str, ...] = ()
    children: tuple["FieldSpec", ...] = ()   # nested object / array-of-objects
    consumer: str = ""

    @property
    def keys(self) -> tuple[str, ...]:
        return (self.name, *self.aliases)


@dataclass(frozen=True)
class Finding:
    kind: str     # missing | null | retyped | partial | always_null | alias_only
    field: str
    level: str    # blocker | warn | info
    detail: str


_LEVEL_ORDER = {"blocker": 0, "warn": 1, "info": 2}
_KIND_ORDER = {"missing": 0, "null": 1, "retyped": 2, "always_null": 3,
               "partial": 4, "alias_only": 5}

#: Finding kinds that mean "the code reads something the payload does not
#: reliably provide" — these gate the exit code.
GATING_KINDS = ("missing", "null", "always_null")


def _json_types_for(annotation: Any) -> tuple[set[str], bool]:
    """Map a Pydantic annotation to (accepted JSON types, nullable)."""
    origin = typing.get_origin(annotation)
    if origin in (typing.Union, _types.UnionType):
        out: set[str] = set()
        nullable = False
        for arg in typing.get_args(annotation):
            if arg is type(None):
                nullable = True
                continue
            sub, sub_null = _json_types_for(arg)
            out |= sub
            nullable = nullable or sub_null
        return out, nullable
    if origin in (list, tuple, set):
        return {"list"}, False
    if origin is dict:
        return {"dict"}, False
    if annotation is bool:
        return {"bool"}, False
    if annotation is int:
        return {"int"}, False
    if annotation is float:
        return {"float", "int"}, False
    if annotation is str:
        return {"str"}, False
    if isinstance(annotation, type) and issubclass(annotation, str):
        return {"str"}, False        # str Enum
    if isinstance(annotation, type) and issubclass(annotation, datetime):
        return {"str", "int", "float"}, False
    return set(), True               # unknown annotation → don't type-police it


def specs_from_model(model: Any) -> list[FieldSpec]:
    """Derive the expected field set from a Pydantic model — the declared
    collector-input contract (``netmon/models/``), not a hand-copied list."""
    specs: list[FieldSpec] = []
    for name, f in model.model_fields.items():
        kinds, nullable = _json_types_for(f.annotation)
        # A field is null-tolerant when its annotation admits None, or when its
        # default is None. `hostname: str = ""` is NOT null-tolerant: a live null
        # fails validation and the collector drops the whole row.
        if not f.is_required() and f.default is None:
            nullable = True
        specs.append(FieldSpec(
            name=name,
            types=tuple(sorted(kinds)),
            required=f.is_required(),
            nullable=nullable,
        ))
    return specs


# ------------------------------------------------------------------ diff logic

def diff_rows(
    rows: Sequence[dict], specs: Sequence[FieldSpec], *, prefix: str = ""
) -> tuple[list[Finding], list[dict]]:
    """Diff sampled payload rows against the declared contract.

    Returns ``(findings, extras)``. Pure and value-free: only names, JSON type
    names and counts come out, so the result is safe to print or serialize.
    """
    findings: list[Finding] = []
    extras: list[dict] = []
    n = len(rows)
    if n == 0:
        return findings, extras

    covered: set[str] = set()
    for spec in specs:
        covered.update(spec.keys)

    for spec in specs:
        label = f"{prefix}{spec.name}"
        present = nonnull = canonical = 0
        seen_types: set[str] = set()
        alias_hits: set[str] = set()
        child_rows: list[dict] = []
        scalar_where_object = False

        for row in rows:
            hit = next((k for k in spec.keys if k in row), None)
            if hit is None:
                continue
            present += 1
            if hit == spec.name:
                canonical += 1
            else:
                alias_hits.add(hit)
            value = row[hit]
            if value is None:
                continue
            nonnull += 1
            seen_types.add(json_type(value))
            if spec.children:
                if isinstance(value, dict):
                    child_rows.append(value)
                elif isinstance(value, list):
                    child_rows.extend(v for v in value if isinstance(v, dict))
                else:
                    scalar_where_object = True

        if present == 0:
            detail = f"code reads {' | '.join(spec.keys)}; payload has none of them"
            if spec.consumer:
                detail += f" → {spec.consumer} cannot be populated"
            findings.append(Finding("missing", label,
                                    "blocker" if spec.required else "warn", detail))
            continue

        nulls = present - nonnull
        if nulls and (spec.required or not spec.nullable):
            findings.append(Finding(
                "null", label, "blocker" if spec.required else "warn",
                f"null in {nulls}/{present} row(s) but the contract declares it "
                f"{'required' if spec.required else 'non-nullable'}"))
        elif nulls == present:
            findings.append(Finding(
                "always_null", label, "warn",
                f"present but null in all {present} sampled row(s) — the source "
                f"never populates it"))

        if present < n:
            findings.append(Finding("partial", label, "warn",
                                    f"present in {present}/{n} sampled row(s)"))

        allowed = accepted_types(spec.types)
        if allowed and seen_types and not (seen_types & allowed):
            findings.append(Finding(
                "retyped", label, "blocker" if spec.required else "warn",
                f"declared {'|'.join(sorted(allowed))}, live "
                f"{'|'.join(sorted(seen_types))}"))

        if canonical == 0 and alias_hits:
            findings.append(Finding(
                "alias_only", label, "info",
                f"canonical key absent; the source uses "
                f"{' | '.join(sorted(scrub_key(a) for a in alias_hits))}"))

        if spec.children:
            if child_rows:
                sub_f, sub_e = diff_rows(child_rows, spec.children, prefix=f"{label}[].")
                findings.extend(sub_f)
                extras.extend(sub_e)
            elif scalar_where_object:
                findings.append(Finding(
                    "retyped", label, "warn",
                    "expected an object or array of objects; live value is a scalar"))

    counts: dict[str, int] = {}
    kinds: dict[str, set[str]] = {}
    shapes: dict[str, str] = {}
    for row in rows:
        for key, value in row.items():
            if key in covered:
                continue
            counts[key] = counts.get(key, 0) + 1
            kinds.setdefault(key, set()).add(json_type(value))
            if value is not None and key not in shapes:
                # A shape summary (length/element count), never the value (§4.6);
                # credential-named fields degrade to the bare type.
                shapes[key] = shape(value, key)
    for key, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        extras.append({"field": f"{prefix}{scrub_key(key)}", "rows": count,
                       "types": sorted(kinds[key]),
                       "shape": shapes.get(key, "null")})

    findings.sort(key=lambda f: (_LEVEL_ORDER.get(f.level, 9),
                                 _KIND_ORDER.get(f.kind, 9), f.field))
    return findings, extras


# --------------------------------------------------------------- report models

@dataclass
class EndpointReport:
    label: str
    contract: str
    status: str = "ok"            # ok | empty | skipped | error | not_attempted
    reason: str = ""
    rows_sampled: int = 0
    findings: list[Finding] = field(default_factory=list)
    extras: list[dict] = field(default_factory=list)
    shape_only: bool = False

    @property
    def validated(self) -> bool:
        return self.status == "ok"

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for f in self.findings:
            out[f.kind] = out.get(f.kind, 0) + 1
        return out

    def to_json(self) -> dict:
        return {
            "endpoint": self.label,
            "contract": self.contract,
            "status": self.status,
            "reason": self.reason or None,
            "rows_sampled": self.rows_sampled,
            "shape_only": self.shape_only,
            "findings": [
                {"kind": f.kind, "field": f.field, "level": f.level, "detail": f.detail}
                for f in self.findings
            ],
            "extra_fields": self.extras[:MAX_EXTRAS],
            "extra_fields_total": len(self.extras),
        }


@dataclass
class SourceReport:
    source: str
    status: str = "validated"   # validated | skipped | unconfigured | unreachable
                               # | unauthenticated | throttled | error
    reason: str = ""
    endpoints: list[EndpointReport] = field(default_factory=list)

    @property
    def validated(self) -> bool:
        return self.status == "validated" and any(e.validated for e in self.endpoints)

    def gating(self) -> list[Finding]:
        return [f for e in self.endpoints for f in e.findings if f.kind in GATING_KINDS]

    def blockers(self) -> list[Finding]:
        return [f for f in self.gating() if f.level == "blocker"]

    def to_json(self) -> dict:
        return {
            "source": self.source,
            "status": self.status,
            "reason": self.reason or None,
            "validated": self.validated,
            "endpoints": [e.to_json() for e in self.endpoints],
        }


class SourceUnavailable(Exception):
    """A source cannot be validated (disabled, unconfigured, unreachable)."""

    def __init__(self, status: str, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


# ------------------------------------------------------------- sampling clients
# Subclasses of the production clients: the auth, header, retry and error
# classification behaviour is inherited untouched; only pagination is capped so
# one endpoint costs one page instead of draining the fleet.

def _sampling_xiq(token: str, base_url: str, limit: int):
    from netmon.collectors.xiq_client import XiqClient

    class SamplingXiqClient(XiqClient):
        """One page per list endpoint (overrides the paged drain only)."""

        async def _get_paged(self, path: str, params: dict) -> list[dict]:
            import httpx
            async with httpx.AsyncClient(base_url=self._base_url,
                                         timeout=self._timeout) as client:
                data = await self._get(client, path, {**params, "page": 1, "limit": limit})
            rows = data.get("data")
            return rows if isinstance(rows, list) else []

    return SamplingXiqClient(token, base_url)


def _sampling_pf(url: str, user: str, password: str, verify_ssl: bool):
    from netmon.collectors.pf_client import PfClient

    class SamplingPfClient(PfClient):
        MAX_PAGES = 1   # one /search page, not a 50-page cursor drain

    return SamplingPfClient(url=url, user=user, password=password, verify_ssl=verify_ssl)


# ------------------------------------------------------- the declared contracts
# What each endpoint's consumer in netmon/ actually reads. Model-backed payloads
# derive their spec from the Pydantic model; the rest are transcribed from the
# collector's own key reads, aliases included, with the column/state each one
# feeds so a MISSING line says what goes dark.

# XIQ ---------------------------------------------------------------------------
# views=FULL rows → ap_details / ap_radios (collectors/xiq.py build_ap_rows).
XIQ_FULL_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("id", ("int", "str"), required=True, nullable=False,
              consumer="the registry join (xiq_device_id)"),
    FieldSpec("connected", ("bool",), consumer="ap_details.uptime_s gating"),
    FieldSpec("product_type", ("str",), consumer="ap_details.model"),
    FieldSpec("serial_number", ("str",), consumer="ap_details.serial"),
    FieldSpec("mac_address", ("str",), consumer="ap_details.mgmt_mac"),
    FieldSpec("software_version", ("str",), consumer="ap_details.fw_version"),
    FieldSpec("ip_address", ("str",), consumer="ap_details.ip"),
    FieldSpec("network_policy_name", ("str",), consumer="ap_details.network_policy"),
    FieldSpec("system_up_time", ("int", "float", "str"), consumer="ap_details.uptime_s"),
    FieldSpec("active_clients", ("int",), consumer="ap_details.clients_total"),
    FieldSpec("radios", ("list",), consumer="ap_radios rows", children=(
        FieldSpec("name", ("str",), required=True, nullable=False,
                  consumer="ap_radios.radio (the row key)"),
        FieldSpec("frequency", ("str",), consumer="ap_radios.band"),
        FieldSpec("channel", ("int", "str"), consumer="ap_radios.channel"),
        FieldSpec("channel_width", ("str", "int"), consumer="ap_radios.width_mhz"),
        FieldSpec("power", ("int", "str"), consumer="ap_radios.tx_power_dbm"),
        FieldSpec("clients", ("int",), consumer="ap_radios.clients"),
    )),
)

# /clients/active?views=FULL rows → wireless_clients (build_client_rows).
XIQ_CLIENT_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("mac_address", ("str",), required=True, nullable=False,
              aliases=("mac",), consumer="wireless_clients.mac (the row key)"),
    FieldSpec("device_id", ("int", "str"), consumer="wireless_clients.device_id (AP link)"),
    FieldSpec("ssid", ("str",), consumer="wireless_clients.ssid"),
    FieldSpec("radio_type", ("str",), consumer="wireless_clients.band"),
    FieldSpec("rssi", ("int", "float"), consumer="wireless_clients.rssi_dbm"),
    FieldSpec("snr", ("int", "float"), consumer="wireless_clients.snr_db"),
    FieldSpec("os_type", ("str",), consumer="wireless_clients.os"),
    FieldSpec("hostname", ("str",), consumer="wireless_clients.hostname"),
    FieldSpec("username", ("str",), aliases=("user_name",),
              consumer="wireless_clients.username"),
    FieldSpec("ip_address", ("str",), aliases=("ip",), consumer="wireless_clients.ip"),
    FieldSpec("connection_duration", ("int", "float"),
              consumer="wireless_clients.connected_since"),
)

XIQ_POLICY_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("id", ("int",), required=True, nullable=False,
              consumer="the /network-policies/{id}/ssids fetch"),
    FieldSpec("name", ("str",), consumer="ssids.network_policy"),
)

XIQ_SSID_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("broadcast_name", ("str",), aliases=("name",), required=True,
              nullable=False, consumer="ssids.name (the row key)"),
    FieldSpec("access_security", ("dict",), consumer="ssids.auth", children=(
        FieldSpec("security_type", ("str",), consumer="ssids.auth"),
    )),
    FieldSpec("enabled", ("bool",), consumer="ssids.enabled"),
)

# PacketFence -------------------------------------------------------------------
PF_NODE_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("mac", ("str",), required=True, nullable=False,
              consumer="pf_nodes.mac (the row key)"),
    FieldSpec("pid", ("str",), consumer="pf_nodes.owner"),
    FieldSpec("computername", ("str",), consumer="pf_nodes.computername"),
    FieldSpec("status", ("str",), consumer="pf_nodes.reg_status"),
    FieldSpec("category_id", ("int", "str"),
              consumer="pf_nodes.role (via /node_categories)"),
    FieldSpec("device_class", ("str",), consumer="pf_nodes.os"),
    FieldSpec("device_type", ("str",), consumer="pf_nodes.device_type"),
    FieldSpec("device_manufacturer", ("str",), consumer="pf_nodes.vendor"),
    FieldSpec("dhcp_fingerprint", ("str",), consumer="pf_nodes.dhcp_fp"),
    FieldSpec("ip4log.ip", ("str",), aliases=("ip",), consumer="pf_nodes.ip"),
    FieldSpec("last_seen", ("str",), consumer="pf_nodes.last_seen"),
)

PF_CATEGORY_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("category_id", ("int", "str"), aliases=("id",), required=True,
              nullable=False, consumer="the category_id → role name map"),
    FieldSpec("name", ("str",), required=True, nullable=False, consumer="pf_nodes.role"),
)

PF_LOCATIONLOG_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("mac", ("str",), required=True, nullable=False,
              consumer="the pf_nodes ⋈ locationlog join"),
    FieldSpec("switch", ("str",), consumer="pf_nodes.last_switch"),
    FieldSpec("switch_ip", ("str",), consumer="pf_nodes.last_switch_ip"),
    FieldSpec("port", ("str", "int"), aliases=("ifDesc",),
              consumer="pf_nodes.last_port (the FDB⋈PF port pane)"),
    FieldSpec("vlan", ("str", "int"), consumer="pf_nodes.vlan"),
    FieldSpec("role", ("str",), consumer="pf_nodes.role fallback"),
    FieldSpec("ssid", ("str",), consumer="pf_nodes.last_ssid"),
    FieldSpec("connection_type", ("str",), consumer="pf_nodes.conn_method"),
    FieldSpec("connection_sub_type", ("str",), consumer="pf_nodes.conn_sub"),
    FieldSpec("dot1x_username", ("str",), consumer="pf_nodes.dot1x_user"),
    FieldSpec("start_time", ("str",), consumer="the newest-session-wins ordering"),
)

PF_REJECT_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("mac", ("str",), consumer="the pf.rejects tail"),
    FieldSpec("user_name", ("str",), consumer="the pf.rejects tail"),
    FieldSpec("nas_ip_address", ("str",), consumer="the pf.rejects tail"),
    FieldSpec("nas_port_id", ("str", "int"), consumer="the pf.rejects tail"),
    FieldSpec("reason", ("str",), consumer="the pf.rejects tail"),
    FieldSpec("created_at", ("str",), consumer="the pf.rejects tail"),
)

# Milestone (Config API only — never the Events/State WebSocket) -----------------
MILESTONE_RS_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("id", ("str", "int"), required=True, nullable=False,
              consumer="the registry join (milestone_hardware_id)"),
    FieldSpec("hostName", ("str",), aliases=("hostname", "name"),
              consumer="recording_servers.hostname"),
    FieldSpec("role", ("str",), aliases=("serverType",), consumer="recording_servers.role"),
    FieldSpec("productVersion", ("str",), aliases=("version",),
              consumer="recording_servers.version"),
    FieldSpec("cameraCount", ("int",), aliases=("channels",),
              consumer="recording_servers.chans_total"),
    FieldSpec("recordingCameraCount", ("int",),
              consumer="recording_servers.chans_recording"),
    FieldSpec("running", ("bool", "str"), aliases=("state", "enabled"),
              consumer="device_state.source_status (RS up/down)"),
    FieldSpec("retentionDays", ("int", "float"),
              consumer="recording_servers.retention_days"),
)

MILESTONE_CAMERA_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("id", ("str", "int"), required=True, nullable=False,
              consumer="the registry join (milestone_hardware_id)"),
    FieldSpec("hardwareId", ("str", "int"), aliases=("hardware",),
              consumer="the /hardware enrichment join"),
    FieldSpec("model", ("str",), aliases=("shortName",), consumer="cameras.model"),
    FieldSpec("resolution", ("str",), consumer="cameras.resolution"),
    FieldSpec("framerate", ("int", "float"), aliases=("fps",), consumer="cameras.fps_target"),
    FieldSpec("codec", ("str",), consumer="cameras.codec"),
    FieldSpec("bitrateMode", ("str",), consumer="cameras.bitrate_mode"),
    FieldSpec("recordingMode", ("str",), aliases=("recordingType",),
              consumer="cameras.recording_mode"),
    FieldSpec("stateMessage", ("str",), aliases=("state",), consumer="cameras.state_msg"),
    FieldSpec("address", ("str",), aliases=("ip",), consumer="cameras.ip"),
    FieldSpec("mac", ("str",), aliases=("macAddress",),
              consumer="cameras.mac (the FDB ⋈ switch-port payoff)"),
    FieldSpec("recordingServerId", ("str", "int"), aliases=("recordingServer",),
              consumer="cameras.recording_server_device_id"),
    FieldSpec("recordingEnabled", ("bool", "str"), aliases=("recording", "enabled"),
              consumer="device_state.recording (camera recording up/down)"),
)

MILESTONE_STORAGE_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("recordingServerId", ("str", "int"), aliases=("recordingServer",),
              consumer="the per-RS storage roll-up"),
    FieldSpec("usedSpace", ("int", "float"), aliases=("used",),
              consumer="recording_servers.storage_used_gb"),
    FieldSpec("size", ("int", "float"), aliases=("total",),
              consumer="recording_servers.storage_total_gb"),
    FieldSpec("retentionDays", ("int", "float"),
              consumer="recording_servers.retention_days"),
)

MILESTONE_HARDWARE_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("id", ("str", "int"), required=True, nullable=False,
              consumer="the cameras.hardwareId join"),
    FieldSpec("model", ("str",), consumer="cameras.model fallback"),
    FieldSpec("mac", ("str",), aliases=("macAddress",), consumer="cameras.mac fallback"),
    FieldSpec("address", ("str",), aliases=("ip",), consumer="cameras.ip fallback"),
)

# 3CX ---------------------------------------------------------------------------
THREECX_TRUNK_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("Id", ("int", "str"), aliases=("id", "Number", "number", "Name", "name"),
              required=True, nullable=False,
              consumer="the registry join (threecx_ref) — no trunk row without it"),
    FieldSpec("Name", ("str",), aliases=("name",), consumer="trunks.name"),
    FieldSpec("Host", ("str",), aliases=("host", "OutboundProxy", "Server"),
              consumer="trunks.provider_host"),
    FieldSpec("MainNumber", ("str", "int"), aliases=("Number", "number"),
              consumer="trunks.did"),
    FieldSpec("Registered", ("bool",), aliases=("IsRegistered", "registered",
                                                "RegistrationStatus", "Status"),
              required=True, nullable=False,
              consumer="device_state.trunk (trunk up/down) and trunks.reg_status"),
    FieldSpec("SimultaneousCalls", ("int",), aliases=("MaxSimCalls", "Channels"),
              consumer="trunks.ch_total"),
    FieldSpec("ActiveCalls", ("int",), aliases=("CallsInProgress",),
              consumer="trunks.ch_in_use"),
)

THREECX_EXTENSION_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("Number", ("str", "int"), aliases=("number", "Extension", "extension"),
              required=True, nullable=False, consumer="extensions.ext (the row key)"),
    FieldSpec("FirstName", ("str",), aliases=("firstName",), consumer="extensions.name"),
    FieldSpec("LastName", ("str",), aliases=("lastName",), consumer="extensions.name"),
    FieldSpec("DisplayName", ("str",), aliases=("Name", "name"),
              consumer="extensions.name fallback"),
    FieldSpec("Office", ("str",), aliases=("Site", "Department"), consumer="extensions.site"),
    FieldSpec("IsRegistered", ("bool",), aliases=("Registered", "registered"),
              consumer="extensions.registered"),
    FieldSpec("Dnd", ("bool",), aliases=("DND", "dnd"), consumer="extensions.dnd"),
)

# The VoIP page renders the SystemStatus blob generically and only reads these
# two by name — everything else there is informational.
THREECX_SYSTEM_SPECS: tuple[FieldSpec, ...] = (
    FieldSpec("CallsActive", ("int",), consumer="the VoIP page 'Active calls' tile"),
    FieldSpec("Version", ("str",), consumer="the VoIP page '3CX version' tile"),
)


def rconfig_device_specs() -> tuple[FieldSpec, ...]:
    """rConfig rows → the ``config_backup`` freshness dimension.

    The collector probes a whole alias list for a backup timestamp (the exact
    name was never confirmed against the live rConfig); if none of them is
    present every device reads ``config_backup = unknown`` forever.
    """
    from netmon.collectors.rconfig import _TS_KEYS

    return (
        FieldSpec("id", ("int", "str"), required=True, nullable=False,
                  consumer="the registry join (rconfig_device_id)"),
        FieldSpec(_TS_KEYS[0], ("str", "int", "float"), aliases=tuple(_TS_KEYS[1:]),
                  required=True, nullable=False,
                  consumer="device_state.config_backup (backup freshness)"),
    )


def xiq_basic_specs() -> tuple[FieldSpec, ...]:
    """``GET /devices?views=BASIC`` — derived from the declared Pydantic model."""
    from netmon.models.xiq import XiqDevice

    return tuple(specs_from_model(XiqDevice))


# --------------------------------------------------------------- endpoint sets

def _settings(cfg: Config, name: str) -> dict[str, str]:
    src = cfg.sources.get(name)
    return dict(src.settings) if src else {}


def _flag(settings: dict[str, str], key: str, default: bool = True) -> bool:
    return str(settings.get(key, default)).strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Endpoint:
    label: str
    contract: str
    fetch: Callable[[], Awaitable[Any]]
    specs: tuple[FieldSpec, ...] = ()
    container: str = "list"        # list → rows; object → a single row
    skip_reason: str = ""
    note: str = ""

    @property
    def shape_only(self) -> bool:
        return not self.specs


def _xiq_endpoints(cfg: Config, limit: int) -> list[Endpoint]:
    from netmon.collectors.xiq_client import BASE_URL

    s = _settings(cfg, "xiq")
    token = (s.get("api_token") or "").strip()
    if not token:
        raise SourceUnavailable("unconfigured", "[xiq] api_token is not set")
    client = _sampling_xiq(token, (s.get("base_url") or BASE_URL).strip(), limit)

    async def fetch_ssids() -> list[dict]:
        policies = await client.get_network_policies()
        pid = next((p.get("id") for p in policies
                    if isinstance(p.get("id"), int) or str(p.get("id") or "").isdigit()), None)
        if pid is None:
            raise SourceUnavailable(
                "error", "no network policy id in the payload to sample SSIDs with")
        return await client.get_policy_ssids(int(pid))

    detail_off = "" if _flag(s, "detail_enabled") else "[xiq] detail_enabled = false"
    clients_off = "" if _flag(s, "clients_enabled") else (
        "[xiq] clients_enabled = false (PII cycle disabled — not fetched)")
    ssids_off = "" if _flag(s, "ssids_enabled") else "[xiq] ssids_enabled = false"

    return [
        Endpoint("GET /devices?views=BASIC", "netmon/models/xiq.py XiqDevice",
                 lambda: client.get_devices("BASIC"), specs=xiq_basic_specs()),
        Endpoint("GET /devices?views=FULL", "collectors/xiq.py build_ap_rows",
                 lambda: client.get_devices("FULL"), specs=XIQ_FULL_SPECS,
                 skip_reason=detail_off),
        Endpoint("GET /clients/active?views=FULL", "collectors/xiq.py build_client_rows",
                 lambda: client.get_active_clients(), specs=XIQ_CLIENT_SPECS,
                 skip_reason=clients_off),
        Endpoint("GET /network-policies", "collectors/xiq.py run_once (ssids cycle)",
                 lambda: client.get_network_policies(), specs=XIQ_POLICY_SPECS,
                 skip_reason=ssids_off),
        Endpoint("GET /network-policies/{id}/ssids", "collectors/xiq.py build_ssid_rows",
                 fetch_ssids, specs=XIQ_SSID_SPECS, skip_reason=ssids_off),
    ]


def _pf_endpoints(cfg: Config, limit: int) -> list[Endpoint]:
    from netmon.collectors.packetfence import SNAPSHOT_FETCHES

    s = _settings(cfg, "packetfence")
    url = (s.get("url") or "").strip()
    if not url:
        raise SourceUnavailable("unconfigured", "[packetfence] url is not set")
    if not (s.get("user") or "").strip():
        raise SourceUnavailable("unconfigured", "[packetfence] user is not set")
    client = _sampling_pf(url, (s.get("user") or "").strip(), s.get("pass") or "",
                          _flag(s, "verify_ssl"))

    async def fetch_categories() -> list[dict]:
        data = await client.get_json("/api/v1/node_categories?limit=500")
        items = data.get("items")
        return items if isinstance(items, list) else []

    endpoints = [
        Endpoint("POST /api/v1/nodes/search (read-only query)",
                 "collectors/pf_client.py nodes() → build_pf_rows",
                 lambda: client.nodes(limit=limit), specs=PF_NODE_SPECS),
        Endpoint("GET /api/v1/node_categories",
                 "collectors/pf_client.py node_categories()",
                 fetch_categories, specs=PF_CATEGORY_SPECS),
        Endpoint("POST /api/v1/locationlogs/search (read-only query)",
                 "collectors/pf_client.py open_locationlogs() → build_pf_rows",
                 lambda: client.open_locationlogs(limit=limit),
                 specs=PF_LOCATIONLOG_SPECS),
        Endpoint("POST /api/v1/radius_audit_logs/search (read-only query)",
                 "collectors/pf_client.py recent_auth_failures() → snapshot pf.rejects",
                 lambda: client.recent_auth_failures(limit=min(limit, 10)),
                 specs=PF_REJECT_SPECS),
    ]
    # snapshot_cache singletons: the UI renders them as generic key/value cards,
    # so there is no field contract to diff — reachability + top-level shape is
    # the whole check. PF answers 404-as-empty, which shows up as an empty dict.
    for key, path in SNAPSHOT_FETCHES:
        endpoints.append(Endpoint(
            f"GET {path}", f"snapshot_cache['{key}'] (opaque blob — shape only)",
            (lambda p=path: client.get_json(p)), container="object"))
    return endpoints


def _milestone_endpoints(cfg: Config, limit: int) -> list[Endpoint]:
    from netmon.collectors.milestone_client import MilestoneClient

    s = _settings(cfg, "milestone")
    host = (s.get("host") or "").strip()
    if not host:
        raise SourceUnavailable("unconfigured", "[milestone] host is not set")
    client = MilestoneClient(
        host=host, user=(s.get("user") or "").strip(), password=s.get("pass") or "",
        scheme=(s.get("scheme") or "https").strip(),
        client_id=(s.get("client_id") or "GrantValidatorClient").strip(),
        verify_ssl=_flag(s, "verify_ssl"),
    )

    return [
        Endpoint("GET /api/rest/v1/recordingServers",
                 "collectors/milestone.py build_recording_servers",
                 client.recording_servers, specs=MILESTONE_RS_SPECS),
        Endpoint("GET /api/rest/v1/cameras", "collectors/milestone.py build_cameras",
                 client.cameras, specs=MILESTONE_CAMERA_SPECS),
        Endpoint("GET /api/rest/v1/storages",
                 "collectors/milestone.py run_once (storage roll-up, fail-soft)",
                 client.storage, specs=MILESTONE_STORAGE_SPECS),
        Endpoint("GET /api/rest/v1/hardware",
                 "collectors/milestone.py run_once (hardware enrichment, fail-soft)",
                 client.hardware, specs=MILESTONE_HARDWARE_SPECS),
    ]


def _threecx_endpoints(cfg: Config, limit: int) -> list[Endpoint]:
    from netmon.collectors.threecx_client import ThreeCxClient

    s = _settings(cfg, "threecx")
    url = (s.get("url") or "").strip()
    if not url:
        raise SourceUnavailable("unconfigured", "[threecx] url is not set")
    if not (s.get("client_id") or "").strip():
        raise SourceUnavailable("unconfigured", "[threecx] client_id is not set")
    client = ThreeCxClient(url=url, client_id=(s.get("client_id") or "").strip(),
                           client_secret=s.get("client_secret") or "",
                           verify_ssl=_flag(s, "verify_ssl"))

    return [
        Endpoint("GET /xapi/v1/Trunks", "collectors/threecx.py build_trunk_rows",
                 client.trunks, specs=THREECX_TRUNK_SPECS),
        Endpoint("GET /xapi/v1/Users", "collectors/threecx.py build_extension_rows",
                 client.extensions, specs=THREECX_EXTENSION_SPECS),
        Endpoint("GET /xapi/v1/SystemStatus", "snapshot_cache['threecx.system']",
                 client.system_status, specs=THREECX_SYSTEM_SPECS, container="object"),
    ]


def _rconfig_endpoints(cfg: Config, limit: int) -> list[Endpoint]:
    from netmon.collectors.rconfig_client import RConfigClient, RConfigError

    s = _settings(cfg, "rconfig")
    url = (s.get("url") or "").strip()
    if not url:
        raise SourceUnavailable("unconfigured", "[rconfig] url is not set")
    if not (s.get("api_token") or "").strip():
        raise SourceUnavailable("unconfigured", "[rconfig] api_token is not set")
    try:
        client = RConfigClient(url=url, token=s.get("api_token") or "",
                               verify_ssl=_flag(s, "verify_ssl"))
    except RConfigError as exc:
        raise SourceUnavailable("unconfigured", scrub_text(exc)) from exc

    async def fetch_devices() -> list[dict]:
        rows = await client.devices()
        return rows[:limit]

    return [
        Endpoint("GET /api/v2/devices", "collectors/rconfig.py _last_backup",
                 fetch_devices, specs=rconfig_device_specs()),
    ]


BUILDERS: dict[str, Callable[[Config, int], list[Endpoint]]] = {
    "xiq": _xiq_endpoints,
    "packetfence": _pf_endpoints,
    "milestone": _milestone_endpoints,
    "threecx": _threecx_endpoints,
    "rconfig": _rconfig_endpoints,
}


# ------------------------------------------------------------------- execution

_AUTH_EXC = ("XiqAuthError", "PfAuthError", "MilestoneAuthError", "ThreeCxAuthError")


def classify(exc: BaseException) -> str:
    """Exception → source status. Auth and throttling are distinct from blind."""
    name = type(exc).__name__
    if name in _AUTH_EXC:
        return "unauthenticated"
    if name == "XiqRateLimitError":
        return "throttled"
    return "unreachable"


def _as_rows(payload: Any, container: str) -> list[dict]:
    """Normalize a fetched payload into sampled rows."""
    if payload is None:
        return []
    if isinstance(payload, dict):
        if container == "object":
            # An empty object is PF's 404-means-empty sentinel (and Milestone's
            # "endpoint absent") — nothing to validate, report it as empty.
            return [payload] if payload else []
        for key in ("items", "data", "array", "value", "results"):
            v = payload.get(key)
            if isinstance(v, list):
                return [r for r in v if isinstance(r, dict)]
        return [payload]
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    return []


async def validate_source(cfg: Config, name: str, *, limit: int = DEFAULT_LIMIT,
                          include_disabled: bool = False) -> SourceReport:
    """Validate one source. Never raises — every failure is a reported status."""
    report = SourceReport(name)
    src = cfg.sources.get(name)
    if not (src and src.enabled) and not include_disabled:
        report.status = "skipped"
        report.reason = (f"[{name}] enabled = false in the effective config "
                         f"(file + app_settings overlay) — not validated")
        return report

    try:
        endpoints = BUILDERS[name](cfg, limit)
    except SourceUnavailable as exc:
        report.status = exc.status
        report.reason = scrub_text(exc.reason)
        return report
    except Exception as exc:  # client construction refused the settings
        report.status = "unconfigured"
        report.reason = scrub_text(exc)
        return report

    aborted = ""
    any_ok = False
    for ep in endpoints:
        er = EndpointReport(ep.label, ep.contract, shape_only=ep.shape_only)
        if aborted:
            er.status, er.reason = "not_attempted", aborted
            report.endpoints.append(er)
            continue
        if ep.skip_reason:
            er.status, er.reason = "skipped", scrub_text(ep.skip_reason)
            report.endpoints.append(er)
            continue
        try:
            payload = await ep.fetch()
        except SourceUnavailable as exc:
            er.status, er.reason = "error", scrub_text(exc.reason)
            report.endpoints.append(er)
            continue
        except Exception as exc:
            status = classify(exc)
            er.status, er.reason = "error", f"{status}: {scrub_text(exc)}"
            report.endpoints.append(er)
            if not any_ok:
                # Nothing has answered yet: the failure is the source itself
                # (auth/transport), not one odd endpoint — stop knocking.
                report.status = status
                report.reason = er.reason
                aborted = f"source marked {status} before this endpoint was reached"
            continue

        rows = _as_rows(payload, ep.container)
        er.rows_sampled = len(rows)
        any_ok = any_ok or bool(rows)
        if not rows:
            er.status = "empty"
            er.reason = ("the endpoint returned no rows — the contract could not be "
                         "checked (an empty PF /search result and a missing endpoint "
                         "look the same here)")
            report.endpoints.append(er)
            continue
        if ep.shape_only:
            _, extras = diff_rows(rows, ())
            er.extras = extras
        else:
            er.findings, er.extras = diff_rows(rows, ep.specs)
        report.endpoints.append(er)

    if report.status == "validated" and not any(e.validated for e in report.endpoints):
        report.status = "error"
        report.reason = report.reason or "no endpoint could be validated"
    return report


# ---------------------------------------------------------------- presentation

_KIND_LABEL = {"missing": "MISSING", "null": "NULL", "retyped": "RETYPED",
               "always_null": "ALWAYS-NULL", "partial": "PARTIAL",
               "alias_only": "ALIAS-ONLY"}

_STATUS_NOTE = {
    "validated": "VALIDATED",
    "skipped": "SKIPPED (not validated)",
    "unconfigured": "SKIPPED — no credentials (not validated)",
    "unreachable": "UNREACHABLE (not validated)",
    "unauthenticated": "UNAUTHENTICATED (not validated)",
    "throttled": "THROTTLED (not validated)",
    "error": "ERROR (not validated)",
}


def render_text(reports: list[SourceReport], *, cfg_path: str, overlay: str,
                limit: int, out=None) -> None:
    out = sys.stdout if out is None else out
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    p = lambda s="": print(s, file=out)  # noqa: E731
    p("NetMon live-source payload validation")
    p("=" * 72)
    p(f"generated   {now}")
    p(f"config      {cfg_path}")
    p(f"overlay     {overlay}")
    p(f"sample      first page only, up to {limit} row(s), per paged endpoint")
    p("            (an unpaged endpoint reports every row it returned — see rows=)")
    p("            a page is NOT a random sample: a field only some device types")
    p("            carry (radios on APs, say) can read MISSING because the page")
    p("            held none of them. Confirm a surprise with a larger --limit.")
    p("requests    read-only GET, plus each source's own auth-token grant and "
      "PacketFence's")
    p("            /search query POST. Nothing is created, changed or deleted.")
    p("report      field NAMES, TYPES and COUNTS only — no payload values (§4.6)")
    p()

    for r in reports:
        head = f"--- {r.source} — {_STATUS_NOTE.get(r.status, r.status.upper())}"
        p(head)
        if r.reason:
            p(f"    reason: {r.reason}")
        if not r.endpoints:
            p()
            continue
        for e in r.endpoints:
            if e.status == "skipped":
                p(f"  · {e.label}")
                p(f"      SKIPPED — {e.reason}")
                continue
            if e.status == "not_attempted":
                p(f"  · {e.label}")
                p(f"      NOT ATTEMPTED — {e.reason}")
                continue
            if e.status == "error":
                p(f"  · {e.label}")
                p(f"      ERROR — {e.reason}")
                continue
            p(f"  · {e.label}   rows={e.rows_sampled}")
            p(f"      contract: {e.contract}")
            if e.status == "empty":
                p(f"      EMPTY — {e.reason}")
                continue
            if e.shape_only:
                keys = ", ".join(f"{x['field']}:{x['shape']}"
                                 for x in e.extras[:MAX_EXTRAS])
                p(f"      shape only — {len(e.extras)} top-level key(s)"
                  + (f": {keys}" if keys else ""))
                continue
            if not e.findings:
                p("      OK — every expected field present with a matching type")
            for f in e.findings:
                mark = "‼" if f.level == "blocker" else ("!" if f.level == "warn" else "·")
                p(f"      {mark} {_KIND_LABEL.get(f.kind, f.kind.upper())} {f.field}: {f.detail}")
            if e.extras:
                shown = ", ".join(f"{x['field']}:{x['shape']}"
                                  for x in e.extras[:MAX_EXTRAS])
                more = "" if len(e.extras) <= MAX_EXTRAS else f" … +{len(e.extras) - MAX_EXTRAS} more"
                p(f"      EXTRA ({len(e.extras)}) ignored by the code: {shown}{more}")
        p()

    p("Summary")
    p("-" * 72)
    for r in reports:
        gating, blockers = r.gating(), r.blockers()
        bits = [f"{len([e for e in r.endpoints if e.validated])}/{len(r.endpoints)} endpoint(s) checked"]
        if gating:
            bits.append(f"{len(gating)} missing/null ({len(blockers)} on required field(s))")
        p(f"  {r.source:12} {_STATUS_NOTE.get(r.status, r.status):34} {', '.join(bits)}")
    p()
    p("A MISSING/NULL finding on a REQUIRED field (‼) is a cutover blocker: the")
    p("parser cannot build the row. A warn-level one leaves a column NULL and the")
    p("UI showing '—'. See docs/runbooks/payload-validation.md.")


def render_json(reports: list[SourceReport], *, cfg_path: str, overlay: str,
                limit: int, exit_code: int, out=None) -> None:
    out = sys.stdout if out is None else out
    payload = {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "config_path": cfg_path,
        "settings_overlay": overlay,
        "rows_per_endpoint": limit,
        "sanitized": True,
        "read_only": True,
        "exit_code": exit_code,
        "totals": {
            "sources_validated": sum(1 for r in reports if r.validated),
            "sources_total": len(reports),
            "missing_or_null": sum(len(r.gating()) for r in reports),
            "blockers": sum(len(r.blockers()) for r in reports),
        },
        "sources": [r.to_json() for r in reports],
    }
    json.dump(payload, out, indent=2)
    out.write("\n")


def exit_code_for(reports: list[SourceReport], fail_on: str) -> int:
    """0 clean · 1 missing/null findings · 2 something could not be validated."""
    gating = [f for r in reports for f in r.gating()]
    if fail_on == "required":
        gating = [f for f in gating if f.level == "blocker"]
    if gating:
        return 1
    attempted_bad = any(r.status in ("unreachable", "unauthenticated", "throttled", "error")
                        for r in reports)
    endpoint_bad = any(e.status in ("error", "empty")
                       for r in reports for e in r.endpoints)
    return 2 if (attempted_bad or endpoint_bad) else 0


# -------------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Diff live source payloads against the contract NetMon's "
                    "models/parsers declare. Read-only; output is sanitized.")
    p.add_argument("--source", default="all", choices=(*SOURCES, "all"),
                   help="source to validate (default: all)")
    p.add_argument("--config", default=None, help="NetMon config path (default $NETMON_CONF)")
    p.add_argument("--json", action="store_true", dest="as_json",
                   help="emit the machine-readable report")
    p.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                   help=f"rows sampled per endpoint (default {DEFAULT_LIMIT})")
    p.add_argument("--include-disabled", action="store_true",
                   help="also validate sources the effective config disables")
    p.add_argument("--fail-on", choices=("any", "required"), default="any",
                   help="exit 1 on any MISSING/NULL finding (default) or only on "
                        "those against a required field")
    args = p.parse_args(argv)

    try:
        cfg = load_config(args.config)
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    # Effective config = file + app_settings overlay, exactly as the collectors
    # see it (spec 12 S9). Without the overlay a live source can look disabled.
    try:
        from netmon import settings as settings_engine
        engine = db.make_engine(cfg.db.url)
        rows = settings_engine.load_overrides(engine)  # probe, so the header is honest
        cfg = settings_engine.overlay_config(cfg, engine)
        overlay = f"app_settings overlay applied ({len(rows)} override row(s))"
    except Exception as exc:
        overlay = (f"UNAVAILABLE — file config only ({scrub_text(exc, 120)}); "
                   f"a live source may look disabled")
        print(f"WARNING: settings overlay unavailable: {scrub_text(exc, 160)}",
              file=sys.stderr)

    names = list(SOURCES) if args.source == "all" else [args.source]
    limit = max(1, args.limit)

    async def _run() -> list[SourceReport]:
        return [await validate_source(cfg, n, limit=limit,
                                      include_disabled=args.include_disabled)
                for n in names]

    reports = asyncio.run(_run())
    code = exit_code_for(reports, args.fail_on)
    if args.as_json:
        render_json(reports, cfg_path=cfg.path, overlay=overlay, limit=limit,
                    exit_code=code)
    else:
        render_text(reports, cfg_path=cfg.path, overlay=overlay, limit=limit)
    return code


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
