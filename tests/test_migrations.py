from pathlib import Path

from sqlalchemy import text

from netmon import db
from netmon.migrate import (
    MIGRATIONS_DIR,
    apply_migrations,
    applied_versions,
    discover_migrations,
    main,
    parse_statements,
)
from tests.conftest import write_config

EXPECTED_TABLES = {
    "devices", "device_state", "state_events", "alert_rules", "alerts",
    "notifications", "maintenance_windows", "collector_health",
}


def test_001_present_and_has_all_tables():
    migs = discover_migrations()
    assert migs, "no migrations discovered"
    assert migs[0].version == "001"
    sql = migs[0].path.read_text()
    for table in EXPECTED_TABLES:
        assert f"CREATE TABLE IF NOT EXISTS {table}" in sql, f"missing table {table}"


def test_reserved_word_columns_are_quoted():
    # `condition` is a MariaDB reserved word; an unquoted column of that name is
    # a 1064 syntax error on MariaDB (SQLite accepts it, so tests alone miss it).
    import re
    sql = discover_migrations()[0].path.read_text()
    assert "`condition`" in sql, "alert_rules.condition must be backtick-quoted"
    assert re.search(r"(?m)^\s+condition\s+\w", sql) is None, "found an unquoted `condition` column"


def test_002_seeds_source_blind_rule():
    migs = {m.version: m for m in discover_migrations()}
    assert "002" in migs, "expected 002 seed migration"
    sql = migs["002"].path.read_text()
    assert "source_blind" in sql
    assert "`condition`" in sql  # reserved word stays quoted in the INSERT too


def test_004_creates_map_tables():
    migs = {m.version: m for m in discover_migrations()}
    assert "004" in migs, "expected 004 site-map migration"
    sql = migs["004"].path.read_text()
    for table in ("sites", "fiber_links", "fiber_link_state"):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in sql, f"missing table {table}"


def test_005_adds_foundation_tables_and_column():
    migs = {m.version: m for m in discover_migrations()}
    assert "005" in migs, "expected 005 design-port foundations migration"
    sql = migs["005"].path.read_text()
    for table in ("snapshot_cache", "config_backups"):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in sql, f"missing table {table}"
    assert "ADD COLUMN assigned_to" in sql
    # `key` is a MariaDB reserved word — must stay backtick-quoted.
    assert "`key`" in sql


def test_006_creates_switch_inventory_tables():
    migs = {m.version: m for m in discover_migrations()}
    assert "006" in migs, "expected 006 switch-inventory migration"
    sql = migs["006"].path.read_text()
    for table in ("switch_ports", "fdb_entries", "lldp_neighbors", "switch_vlans", "stack_members"):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in sql, f"missing table {table}"


def test_007_creates_sessions_table():
    migs = {m.version: m for m in discover_migrations()}
    assert "007" in migs, "expected 007 sessions migration"
    sql = migs["007"].path.read_text()
    assert "CREATE TABLE IF NOT EXISTS sessions" in sql
    # Only a digest of the cookie token may ever be at rest.
    assert "token_hash" in sql


def test_008_creates_settings_tables():
    migs = {m.version: m for m in discover_migrations()}
    assert "008" in migs, "expected 008 settings-engine migration"
    sql = migs["008"].path.read_text()
    for table in ("app_settings", "settings_audit"):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in sql, f"missing table {table}"
    # `key` is a MariaDB reserved word — must stay backtick-quoted.
    assert "`key`" in sql


def test_migration_versions_are_unique():
    # Two parallel branches once both claimed version 007 — the runner tracks
    # applied versions by this string, so a duplicate silently skips one file.
    versions = [m.version for m in discover_migrations()]
    assert len(versions) == len(set(versions)), f"duplicate migration version in {versions}"


def test_every_migration_has_rollback_note():
    for mig in discover_migrations():
        text_ = mig.path.read_text().lower()
        assert "rollback:" in text_, f"{mig.path.name} lacks a rollback note"


def test_every_statement_starts_with_a_sql_keyword():
    # The runner only strips lines that START with '--', then splits on ';'. A
    # ';' inside an INLINE comment therefore fractures a statement — the tail
    # becomes bogus SQL that fails on MariaDB (SQLite tests use hand-written DDL
    # so they'd miss it). Guard: every parsed statement must begin with DDL/DML.
    keywords = ("CREATE", "ALTER", "INSERT", "UPDATE", "DELETE", "DROP")
    for mig in discover_migrations():
        for stmt in parse_statements(mig.path.read_text()):
            assert stmt.upper().startswith(keywords), (
                f"{mig.path.name}: statement does not start with SQL "
                f"(a ';' inside an inline comment?): {stmt[:60]!r}"
            )


def test_parse_statements_strips_comments():
    stmts = parse_statements(
        "-- a comment\nCREATE TABLE a (id INT);\n-- another\nCREATE TABLE b (id INT);\n"
    )
    assert stmts == ["CREATE TABLE a (id INT)", "CREATE TABLE b (id INT)"]


def test_runner_applies_and_is_idempotent(tmp_path):
    # A SQLite-compatible throwaway migration exercises the runner's version
    # tracking without needing MariaDB.
    mdir = tmp_path / "migrations"
    mdir.mkdir()
    (mdir / "001_demo.sql").write_text(
        "-- rollback: DROP TABLE demo\nCREATE TABLE demo (id INTEGER);\n"
    )
    engine = db.make_engine(f"sqlite:///{tmp_path/'t.db'}")

    first = apply_migrations(engine, mdir)
    assert first == ["001"]
    assert applied_versions(engine) == {"001"}

    # Second run is a no-op.
    assert apply_migrations(engine, mdir) == []

    with engine.connect() as conn:
        # Table exists and is queryable.
        conn.execute(text("SELECT * FROM demo"))


def test_migrate_cli_friendly_error_on_unopenable_db(tmp_path, capsys):
    # A sqlite path in a nonexistent dir can't be opened → readable message,
    # exit 2, no raw traceback (mirrors the real deploy failure).
    conf = write_config(tmp_path, db_url="sqlite:////nonexistent/dir/netmon.db")
    rc = main(["--config", str(conf)])
    assert rc == 2
    err = capsys.readouterr().err
    assert "cannot open the database" in err
