"""Settings engine — web-editable configuration overlay (docs/spec/12).

``netmon.conf`` stays the bootstrap source of truth; admins override individual
keys from the web and the overrides live in ``app_settings``. Effective value:

    DB override  →  conf file  →  code default

The REGISTRY below — not the database — defines what is editable. Bootstrap and
recovery keys ([db], web bind, secure_cookies, break-glass account, dev bypass,
[security], executable paths) are deliberately absent: a web edit must never
brick boot, lock the owner out, or repoint a subprocess binary (spec 12 S2).

Secrets (kind="secret") are write-only: sealed at rest via netmon.secretbox,
decrypted only into the in-memory Config handed to collectors, and never
returned by any API.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db, secretbox
from netmon.config import Config, SourceToggle, _as_bool

log = logging.getLogger("netmon.settings")

# Sections whose defs overlay typed config dataclass attributes (def.attr);
# everything else in the registry is a raw source-section string setting.
TYPED_SECTIONS = ("web", "auth", "poller", "snmp_inventory", "engine")

SECTION_LABELS = {
    "web": "Web sessions",
    "auth": "Single sign-on (SAML)",
    "poller": "Native poller",
    "snmp_inventory": "SNMP inventory sweeps",
    "engine": "Alert engine & email",
    "xiq": "ExtremeCloud IQ",
    "packetfence": "PacketFence",
    "milestone": "Milestone XProtect",
    "threecx": "3CX",
    "rconfig": "rConfig",
}


@dataclass(frozen=True)
class SettingDef:
    key: str                 # "poller.ping_interval_s" — section.name
    kind: str                # str | int | bool | secret
    default: Any
    label: str
    description: str = ""
    attr: str | None = None  # dataclass attribute for TYPED_SECTIONS
    map_role: tuple[str, str] | None = None  # ("role_values"|"group_values", role)
    restart: bool = False    # False => a settings "Apply" picks it up; True => service restart
    min: int | None = None
    max: int | None = None

    @property
    def section(self) -> str:
        return self.key.split(".", 1)[0]

    @property
    def name(self) -> str:
        return self.key.split(".", 1)[1]


def _d(key, kind, default, label, description="", *, attr=None, map_role=None,
       restart=False, min=None, max=None) -> SettingDef:
    return SettingDef(key=key, kind=kind, default=default, label=label,
                      description=description, attr=attr, map_role=map_role,
                      restart=restart, min=min, max=max)


REGISTRY: list[SettingDef] = [
    # --- web ---
    _d("web.session_ttl", "int", 43200, "Session lifetime (s)",
       "Opaque session cookie lifetime.", attr="session_ttl", restart=True, min=300),

    # --- auth / SAML (break-glass + dev bypass stay file-only) ---
    _d("auth.saml_idp_entity_id", "str", "", "IdP entity ID", attr="idp_entity_id"),
    _d("auth.saml_idp_sso_url", "str", "", "IdP SSO URL", attr="idp_sso_url"),
    _d("auth.saml_idp_x509cert", "str", "", "IdP signing certificate",
       "Base64, no PEM headers.", attr="idp_x509cert"),
    _d("auth.saml_sp_entity_id", "str", "", "SP entity ID", attr="sp_entity_id"),
    _d("auth.saml_sp_acs_url", "str", "", "SP ACS URL", attr="sp_acs_url"),
    _d("auth.saml_sp_slo_url", "str", "", "SP SLO URL", attr="sp_slo_url"),
    _d("auth.saml_sp_cert", "str", "", "SP certificate", attr="sp_cert"),
    _d("auth.saml_sp_key", "secret", "", "SP private key",
       "Write-only. Used to sign AuthnRequests.", attr="sp_key"),
    _d("auth.saml_role_attr", "str", "role", "Role attribute name", attr="role_attr"),
    _d("auth.saml_group_attr", "str", "group_ids", "Group attribute name", attr="group_attr"),
    _d("auth.saml_role_admin", "str", "", "Claim values → admin",
       "Comma-separated role-claim values granting admin.", map_role=("role_values", "admin")),
    _d("auth.saml_role_operator", "str", "", "Claim values → operator",
       map_role=("role_values", "operator")),
    _d("auth.saml_role_viewer", "str", "", "Claim values → viewer",
       map_role=("role_values", "viewer")),
    _d("auth.saml_group_admin", "str", "", "Group ids → admin",
       "Comma-separated group_ids granting admin.", map_role=("group_values", "admin")),
    _d("auth.saml_group_operator", "str", "", "Group ids → operator",
       map_role=("group_values", "operator")),
    _d("auth.saml_group_viewer", "str", "", "Group ids → viewer",
       map_role=("group_values", "viewer")),

    # --- poller (fping/snmpget executable paths stay file-only) ---
    _d("poller.enabled", "bool", False, "Enable native poller", attr="enabled"),
    _d("poller.ping_interval_s", "int", 60, "Ping sweep interval (s)",
       attr="ping_interval_s", min=10),
    _d("poller.snmp_interval_s", "int", 300, "SNMP-alive interval (s)",
       attr="snmp_interval_s", min=30),
    _d("poller.fail_threshold", "int", 3, "Failures to declare DOWN",
       attr="fail_threshold", min=1),
    _d("poller.ok_threshold", "int", 2, "Successes to declare UP",
       attr="ok_threshold", min=1),
    _d("poller.fping_timeout_ms", "int", 500, "fping timeout (ms)",
       attr="fping_timeout_ms", min=50),
    _d("poller.fping_retries", "int", 1, "fping retries", attr="fping_retries", min=0),
    _d("poller.snmp_version", "str", "2c", "SNMP version", attr="snmp_version"),
    _d("poller.snmp_community", "secret", "", "SNMP RO community",
       "Write-only.", attr="snmp_community"),
    _d("poller.snmp_timeout_s", "int", 2, "snmpget timeout (s)", attr="snmp_timeout_s", min=1),
    _d("poller.snmp_retries", "int", 1, "snmpget retries", attr="snmp_retries", min=0),
    _d("poller.snmp_concurrency", "int", 20, "SNMP concurrency", attr="snmp_concurrency", min=1),

    # --- snmp_inventory ---
    _d("snmp_inventory.enabled", "bool", False, "Enable inventory sweeps", attr="enabled"),
    _d("snmp_inventory.concurrency", "int", 8, "Switches in flight", attr="concurrency", min=1),
    _d("snmp_inventory.run_timeout_s", "int", 900, "Run budget (s)",
       "Hard cap for one full run (all due sweeps, whole fleet). A run that "
       "merely outlives the fastest interval delays the next tick; it is only "
       "cancelled past this budget.", attr="run_timeout_s", min=60),
    _d("snmp_inventory.sweep_ports", "bool", True, "Sweep: ports/PoE", attr="sweep_ports"),
    _d("snmp_inventory.ports_interval_s", "int", 120, "Ports interval (s)",
       attr="ports_interval_s", min=30),
    _d("snmp_inventory.sweep_poe", "bool", True, "Sweep: PoE", attr="sweep_poe"),
    _d("snmp_inventory.poe_interval_s", "int", 300, "PoE interval (s)",
       attr="poe_interval_s", min=30),
    _d("snmp_inventory.sweep_fdb", "bool", True, "Sweep: FDB", attr="sweep_fdb"),
    _d("snmp_inventory.fdb_interval_s", "int", 900, "FDB interval (s)",
       attr="fdb_interval_s", min=60),
    _d("snmp_inventory.sweep_lldp", "bool", True, "Sweep: LLDP", attr="sweep_lldp"),
    _d("snmp_inventory.lldp_interval_s", "int", 1800, "LLDP interval (s)",
       attr="lldp_interval_s", min=60),
    _d("snmp_inventory.sweep_vlans", "bool", True, "Sweep: VLANs", attr="sweep_vlans"),
    _d("snmp_inventory.vlans_interval_s", "int", 3600, "VLANs interval (s)",
       attr="vlans_interval_s", min=60),
    _d("snmp_inventory.sweep_stack", "bool", True, "Sweep: stack/env", attr="sweep_stack"),
    _d("snmp_inventory.stack_interval_s", "int", 300, "Stack interval (s)",
       attr="stack_interval_s", min=30),

    # --- engine ---
    _d("engine.enabled", "bool", False, "Enable alert engine", attr="enabled"),
    _d("engine.interval_s", "int", 30, "Evaluation interval (s)", attr="interval_s", min=5),
    _d("engine.shadow", "bool", True, "Shadow mode",
       "ON: would-be notifications are logged, no email is sent. Turning this "
       "OFF starts real email — the Phase 8 cutover decision.", attr="shadow"),
    _d("engine.smtp_host", "str", "", "SMTP relay host", attr="smtp_host"),
    _d("engine.smtp_port", "int", 25, "SMTP port", attr="smtp_port", min=1, max=65535),
    _d("engine.smtp_from", "str", "", "From address", attr="smtp_from"),
    _d("engine.default_target", "str", "", "Default notification target", attr="default_target"),

    # --- sources (raw section settings; collectors parse them) ---
    _d("xiq.enabled", "bool", False, "Enable XIQ collector"),
    _d("xiq.api_token", "secret", "", "API token", "Write-only bearer token."),
    _d("xiq.base_url", "str", "https://api.extremecloudiq.com", "Base URL"),
    _d("xiq.status_interval_s", "int", 180, "Status interval (s)", min=30),

    _d("packetfence.enabled", "bool", False, "Enable PacketFence collector"),
    _d("packetfence.url", "str", "", "Base URL"),
    _d("packetfence.user", "str", "", "API user"),
    _d("packetfence.pass", "secret", "", "API password", "Write-only."),
    _d("packetfence.verify_ssl", "bool", True, "Verify TLS certificate"),
    _d("packetfence.interval_s", "int", 300, "Poll interval (s)", min=30),

    _d("milestone.enabled", "bool", False, "Enable Milestone collector"),
    _d("milestone.host", "str", "", "API Gateway host"),
    _d("milestone.user", "str", "", "API user"),
    _d("milestone.pass", "secret", "", "API password", "Write-only."),
    _d("milestone.scheme", "str", "https", "Scheme"),
    _d("milestone.client_id", "str", "GrantValidatorClient", "OAuth client id"),
    _d("milestone.verify_ssl", "bool", True, "Verify TLS certificate"),
    _d("milestone.interval_s", "int", 120, "Poll interval (s)", min=30),

    _d("threecx.enabled", "bool", False, "Enable 3CX collector"),
    _d("threecx.url", "str", "", "Base URL"),
    _d("threecx.client_id", "str", "", "OAuth client id"),
    _d("threecx.client_secret", "secret", "", "OAuth client secret", "Write-only."),
    _d("threecx.verify_ssl", "bool", True, "Verify TLS certificate"),
    _d("threecx.interval_s", "int", 120, "Poll interval (s)", min=30),

    _d("rconfig.enabled", "bool", False, "Enable rConfig collector"),
    _d("rconfig.url", "str", "", "Base URL"),
    _d("rconfig.api_token", "secret", "", "API token", "Write-only."),
    _d("rconfig.verify_ssl", "bool", True, "Verify TLS certificate"),
    _d("rconfig.interval_s", "int", 600, "Poll interval (s)", min=60),
    _d("rconfig.stale_after_s", "int", 604800, "Backup stale after (s)", min=3600),
]

BY_KEY: dict[str, SettingDef] = {d.key: d for d in REGISTRY}


class SettingValueError(ValueError):
    """A value that fails a SettingDef's kind/bounds validation."""


