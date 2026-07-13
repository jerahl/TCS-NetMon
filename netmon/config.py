"""Configuration load + validation.

Reads an INI file (stdlib ``configparser``) from ``/etc/netmon/netmon.conf``,
overridable with the ``NETMON_CONF`` environment variable. Validates the keys
the app cannot run without and fails loud — a missing secret is an error at
load time, never a silent default that limps along (CLAUDE.md §4.5).

Secrets live only in the on-disk file outside the repo (CLAUDE.md §4.6); the
repo carries ``netmon.conf.example`` only.
"""

from __future__ import annotations

import configparser
import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_CONF_PATH = "/etc/netmon/netmon.conf"
ENV_CONF_PATH = "NETMON_CONF"

# Role ordering — index is the privilege level. Used by require_role().
ROLES = ("viewer", "operator", "admin")


class ConfigError(Exception):
    """Raised on a missing/invalid configuration value. Fatal at startup."""


def _as_bool(value: str) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class DBConfig:
    url: str
    auto_migrate: bool = False


@dataclass(frozen=True)
class WebConfig:
    host: str = "127.0.0.1"
    port: int = 8080
    secure_cookies: bool = False
    session_ttl: int = 43200


@dataclass(frozen=True)
class AuthConfig:
    # SAML 2.0 Service Provider (ClassLink IdP). NetMon consumes the signed
    # assertion; no passwords, no directory bind.
    idp_entity_id: str = ""
    idp_sso_url: str = ""
    idp_x509cert: str = ""
    sp_entity_id: str = ""
    sp_acs_url: str = ""
    sp_slo_url: str = ""
    sp_cert: str = ""
    sp_key: str = ""
    # Assertion attribute names carrying the role claim and group ids.
    role_attr: str = "role"
    group_attr: str = "group_ids"
    # netmon role -> the claim values / group_ids that grant it.
    role_values: dict[str, set[str]] = field(default_factory=dict)
    group_values: dict[str, set[str]] = field(default_factory=dict)
    # Local development bypass (no IdP). Refused when secure_cookies=true.
    dev_bypass_user: str | None = None
    dev_bypass_role: str | None = None


@dataclass(frozen=True)
class PollerConfig:
    enabled: bool = False
    ping_interval_s: int = 60
    snmp_interval_s: int = 300
    fail_threshold: int = 3
    ok_threshold: int = 2
    fping_path: str = "fping"
    fping_timeout_ms: int = 500
    fping_retries: int = 1
    snmpget_path: str = "snmpget"
    snmp_version: str = "2c"
    snmp_community: str = ""  # secret; config file only
    snmp_timeout_s: int = 2
    snmp_retries: int = 1
    snmp_concurrency: int = 20


@dataclass(frozen=True)
class SourceToggle:
    """Generic per-source enable flag + opaque settings bag.

    Collectors read their own section; here we only surface ``enabled`` so the
    supervisor knows which tasks to start. Credentials stay in the raw section
    and are pulled by the collector, never logged.
    """

    enabled: bool
    settings: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Config:
    db: DBConfig
    web: WebConfig
    auth: AuthConfig
    poller: PollerConfig
    sources: dict[str, SourceToggle]
    path: str

    def source_enabled(self, name: str) -> bool:
        src = self.sources.get(name)
        return bool(src and src.enabled)


def _resolve_path(explicit: str | os.PathLike[str] | None) -> str:
    if explicit is not None:
        return str(explicit)
    return os.environ.get(ENV_CONF_PATH, DEFAULT_CONF_PATH)


