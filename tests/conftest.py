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


def create_core_tables(engine) -> None:
    """Create the Phase 1/2 tables the poller + status API touch (SQLite)."""
    from sqlalchemy import text
    with engine.begin() as conn:
        for ddl in (
            DEVICES_DDL_SQLITE,
            DEVICE_STATE_DDL_SQLITE,
            STATE_EVENTS_DDL_SQLITE,
            COLLECTOR_HEALTH_DDL_SQLITE,
        ):
            conn.execute(text(ddl))


def write_config(tmp_path: Path, *, dev_bypass: bool = True, secure_cookies: bool = False,
                 db_url: str | None = None, extra_auth: str = "") -> Path:
    """Write a minimal valid netmon.conf and return its path."""
    url = db_url or f"sqlite:///{tmp_path / 'netmon.db'}"
    auth_lines = []
    if dev_bypass:
        auth_lines += ["dev_bypass_user = devadmin", "dev_bypass_role = admin"]
    else:
        auth_lines += ["ldap_server = ldaps://dc.example.local",
                       "ldap_base_dn = DC=example,DC=local"]
    auth_lines.append(extra_auth)
    conf = tmp_path / "netmon.conf"
    conf.write_text(
        f"[db]\nurl = {url}\nauto_migrate = false\n\n"
        f"[web]\nsecure_cookies = {'true' if secure_cookies else 'false'}\n\n"
        f"[auth]\n" + "\n".join(l for l in auth_lines if l) + "\n"
    )
    return conf


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES
