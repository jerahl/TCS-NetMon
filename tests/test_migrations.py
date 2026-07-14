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


def test_every_migration_has_rollback_note():
    for mig in discover_migrations():
        text_ = mig.path.read_text().lower()
        assert "rollback:" in text_, f"{mig.path.name} lacks a rollback note"


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
