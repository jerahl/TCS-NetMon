"""Shared test helpers.

Tests run against SQLite (no MariaDB / AD server needed in the sandbox). The
MariaDB migration SQL is asserted textually elsewhere; here we create the small
schema surface the API tests query using SQLite-compatible DDL.
"""

from __future__ import annotations

from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"

# SQLite-compatible subset of the `devices` table (columns the API reads).
DEVICES_DDL_SQLITE = """
CREATE TABLE devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    site TEXT,
    device_type TEXT NOT NULL DEFAULT 'other',
    mgmt_ip TEXT,
    snmp_capable INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    xiq_device_id TEXT,
    pf_node_mac TEXT,
    milestone_hardware_id TEXT,
    rconfig_device_id TEXT,
    threecx_ref TEXT
)
"""


DEVICE_STATE_DDL_SQLITE = """
CREATE TABLE device_state (
    device_id INTEGER NOT NULL,
    dimension TEXT NOT NULL,
    value TEXT,
    severity TEXT NOT NULL DEFAULT 'unknown',
    source TEXT NOT NULL,
    updated_at TIMESTAMP,
    PRIMARY KEY (device_id, dimension)
)
"""

STATE_EVENTS_DDL_SQLITE = """
CREATE TABLE state_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    dimension TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    severity TEXT NOT NULL DEFAULT 'unknown',
    source TEXT NOT NULL,
    occurred_at TIMESTAMP
)
"""

COLLECTOR_HEALTH_DDL_SQLITE = """
CREATE TABLE collector_health (
    name TEXT PRIMARY KEY,
    last_start TIMESTAMP,
    last_success TIMESTAMP,
    last_error TEXT,
    duration_ms INTEGER,
    records_written INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP
)
"""


ALERT_RULES_DDL_SQLITE = """
CREATE TABLE alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    dimension TEXT NOT NULL,
    `condition` TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warn',
    min_duration_s INTEGER NOT NULL DEFAULT 0,
    target TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
)
"""

ALERTS_DDL_SQLITE = """
CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    rule_id INTEGER NOT NULL,
    opened_at TIMESTAMP,
    last_seen_at TIMESTAMP,
    closed_at TIMESTAMP,
    acked_by TEXT,
    acked_at TIMESTAMP,
    assigned_to TEXT
)
"""

SNAPSHOT_CACHE_DDL_SQLITE = """
CREATE TABLE snapshot_cache (
    `key` TEXT PRIMARY KEY,
    payload TEXT,
    source TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP
)
"""

CONFIG_BACKUPS_DDL_SQLITE = """
CREATE TABLE config_backups (
    device_id INTEGER NOT NULL,
    taken_at TIMESTAMP NOT NULL,
    size_bytes INTEGER,
    hash TEXT,
    note TEXT,
    updated_at TIMESTAMP,
    PRIMARY KEY (device_id, taken_at)
)
"""

NOTIFICATIONS_DDL_SQLITE = """
CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id INTEGER NOT NULL,
    channel TEXT NOT NULL DEFAULT 'email',
    target TEXT,
    sent_at TIMESTAMP,
    shadow INTEGER NOT NULL DEFAULT 1,
    payload_summary TEXT
)
"""

MAINTENANCE_DDL_SQLITE = """
CREATE TABLE maintenance_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL,
    scope_value TEXT NOT NULL,
    starts_at TIMESTAMP NOT NULL,
    ends_at TIMESTAMP NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMP
)
"""


SITES_DDL_SQLITE = """
CREATE TABLE sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    display_name TEXT,
    tier TEXT NOT NULL DEFAULT 'other',
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
)
"""

FIBER_LINKS_DDL_SQLITE = """
CREATE TABLE fiber_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_a_id INTEGER NOT NULL,
    site_b_id INTEGER NOT NULL,
    capacity_gbps REAL NOT NULL DEFAULT 1.0,
    path TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE (site_a_id, site_b_id)
)
"""

FIBER_LINK_STATE_DDL_SQLITE = """
CREATE TABLE fiber_link_state (
    link_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'unknown',
    utilization_pct REAL,
    source TEXT NOT NULL,
    updated_at TIMESTAMP
)
"""


SWITCH_PORTS_DDL_SQLITE = """
CREATE TABLE switch_ports (
    device_id INTEGER NOT NULL,
    ifindex INTEGER NOT NULL,
    name TEXT,
    member INTEGER,
    oper_state TEXT NOT NULL DEFAULT 'unknown',
    admin_up INTEGER,
    speed_mbps INTEGER,
    duplex TEXT,
    poe_admin INTEGER,
    poe_delivering INTEGER,
    poe_class TEXT,
    poe_watts REAL,
    in_kbps INTEGER,
    out_kbps INTEGER,
    util_pct REAL,
    err_in_delta INTEGER,
    err_out_delta INTEGER,
    disc_in_delta INTEGER,
    disc_out_delta INTEGER,
    last_change TIMESTAMP,
    prev_counters TEXT,
    updated_at TIMESTAMP,
    PRIMARY KEY (device_id, ifindex)
)
"""

