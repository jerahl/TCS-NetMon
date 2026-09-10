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
    # Base URL of the retained Zabbix UI. Feeds the nav deep-links for the
    # domains Zabbix keeps (Servers; FortiGate until 11.x) — spec 11 D1/D2.
    # Empty → the nav renders those entries disabled.
    zabbix_url: str = ""
    # Base URL of the SSHEASY web SSH client (jerahl/ssheasy), embedded in an
    # iframe from device detail pages. Empty → the "SSH" affordance is hidden.
    # NetMon only builds a target URL (host/port); it never handles credentials
    # (ssheasy prompts for them in-terminal) — read-only-first still holds.
    ssheasy_url: str = ""
    # CARTO Basemaps API key for the site map's raster tiles. Without it CARTO
    # stamps every tile "API KEY REQUIRED" — which on the one page ZCD has no
    # answer to is the first thing a visitor sees.
    #
    # It is a credential, so it lives here and reaches the browser through
    # /api/meta, never through the repo (§4.6). It is *also* unavoidably visible
    # in the browser's network tab, because it is a query parameter on a tile
    # URL — that is how the service is designed. Keeping it out of git still
    # matters: a committed key is in history and indexed forever, and this key
    # carries a 5,000,000-tile monthly quota and a no-sharing term.
    #
    # Empty → the map still works, watermarked, rather than losing its basemap.
    carto_api_key: str = ""
    # Base URL of the PacketFence *admin UI*, for deep-linking an endpoint:
    # <packetfence_url>/admin/#/node/<mac> (the shape ZCD uses —
    # ActionSearchData.php:287). This is deliberately NOT reused from
    # [packetfence] url: that one is the REST API base, which on a normal PF
    # deployment is a different port, and guessing wrong would produce links
    # that 404 for every operator. Empty → the affordance is hidden.
    packetfence_url: str = ""


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
    # Diagnostic: when true, the ACS endpoint renders the received assertion's
    # attributes (names/values) + the role-mapping verdict instead of logging
    # the user in. Lets an admin discover what ClassLink actually releases so
    # the saml_role_*/saml_group_* maps can be filled in. Default off; the app
    # logs a loud warning at startup while it is enabled. No session is issued
    # in this mode, so it cannot be a login backdoor.
    saml_debug: bool = False
    # Break-glass local account (works with no IdP / network). Password is a
    # PBKDF2 hash (never plaintext). Distinct from the dev bypass.
    local_user: str = ""
    local_password_hash: str = ""
    local_role: str = "admin"
    # Local development bypass (no IdP). Refused when secure_cookies=true.
    dev_bypass_user: str | None = None
    dev_bypass_role: str | None = None


@dataclass(frozen=True)
class SecurityConfig:
    """Settings-engine controls (spec 12). File-only — never web-editable.

    ``settings_key`` seals write-only secrets stored in ``app_settings``
    (netmon/secretbox.py). ``allow_web_edit`` gates the entire settings write
    path; reads (with secrets masked) work for admins regardless.
    """

    settings_key: str = ""
    allow_web_edit: bool = False


@dataclass(frozen=True)
class PollerConfig:
    enabled: bool = False
    # Run the sweeps as in-process supervised tasks. Set false when a separate
    # unit (netmon-poller.service) owns them instead: fping needs CAP_NET_RAW,
    # which the hardened web unit deliberately does not grant. `enabled` still
    # describes whether the poller runs *at all* — so /api/health stays honest
    # either way. File-only and absent from the settings registry on purpose:
    # flipping it from the web could stop all polling with no unit to take over.
    in_process: bool = True
    ping_interval_s: int = 60
    snmp_interval_s: int = 300
    fail_threshold: int = 3
    ok_threshold: int = 2
    fping_path: str = "fping"
    fping_timeout_ms: int = 500
    fping_retries: int = 1
    # Device types excluded from the ICMP sweep. Empty by default: cameras were
    # excluded while `device_down` could misread their silence as an outage, and
    # migration 023 scopes that rule instead, so the sweep can now record the
    # fact without the engine drawing the wrong conclusion from it. M1
    # (OpenProject #92) wants exactly that — "the disagreement worth surfacing,
    # not hiding". Kept as an escape hatch for a device class that should never
    # be probed.
    ping_exclude_device_types: tuple[str, ...] = ()
    snmpget_path: str = "snmpget"
    snmp_version: str = "2c"
    snmp_community: str = ""  # secret; config file only
    snmp_timeout_s: int = 2
    snmp_retries: int = 1
    snmp_concurrency: int = 20