def canonicalize(d: SettingDef, value: Any) -> str:
    """Validate ``value`` against ``d`` and return its canonical string form.

    :raises SettingValueError: with a human-readable reason.
    """
    if value is None:
        raise SettingValueError("value is required (use DELETE to clear an override)")
    if d.kind == "bool":
        if isinstance(value, bool):
            return "true" if value else "false"
        s = str(value).strip().lower()
        if s in ("1", "true", "yes", "on"):
            return "true"
        if s in ("0", "false", "no", "off"):
            return "false"
        raise SettingValueError(f"{d.key} expects true/false")
    if d.kind == "int":
        try:
            n = int(str(value).strip())
        except ValueError:
            raise SettingValueError(f"{d.key} expects an integer") from None
        if d.min is not None and n < d.min:
            raise SettingValueError(f"{d.key} must be >= {d.min}")
        if d.max is not None and n > d.max:
            raise SettingValueError(f"{d.key} must be <= {d.max}")
        return str(n)
    # str / secret
    s = str(value).strip()
    if d.kind == "secret" and not s:
        raise SettingValueError("secret value must be non-empty (use DELETE to clear)")
    return s


def parse(d: SettingDef, raw: str) -> Any:
    """Canonical string → native value (bool/int/str). Secrets stay str."""
    if d.kind == "bool":
        return _as_bool(raw)
    if d.kind == "int":
        return int(raw)
    return raw