FDB_ENTRIES_DDL_SQLITE = """
CREATE TABLE fdb_entries (
    device_id INTEGER NOT NULL,
    mac TEXT NOT NULL,
    vlan_id INTEGER,
    ifindex INTEGER,
    first_seen TIMESTAMP,
    updated_at TIMESTAMP,
    PRIMARY KEY (device_id, mac)
)
"""

LLDP_NEIGHBORS_DDL_SQLITE = """
CREATE TABLE lldp_neighbors (
    device_id INTEGER NOT NULL,
    local_ifindex INTEGER NOT NULL,
    remote_sysname TEXT,
    remote_port TEXT,
    remote_sysdesc TEXT,
    remote_chassis TEXT,
    updated_at TIMESTAMP,
    PRIMARY KEY (device_id, local_ifindex)
)
"""

SWITCH_VLANS_DDL_SQLITE = """
CREATE TABLE switch_vlans (
    device_id INTEGER NOT NULL,
    vlan_id INTEGER NOT NULL,
    name TEXT,
    admin_up INTEGER,
    untagged_count INTEGER,
    tagged_count INTEGER,
    port_map TEXT,
    updated_at TIMESTAMP,
    PRIMARY KEY (device_id, vlan_id)
)
"""

STACK_MEMBERS_DDL_SQLITE = """
CREATE TABLE stack_members (
    device_id INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    role TEXT,
    status TEXT,
    serial TEXT,
    fw_version TEXT,
    uptime_s INTEGER,
    cpu_pct REAL,
    mem_pct REAL,
    temp_c REAL,
    fans TEXT,
    psus TEXT,
    warn_msg TEXT,
    updated_at TIMESTAMP,
    PRIMARY KEY (device_id, slot)
)
"""


APP_SETTINGS_DDL_SQLITE = """
CREATE TABLE app_settings (
    `key` TEXT PRIMARY KEY,
    value TEXT,
    is_secret INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMP
)
"""

SETTINGS_AUDIT_DDL_SQLITE = """
CREATE TABLE settings_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    `key` TEXT NOT NULL,
    action TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_by TEXT NOT NULL,
    changed_at TIMESTAMP
)
"""


def create_core_tables(engine) -> None:
    """Create the tables the poller / collectors / engine / API touch (SQLite)."""
    from sqlalchemy import text
    with engine.begin() as conn:
        for ddl in (
            DEVICES_DDL_SQLITE,
            DEVICE_STATE_DDL_SQLITE,
            STATE_EVENTS_DDL_SQLITE,
            COLLECTOR_HEALTH_DDL_SQLITE,
            ALERT_RULES_DDL_SQLITE,
            ALERTS_DDL_SQLITE,
            NOTIFICATIONS_DDL_SQLITE,
            MAINTENANCE_DDL_SQLITE,
            SNAPSHOT_CACHE_DDL_SQLITE,
            CONFIG_BACKUPS_DDL_SQLITE,
            SITES_DDL_SQLITE,
            FIBER_LINKS_DDL_SQLITE,
            FIBER_LINK_STATE_DDL_SQLITE,
            SWITCH_PORTS_DDL_SQLITE,
            FDB_ENTRIES_DDL_SQLITE,
            LLDP_NEIGHBORS_DDL_SQLITE,
            SWITCH_VLANS_DDL_SQLITE,
            STACK_MEMBERS_DDL_SQLITE,
            APP_SETTINGS_DDL_SQLITE,
            SETTINGS_AUDIT_DDL_SQLITE,
        ):
            conn.execute(text(ddl))


def write_config(tmp_path: Path, *, dev_bypass: bool = True, secure_cookies: bool = False,
                 db_url: str | None = None, extra_auth: str = "",
                 extra_sections: str = "") -> Path:
    """Write a minimal valid netmon.conf and return its path."""
    url = db_url or f"sqlite:///{tmp_path / 'netmon.db'}"
    auth_lines = []
    if dev_bypass:
        auth_lines += ["dev_bypass_user = devadmin", "dev_bypass_role = admin"]
    else:
        auth_lines += [
            "saml_idp_entity_id = https://idp.example/entity",
            "saml_idp_sso_url = https://idp.example/sso",
            "saml_idp_x509cert = MIIBdummycert",
            "saml_sp_entity_id = https://netmon.example/sp",
            "saml_sp_acs_url = https://netmon.example/auth/saml/acs",
        ]
    auth_lines.append(extra_auth)
    conf = tmp_path / "netmon.conf"
    conf.write_text(
        f"[db]\nurl = {url}\nauto_migrate = false\n\n"
        f"[web]\nsecure_cookies = {'true' if secure_cookies else 'false'}\n\n"
        f"[auth]\n" + "\n".join(l for l in auth_lines if l) + "\n"
        + (f"\n{extra_sections}\n" if extra_sections else "")
    )
    return conf


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES
