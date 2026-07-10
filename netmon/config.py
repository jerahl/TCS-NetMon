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
    ldap_server: str = ""
    ldap_base_dn: str = ""
    ldap_user_dn_template: str = "{username}"
    # role name -> AD group DN
    group_map: dict[str, str] = field(default_factory=dict)
    dev_bypass_user: str | None = None
    dev_bypass_role: str | None = None


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

    # --- [auth] ---
    group_map: dict[str, str] = {}
    for role in ROLES:
        dn = parser.get("auth", f"group_{role}", fallback="").strip()
        if dn:
            group_map[role] = dn

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

    auth = AuthConfig(
        ldap_server=parser.get("auth", "ldap_server", fallback="").strip(),
        ldap_base_dn=parser.get("auth", "ldap_base_dn", fallback="").strip(),
        ldap_user_dn_template=parser.get(
            "auth", "ldap_user_dn_template", fallback="{username}"
        ).strip(),
        group_map=group_map,
        dev_bypass_user=dev_user,
        dev_bypass_role=dev_role,
    )

    # Without the dev bypass, an AD server is required to authenticate anyone.
    if not auth.dev_bypass_user and not auth.ldap_server:
        raise ConfigError(
            "[auth] ldap_server is required (or set dev_bypass_user for local "
            "development)"
        )

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

    return Config(db=db, web=web, auth=auth, sources=sources, path=conf_path)