@dataclass(frozen=True)
class SnmpInventoryConfig:
    """Read-only SNMP inventory sweeps (spec 10 §4; §1 charter amendment,
    owner-approved 2026-07-15). Reuses the [poller] SNMP credentials/version;
    this section only carries the sweep cadence, concurrency, and toggles.
    """

    enabled: bool = False
    snmpbulkwalk_path: str = "snmpbulkwalk"
    concurrency: int = 8  # switches in flight
    # Skip switches the native poller currently reports as not answering SNMP.
    # They cost a full timeout per OID root and return nothing (docs/design/109
    # measured 361s a pass on two such hosts); their rows go honestly stale
    # instead. Set false to sweep every registered switch regardless.
    skip_snmp_down: bool = True
    # Hard budget for ONE supervised run (all due sweeps across the fleet).
    # Deliberately decoupled from the sweep intervals: a run that overruns the
    # fastest interval just delays the next tick (cadence slips honestly); it
    # is only cancelled when it exceeds this budget.
    run_timeout_s: int = 900
    # per-sweep enable + interval (seconds)
    sweep_ports: bool = True
    ports_interval_s: int = 120
    sweep_poe: bool = True
    poe_interval_s: int = 300
    sweep_fdb: bool = True
    fdb_interval_s: int = 900
    sweep_edp: bool = True       # EXTREME-EDP-MIB neighbors (was LLDP)
    edp_interval_s: int = 1800
    sweep_vlans: bool = True
    vlans_interval_s: int = 3600
    sweep_stack: bool = True
    stack_interval_s: int = 300
    sweep_entity: bool = True
    entity_interval_s: int = 3600


@dataclass(frozen=True)
class EngineConfig:
    enabled: bool = False
    interval_s: int = 30
    shadow: bool = True  # log would-be notifications, send nothing
    smtp_host: str = ""
    smtp_port: int = 25
    smtp_from: str = ""
    default_target: str = ""


@dataclass(frozen=True)
class CameraSnapshotConfig:
    """Camera still-image proxy (spec 11 D7, approved 2026-07-28).

    A credentialed GET to the camera, streamed back same-origin, because
    browsers strip embedded credentials from `<img>` subrequests — so the
    picture cannot be fetched directly and the camera login must never reach
    the browser.

    Default **off**: it needs a shared read-only camera account provisioned in
    `/etc/netmon/netmon.conf`, and it is the one place NetMon talks to a device
    at page-render time rather than serving its own database. That relaxation of
    the zero-source-calls-at-render invariant (CLAUDE.md §6) is deliberate and
    bounded — `max_concurrent` caps it, `cache_s` lets the browser stop asking,
    and turning `enabled` off returns the pages to DB-only with no deploy.

    `channel_param` is empty by design. 178 cameras on this estate are one
    imager of several on a shared device, and a bare snapshot path on such a
    device returns a *different imager's* picture. The parameter name differs by
    vendor and firmware, so those cameras report "not configured" until someone
    confirms it against a real device — a wrong guess would serve a plausible
    image of the wrong place, which nobody would notice.

    `password_backup` (`pass_backup` in the file) is a second password for the
    *same* account, tried only after the camera answers 401 to the first. A
    fleet of 2,651 cameras is not on one password: a rotation reaches the
    cameras that were online for it, and the ones that were down, or were
    installed before it, still answer to the previous one. Without a fallback
    those tiles read "camera rejected the configured account" and someone has
    to decide, per camera, which password it is on. Optional, and empty means
    one credential is tried exactly as before.
    """
    enabled: bool = False
    user: str = ""
    password: str = ""
    password_backup: str = ""
    # Cameras on the VMS network carry self-signed certificates, so verification
    # is off by default. Named rather than hidden: it is a real trade-off, and
    # the traffic stays inside the management network.
    verify_ssl: bool = False
    connect_timeout_s: float = 3.0
    timeout_s: float = 6.0
    # A camera wall asks for up to 48 stills at once. Without a cap that is 48
    # simultaneous connections from the monitoring host to the camera VLAN.
    max_concurrent: int = 8
    # Browser cache lifetime. Short, because a still is only interesting when
    # it is current, but non-zero so a re-render does not re-fetch every tile.
    cache_s: int = 5
    # Vendor query parameter that selects the imager on a multi-camera device.
    channel_param: str = ""