def load_overrides(engine: Engine) -> dict[str, str | None]:
    """Raw ``app_settings`` rows keyed by setting key."""
    rows = db.fetch_all(engine, "SELECT `key`, value FROM app_settings")
    return {r["key"]: r["value"] for r in rows}


def resolve_overrides(
    overrides: dict[str, str | None], settings_key: str
) -> tuple[dict[str, Any], dict[str, str]]:
    """Parse/unseal raw override rows → (native values, per-key errors).

    Fail-soft (spec 12 S8): a row that no longer parses or decrypts is reported
    in the error map and skipped — the file value stays in effect.
    """
    values: dict[str, Any] = {}
    errors: dict[str, str] = {}
    for key, raw in overrides.items():
        d = BY_KEY.get(key)
        if d is None:
            errors[key] = "unknown setting (stale override row)"
            continue
        if raw is None:
            errors[key] = "override row has no value"
            continue
        try:
            if d.kind == "secret":
                values[key] = secretbox.open_token(settings_key, raw)
            else:
                values[key] = parse(d, canonicalize(d, raw))
        except (secretbox.SecretBoxError, SettingValueError) as exc:
            errors[key] = str(exc)
    return values, errors


def apply_overrides(base: Config, values: dict[str, Any]) -> Config:
    """Overlay resolved override values onto a file-loaded Config."""
    typed: dict[str, dict[str, Any]] = {s: {} for s in TYPED_SECTIONS}
    role_maps: dict[str, dict[str, set[str]]] = {}
    source_sets: dict[str, dict[str, str]] = {}

    for key, val in values.items():
        d = BY_KEY[key]
        if d.map_role is not None:
            map_attr, role = d.map_role
            m = role_maps.setdefault(map_attr, dict(getattr(base.auth, map_attr)))
            members = {v.strip() for v in str(val).split(",") if v.strip()}
            if members:
                m[role] = members
            else:
                m.pop(role, None)  # empty override clears the mapping
        elif d.attr is not None:
            typed[d.section][d.attr] = val
        else:
            # Source sections carry raw strings; collectors parse them.
            source_sets.setdefault(d.section, {})[d.name] = (
                canonicalize(d, val) if not isinstance(val, str) else val
            )

    cfg = base
    if typed["web"]:
        cfg = replace(cfg, web=replace(cfg.web, **typed["web"]))
    auth_fields = dict(typed["auth"])
    auth_fields.update(role_maps)
    if auth_fields:
        cfg = replace(cfg, auth=replace(cfg.auth, **auth_fields))
    if typed["poller"]:
        cfg = replace(cfg, poller=replace(cfg.poller, **typed["poller"]))
    if typed["snmp_inventory"]:
        cfg = replace(cfg, snmp_inventory=replace(cfg.snmp_inventory, **typed["snmp_inventory"]))
    if typed["engine"]:
        cfg = replace(cfg, engine=replace(cfg.engine, **typed["engine"]))

    if source_sets:
        sources = dict(cfg.sources)
        for name, updates in source_sets.items():
            current = sources.get(name) or SourceToggle(enabled=False)
            settings = dict(current.settings)
            settings.update(updates)
            sources[name] = SourceToggle(
                enabled=_as_bool(settings.get("enabled", "false")), settings=settings
            )
        cfg = replace(cfg, sources=sources)
    return cfg