def load_config(path: str | os.PathLike[str] | None = None) -> Config:
    """Load and validate the configuration.

    :raises ConfigError: when the file is missing or a required key is absent.
    """
    conf_path = _resolve_path(path)
    if not Path(conf_path).is_file():
        raise ConfigError(
            f"config file not found: {conf_path} "
            f"(set {ENV_CONF_PATH} or create {DEFAULT_CONF_PATH}; "
            f"see netmon.conf.example)"
        )

    parser = configparser.ConfigParser()
    # Preserve key case for group DNs etc.
    parser.optionxform = str  # type: ignore[assignment]
    read_ok = parser.read(conf_path)
    if not read_ok:
        raise ConfigError(f"config file could not be parsed: {conf_path}")

    # --- [db] (required) ---
    if not parser.has_section("db") or not parser.get("db", "url", fallback="").strip():
        raise ConfigError("[db] url is required")
    db = DBConfig(
        url=parser.get("db", "url").strip(),
        auto_migrate=_as_bool(parser.get("db", "auto_migrate", fallback="false")),
    )

    # --- [web] ---
    web = WebConfig(
        host=parser.get("web", "host", fallback="127.0.0.1").strip(),
        port=parser.getint("web", "port", fallback=8080),
        secure_cookies=_as_bool(parser.get("web", "secure_cookies", fallback="false")),
        session_ttl=parser.getint("web", "session_ttl", fallback=43200),
    )

    # --- [auth] — SAML SP (ClassLink) + dev bypass ---
    dev_user = parser.get("auth", "dev_bypass_user", fallback="").strip() or None
    dev_role = parser.get("auth", "dev_bypass_role", fallback="").strip() or None

    # Guard: the dev bypass must never be usable in a hardened (production)
    # deployment. secure_cookies=true is the production signal.
    if dev_user and web.secure_cookies:
        raise ConfigError(
            "[auth] dev_bypass_user is set while [web] secure_cookies=true — "
            "the dev auth bypass is refused in production. Remove the bypass "
            "or set secure_cookies=false for local development."
        )
    if dev_role and dev_role not in ROLES:
        raise ConfigError(
            f"[auth] dev_bypass_role={dev_role!r} is not one of {ROLES}"
        )

    def _csv_set(key: str) -> set[str]:
        raw = parser.get("auth", key, fallback="").strip()
        return {v.strip() for v in raw.split(",") if v.strip()}

    role_values: dict[str, set[str]] = {}
    group_values: dict[str, set[str]] = {}
    for role in ROLES:
        rv = _csv_set(f"saml_role_{role}")
        gv = _csv_set(f"saml_group_{role}")
        if rv:
            role_values[role] = rv
        if gv:
            group_values[role] = gv

    auth = AuthConfig(
        idp_entity_id=parser.get("auth", "saml_idp_entity_id", fallback="").strip(),
        idp_sso_url=parser.get("auth", "saml_idp_sso_url", fallback="").strip(),
        idp_x509cert=parser.get("auth", "saml_idp_x509cert", fallback="").strip(),
        sp_entity_id=parser.get("auth", "saml_sp_entity_id", fallback="").strip(),
        sp_acs_url=parser.get("auth", "saml_sp_acs_url", fallback="").strip(),
        sp_slo_url=parser.get("auth", "saml_sp_slo_url", fallback="").strip(),
        sp_cert=parser.get("auth", "saml_sp_cert", fallback="").strip(),
        sp_key=parser.get("auth", "saml_sp_key", fallback="").strip(),
        role_attr=parser.get("auth", "saml_role_attr", fallback="role").strip(),
        group_attr=parser.get("auth", "saml_group_attr", fallback="group_ids").strip(),
        role_values=role_values,
        group_values=group_values,
        dev_bypass_user=dev_user,
        dev_bypass_role=dev_role,
    )

    # Without the dev bypass, the SAML IdP settings are required to authenticate.
    if not auth.dev_bypass_user and not (
        auth.idp_entity_id and auth.idp_sso_url and auth.idp_x509cert
        and auth.sp_entity_id and auth.sp_acs_url
    ):
        raise ConfigError(
            "[auth] SAML IdP settings are required (saml_idp_entity_id, "
            "saml_idp_sso_url, saml_idp_x509cert, saml_sp_entity_id, "
            "saml_sp_acs_url) — or set dev_bypass_user for local development."
        )

    # --- [poller] ---
    def _pint(key: str, default: int) -> int:
        return parser.getint("poller", key, fallback=default)

    poller = PollerConfig(
        enabled=_as_bool(parser.get("poller", "enabled", fallback="false")),
        ping_interval_s=_pint("ping_interval_s", 60),
        snmp_interval_s=_pint("snmp_interval_s", 300),
        fail_threshold=_pint("fail_threshold", 3),
        ok_threshold=_pint("ok_threshold", 2),
        fping_path=parser.get("poller", "fping_path", fallback="fping").strip(),
        fping_timeout_ms=_pint("fping_timeout_ms", 500),
        fping_retries=_pint("fping_retries", 1),
        snmpget_path=parser.get("poller", "snmpget_path", fallback="snmpget").strip(),
        snmp_version=parser.get("poller", "snmp_version", fallback="2c").strip(),
        snmp_community=parser.get("poller", "snmp_community", fallback="").strip(),
        snmp_timeout_s=_pint("snmp_timeout_s", 2),
        snmp_retries=_pint("snmp_retries", 1),
        snmp_concurrency=_pint("snmp_concurrency", 20),
    )
    if poller.enabled and poller.fail_threshold < 1:
        raise ConfigError("[poller] fail_threshold must be >= 1")
    if poller.enabled and poller.ok_threshold < 1:
        raise ConfigError("[poller] ok_threshold must be >= 1")

    # --- per-source toggles ---
    sources: dict[str, SourceToggle] = {}
    for name in ("xiq", "packetfence", "milestone", "threecx", "rconfig"):
        if parser.has_section(name):
            settings = {k: v for k, v in parser.items(name)}
            sources[name] = SourceToggle(
                enabled=_as_bool(settings.get("enabled", "false")),
                settings=settings,
            )
        else:
            sources[name] = SourceToggle(enabled=False)

    return Config(db=db, web=web, auth=auth, poller=poller, sources=sources, path=conf_path)