@dataclass(frozen=True)
class ActionsConfig:
    """Operator write actions (spec 11 D4, approved 2026-07-28).

    The only place NetMon issues a non-GET to a source. Each action has its own
    flag so any one can be switched off without a deploy (§4.3 per-step
    reversibility) — that property is why the flags exist even though the owner
    chose to ship them enabled.

    **Owner deviation, 2026-07-29:** D4's signed design specified default-off
    with a dry-run first (§4.2). The owner chose "live on merge", so these
    default true. `enabled` is the master switch: false disables all four
    regardless of the individual flags.
    """
    enabled: bool = True
    reevaluate_access: bool = True
    restart_port: bool = True
    poe_cycle: bool = True
    ap_reboot: bool = True
    # rConfig snippet that performs the PoE bounce. Confirmed live as id 4
    # ("Cycle POE") on this deployment. NetMon never sends CLI text — only this
    # id plus variable substitutions — so the commands stay reviewable in
    # rConfig and the blast radius is whatever the snippet does.
    poe_snippet_id: int = 4
    # Minimum role. viewer < operator < admin; the owner chose operator.
    min_role: str = "operator"


@dataclass(frozen=True)
class HistoryConfig:
    """Bounded 24 h history ring buffer (spec 10.6; CLAUDE.md §2 exception,
    owner-approved 2026-07-15 as spec 10 §10 Q3 / spec 11 D3).

    The sampler task snapshots a curated set of low-cardinality aggregate series
    (fleet counts, alert counts, VoIP channels, wireless clients, PoE watts, and
    per-switch throughput/ports-up) into ``state_samples`` on ``interval_s`` and
    prunes anything older than ``retention_hours`` — hard-capped at 24 so the
    charter exception can never drift into long-term storage.
    """

    enabled: bool = False
    interval_s: int = 300
    retention_hours: int = 24


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
class CameraOpsConfig:
    """Bulk camera operations (spec 20 S8, gate D11 approved in principle).

    The first NetMon write that goes **straight to hardware** rather than
    through a platform that validates it, so the defaults are the most cautious
    in the file: everything off, dry-run on, and the two operations gated
    separately.

    The account is deliberately NOT the snapshot proxy's. `[camera_snapshot]`
    documents its credential as read-only and says the account "must not be able
    to change camera configuration" — which is exactly right, and exactly why it
    cannot push firmware. Reusing it would either fail every write or quietly
    mean the read-only account was never read-only.
    """
    enabled: bool = False
    dry_run: bool = True
    #: Per-operation, because they carry different risk. The setting catalogue
    #: is deferred (owner, 2026-09-07) so `config_change` has nothing to run yet.
    config_change: bool = False
    firmware_update: bool = False
    #: Ask Milestone to re-detect a camera after a verified flash, so the VMS
    #: stops reporting the pre-flash version. NetMon's only write to Milestone,
    #: so it is off until deliberately enabled (§4.2) — and it has never been
    #: executed against a live VMS, only fixture-tested (spec 19).
    milestone_refresh: bool = False
    #: The privileged camera account. Empty until the owner provisions one.
    user: str = ""
    password: str = ""
    #: Reuse `[camera_snapshot]`'s account instead of a separate one
    #: (owner-directed 2026-09-08). Off by default and deliberately explicit:
    #: that section documents its credential as read-only, so borrowing it for
    #: writes has to be a decision somebody typed, not a fallback that happens
    #: quietly. On this estate the snapshot account is `service`, which on Bosch
    #: hardware is the privileged level — so the "read-only" note describes an
    #: intention, not an enforced limit.
    use_snapshot_credentials: bool = False
    #: While set, pre-flight refuses **every camera except this device id**.
    #: The proving ground the owner chose (2026-09-08) instead of a low-stakes
    #: setting catalogue, expressed in code rather than in someone's memory: it
    #: cannot be forgotten at 22:00 on the night of the first real batch.
    proving_device_id: int = 0
    #: Vetted images live here, one directory per vendor. Outside the repo for
    #: the same reason credentials are.
    firmware_dir: str = "/var/lib/netmon/firmware"
    #: The ring discipline. Copied onto each batch at creation so a later config
    #: edit cannot change the rules a running batch plays by.
    canary_count: int = 1
    ring_size: int = 10
    max_concurrent: int = 3
    max_batch: int = 50
    abort_pct: int = 10
    reboot_timeout_s: int = 300
    connect_timeout_s: float = 5.0
    timeout_s: float = 120.0
    verify_ssl: bool = False