def overlay_config(base: Config, engine: Engine) -> Config:
    """File config + DB overrides → effective Config. Never raises.

    Missing ``app_settings`` table (migration 008 not applied yet) or any bad
    row logs loud and degrades to the file config — a web edit must never turn
    into a boot failure (spec 12 S2/S8).
    """
    try:
        overrides = load_overrides(engine)
    except Exception as exc:
        log.warning("settings overlay unavailable (%s); using file config only", exc)
        return base
    if not overrides:
        return base
    values, errors = resolve_overrides(overrides, base.security.settings_key)
    for key, err in errors.items():
        log.error("settings override %s is unusable and was skipped: %s", key, err)
    cfg = apply_overrides(base, values)
    log.info("settings overlay applied: %d override(s)", len(values))
    return cfg


def file_value(base: Config, d: SettingDef) -> Any:
    """The value the conf file (or code default) provides for ``d``."""
    if d.map_role is not None:
        map_attr, role = d.map_role
        return ", ".join(sorted(getattr(base.auth, map_attr).get(role, set())))
    if d.attr is not None:
        section = getattr(base, d.section)
        return getattr(section, d.attr)
    src = base.sources.get(d.section)
    raw = (src.settings.get(d.name) if src else None)
    if raw is None:
        return d.default
    try:
        return parse(d, canonicalize(d, raw))
    except SettingValueError:
        return raw  # show the file's literal; the collector will complain loudly
