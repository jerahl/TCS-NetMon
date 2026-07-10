from pathlib import Path

from sqlalchemy import text

from netmon import db
from netmon.migrate import (
    MIGRATIONS_DIR,
    apply_migrations,
    applied_versions,
    discover_migrations,
    parse_statements,
)

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