@dataclass(frozen=True)
class Config:
    db: DBConfig
    web: WebConfig
    auth: AuthConfig
    security: SecurityConfig
    poller: PollerConfig
    snmp_inventory: SnmpInventoryConfig
    engine: EngineConfig
    history: HistoryConfig
    actions: ActionsConfig
    camera_snapshot: CameraSnapshotConfig
    camera_ops: CameraOpsConfig
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

    # `interpolation=None`: this file is mostly secrets, and configparser's
    # default BasicInterpolation rewrites them. A `%` is not a literal to it —
    # `%%` collapses to one `%` and a lone `%` raises — so a camera password
    # containing `%%` was silently delivered a character short and every
    # snapshot came back "camera rejected both configured passwords" (found on
    # alb-cam-100, 2026-09-08: the value in the file authenticated, the value
    # NetMon sent did not). No key here has ever wanted interpolation; a config
    # of credentials must hand back exactly what was typed.
    parser = configparser.ConfigParser(interpolation=None)
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
        zabbix_url=parser.get("web", "zabbix_url", fallback="").strip().rstrip("/"),
        ssheasy_url=parser.get("web", "ssheasy_url", fallback="").strip().rstrip("/"),
        carto_api_key=parser.get("web", "carto_api_key", fallback="").strip(),
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

    local_role = parser.get("auth", "local_role", fallback="admin").strip()
    if local_role not in ROLES:
        raise ConfigError(f"[auth] local_role={local_role!r} is not one of {ROLES}")

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
        saml_debug=_as_bool(parser.get("auth", "saml_debug", fallback="false")),
        local_user=parser.get("auth", "local_user", fallback="").strip(),
        local_password_hash=parser.get("auth", "local_password_hash", fallback="").strip(),
        local_role=local_role,
        dev_bypass_user=dev_user,
        dev_bypass_role=dev_role,
    )

    # At least one auth method must be usable: the dev bypass, SAML SSO, or the
    # break-glass local account.
    saml_ok = bool(
        auth.idp_entity_id and auth.idp_sso_url and auth.idp_x509cert
        and auth.sp_entity_id and auth.sp_acs_url
    )
    local_ok = bool(auth.local_user and auth.local_password_hash)
    if not (auth.dev_bypass_user or saml_ok or local_ok):
        raise ConfigError(
            "[auth] no auth method configured — set the SAML IdP settings "
            "(saml_idp_*/saml_sp_*), a break-glass local_user + "
            "local_password_hash, or dev_bypass_user for local development."
        )

    # --- [security] — settings engine (spec 12); file-only by design ---
    settings_key = parser.get("security", "settings_key", fallback="").strip()
    if settings_key and len(settings_key) < 32:
        raise ConfigError(
            "[security] settings_key is too short (need >= 32 chars); generate "
            "one with: python -c \"import secrets; print(secrets.token_hex(32))\""
        )
    security = SecurityConfig(
        settings_key=settings_key,
        allow_web_edit=_as_bool(parser.get("security", "allow_web_edit", fallback="false")),
    )

    # --- [poller] ---
    def _pint(key: str, default: int) -> int:
        return parser.getint("poller", key, fallback=default)

    poller = PollerConfig(
        enabled=_as_bool(parser.get("poller", "enabled", fallback="false")),
        in_process=_as_bool(parser.get("poller", "in_process", fallback="true")),
        ping_interval_s=_pint("ping_interval_s", 60),
        snmp_interval_s=_pint("snmp_interval_s", 300),
        fail_threshold=_pint("fail_threshold", 3),
        ok_threshold=_pint("ok_threshold", 2),
        fping_path=parser.get("poller", "fping_path", fallback="fping").strip(),
        fping_timeout_ms=_pint("fping_timeout_ms", 500),
        fping_retries=_pint("fping_retries", 1),
        ping_exclude_device_types=tuple(
            t.strip() for t in parser.get(
                "poller", "ping_exclude_device_types", fallback="").split(",")
            if t.strip()),
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

    # --- [snmp_inventory] (spec 10 §4) ---
    def _sint(key: str, default: int) -> int:
        return parser.getint("snmp_inventory", key, fallback=default)

    def _sbool(key: str, default: bool) -> bool:
        return _as_bool(parser.get("snmp_inventory", key, fallback=str(default)))

    snmp_inventory = SnmpInventoryConfig(
        enabled=_sbool("enabled", False),
        snmpbulkwalk_path=parser.get("snmp_inventory", "snmpbulkwalk_path", fallback="snmpbulkwalk").strip(),
        concurrency=_sint("concurrency", 8),
        skip_snmp_down=_sbool("skip_snmp_down", True),
        run_timeout_s=_sint("run_timeout_s", 900),
        sweep_ports=_sbool("sweep_ports", True),
        ports_interval_s=_sint("ports_interval_s", 120),
        sweep_poe=_sbool("sweep_poe", True),
        poe_interval_s=_sint("poe_interval_s", 300),
        sweep_fdb=_sbool("sweep_fdb", True),
        fdb_interval_s=_sint("fdb_interval_s", 900),
        sweep_edp=_sbool("sweep_edp", True),
        edp_interval_s=_sint("edp_interval_s", 1800),
        sweep_vlans=_sbool("sweep_vlans", True),
        vlans_interval_s=_sint("vlans_interval_s", 3600),
        sweep_stack=_sbool("sweep_stack", True),
        stack_interval_s=_sint("stack_interval_s", 300),
        sweep_entity=_sbool("sweep_entity", True),
        entity_interval_s=_sint("entity_interval_s", 3600),
    )
    if snmp_inventory.enabled and snmp_inventory.concurrency < 1:
        raise ConfigError("[snmp_inventory] concurrency must be >= 1")
    if snmp_inventory.enabled and snmp_inventory.run_timeout_s < 60:
        raise ConfigError("[snmp_inventory] run_timeout_s must be >= 60")

    # --- [engine] ---
    engine = EngineConfig(
        enabled=_as_bool(parser.get("engine", "enabled", fallback="false")),
        interval_s=parser.getint("engine", "interval_s", fallback=30),
        shadow=_as_bool(parser.get("engine", "shadow", fallback="true")),
        smtp_host=parser.get("engine", "smtp_host", fallback="").strip(),
        smtp_port=parser.getint("engine", "smtp_port", fallback=25),
        smtp_from=parser.get("engine", "smtp_from", fallback="").strip(),
        default_target=parser.get("engine", "default_target", fallback="").strip(),
    )

    # --- [history] (spec 10.6; bounded ≤24 h ring buffer) ---
    history = HistoryConfig(
        enabled=_as_bool(parser.get("history", "enabled", fallback="false")),
        interval_s=parser.getint("history", "interval_s", fallback=300),
        retention_hours=parser.getint("history", "retention_hours", fallback=24),
    )
    if history.enabled and history.interval_s < 30:
        raise ConfigError("[history] interval_s must be >= 30")
    if history.retention_hours < 1 or history.retention_hours > 24:
        # The charter exception is explicitly bounded at 24 h — refuse to let a
        # config typo turn the ring buffer into long-term series storage.
        raise ConfigError("[history] retention_hours must be between 1 and 24")

    # --- [actions] operator write actions (spec 11 D4) ---
    def _abool(key: str, default: bool = True) -> bool:
        return _as_bool(parser.get("actions", key, fallback="true" if default else "false"))

    camera_snapshot = CameraSnapshotConfig(
        enabled=_as_bool(parser.get("camera_snapshot", "enabled", fallback="false")),
        user=parser.get("camera_snapshot", "user", fallback="").strip(),
        password=parser.get("camera_snapshot", "pass", fallback=""),
        password_backup=parser.get("camera_snapshot", "pass_backup", fallback=""),
        verify_ssl=_as_bool(parser.get("camera_snapshot", "verify_ssl", fallback="false")),
        connect_timeout_s=parser.getfloat("camera_snapshot", "connect_timeout_s", fallback=3.0),
        timeout_s=parser.getfloat("camera_snapshot", "timeout_s", fallback=6.0),
        max_concurrent=parser.getint("camera_snapshot", "max_concurrent", fallback=8),
        cache_s=parser.getint("camera_snapshot", "cache_s", fallback=5),
        channel_param=parser.get("camera_snapshot", "channel_param", fallback="").strip(),
    )
    if camera_snapshot.enabled and not camera_snapshot.user:
        # Refuse rather than silently serve 503s: an operator who switched this
        # on and sees empty tiles should be told the account is missing.
        raise ConfigError("[camera_snapshot] enabled = true needs `user` (and `pass`) — "
                          "the shared read-only camera account")

    def _ops(key: str, default: str = "false") -> bool:
        return _as_bool(parser.get("camera_ops", key, fallback=default))

    camera_ops = CameraOpsConfig(
        enabled=_ops("enabled"),
        dry_run=_ops("dry_run", "true"),
        config_change=_ops("config_change"),
        firmware_update=_ops("firmware_update"),
        milestone_refresh=_ops("milestone_refresh"),
        user=parser.get("camera_ops", "user", fallback="").strip(),
        password=parser.get("camera_ops", "pass", fallback=""),
        use_snapshot_credentials=_ops("use_snapshot_credentials"),
        proving_device_id=parser.getint("camera_ops", "proving_device_id", fallback=0),
        firmware_dir=parser.get("camera_ops", "firmware_dir",
                                fallback="/var/lib/netmon/firmware").strip(),
        canary_count=parser.getint("camera_ops", "canary_count", fallback=1),
        ring_size=parser.getint("camera_ops", "ring_size", fallback=10),
        max_concurrent=parser.getint("camera_ops", "max_concurrent", fallback=3),
        max_batch=parser.getint("camera_ops", "max_batch", fallback=50),
        abort_pct=parser.getint("camera_ops", "abort_pct", fallback=10),
        reboot_timeout_s=parser.getint("camera_ops", "reboot_timeout_s", fallback=300),
        connect_timeout_s=parser.getfloat("camera_ops", "connect_timeout_s", fallback=5.0),
        timeout_s=parser.getfloat("camera_ops", "timeout_s", fallback=120.0),
        verify_ssl=_as_bool(parser.get("camera_ops", "verify_ssl", fallback="false")),
    )
    if camera_ops.use_snapshot_credentials and camera_ops.user:
        raise ConfigError("[camera_ops] sets both `user` and use_snapshot_credentials — "
                          "pick one, so it is unambiguous which account writes to a camera")
    if (camera_ops.enabled and not camera_ops.dry_run
            and camera_ops.use_snapshot_credentials and not camera_snapshot.user):
        raise ConfigError("[camera_ops] use_snapshot_credentials = true but "
                          "[camera_snapshot] has no account to borrow")
    if (camera_ops.enabled and not camera_ops.dry_run
            and not camera_ops.use_snapshot_credentials and not camera_ops.user):
        # Live and credential-less would refuse every camera at pre-flight and
        # look like a fleet-wide fault. Fail at boot where it is one line.
        raise ConfigError("[camera_ops] enabled with dry_run = false needs `user` and "
                          "`pass` — a privileged camera account, NOT the read-only "
                          "one in [camera_snapshot]")
    if camera_ops.canary_count < 1:
        raise ConfigError("[camera_ops] canary_count must be at least 1 — the canary "
                          "is what stops a bad image reaching the second camera")
    if camera_ops.max_batch < 1 or camera_ops.ring_size < 1:
        raise ConfigError("[camera_ops] max_batch and ring_size must be positive")
    if not 0 < camera_ops.abort_pct <= 100:
        raise ConfigError("[camera_ops] abort_pct must be between 1 and 100; 0 would "
                          "abort a batch on its first success")

    actions = ActionsConfig(
        enabled=_abool("enabled"),
        reevaluate_access=_abool("reevaluate_access"),
        restart_port=_abool("restart_port"),
        poe_cycle=_abool("poe_cycle"),
        ap_reboot=_abool("ap_reboot"),
        poe_snippet_id=parser.getint("actions", "poe_snippet_id", fallback=4),
        min_role=parser.get("actions", "min_role", fallback="operator").strip().lower(),
    )
    if actions.min_role not in ROLES:
        raise ConfigError(f"[actions] min_role must be one of {ROLES}, got {actions.min_role!r}")
    if actions.min_role == "viewer":
        # A read-only role must never be able to reboot an AP. Refuse rather
        # than silently harden, so a typo is visible at boot.
        raise ConfigError("[actions] min_role = viewer would let read-only users "
                          "issue write actions; use operator or admin")
    if actions.enabled and actions.poe_cycle and actions.poe_snippet_id <= 0:
        raise ConfigError("[actions] poe_cycle needs a positive poe_snippet_id "
                          "(the stored rConfig 'Cycle POE' snippet)")

    # --- per-source toggles ---
    sources: dict[str, SourceToggle] = {}
    for name in ("xiq", "packetfence", "milestone", "threecx", "rconfig", "micetro"):
        if parser.has_section(name):
            settings = {k: v for k, v in parser.items(name)}
            sources[name] = SourceToggle(
                enabled=_as_bool(settings.get("enabled", "false")),
                settings=settings,
            )
        else:
            sources[name] = SourceToggle(enabled=False)

    return Config(db=db, web=web, auth=auth, security=security, poller=poller,
                  snmp_inventory=snmp_inventory, engine=engine, history=history,
                  actions=actions, camera_snapshot=camera_snapshot,
                  camera_ops=camera_ops, sources=sources, path=conf_path)
