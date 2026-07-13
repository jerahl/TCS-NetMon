"""Migration runner — plain numbered SQL files, no Alembic (CLAUDE.md §3).

Applies ``migrations/NNN_*.sql`` in order, recording applied versions in a
``schema_migrations`` table so re-running is idempotent. Runnable as
``python -m netmon.migrate`` or via the ``netmon-migrate`` entry point.

The SQL files are MariaDB-flavored. The runner itself is engine-agnostic; it
splits a file into statements and executes them in one transaction per file.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, SQLAlchemyError

from netmon import db
from netmon.config import load_config

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
_VERSION_RE = re.compile(r"^(\d+)_.*\.sql$")


@dataclass(frozen=True)
class Migration:
    version: str
    path: Path


def discover_migrations(directory: Path = MIGRATIONS_DIR) -> list[Migration]:
    """Return migrations sorted by numeric version prefix."""
    found: list[Migration] = []
    for entry in sorted(directory.glob("*.sql")):
        m = _VERSION_RE.match(entry.name)
        if m:
            found.append(Migration(version=m.group(1), path=entry))
    return sorted(found, key=lambda mig: int(mig.version))


def parse_statements(sql: str) -> list[str]:
    """Strip line comments/blank lines and split into individual statements.

    Migration SQL uses ``;`` only as a statement terminator (no stored
    procedures / triggers in this project), so a simple split is safe.
    """
    lines: list[str] = []
    for raw in sql.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("--"):
            continue
        lines.append(raw)
    body = "\n".join(lines)
    return [stmt.strip() for stmt in body.split(";") if stmt.strip()]


def _ensure_table(engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "  version VARCHAR(32) NOT NULL PRIMARY KEY,"
                "  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"
                ")"
            )
        )


def applied_versions(engine: Engine) -> set[str]:
    _ensure_table(engine)
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT version FROM schema_migrations"))
        return {r[0] for r in rows}


def apply_migrations(engine: Engine, directory: Path = MIGRATIONS_DIR) -> list[str]:
    """Apply all pending migrations. Returns the versions applied this run."""
    _ensure_table(engine)
    already = applied_versions(engine)
    newly_applied: list[str] = []
    for mig in discover_migrations(directory):
        if mig.version in already:
            continue
        statements = parse_statements(mig.path.read_text())
        with engine.begin() as conn:
            for stmt in statements:
                conn.execute(text(stmt))
            conn.execute(
                text("INSERT INTO schema_migrations (version) VALUES (:v)"),
                {"v": mig.version},
            )
        newly_applied.append(mig.version)
    return newly_applied


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Apply NetMon DB migrations.")
    parser.add_argument("--config", help="path to netmon.conf", default=None)
    parser.add_argument(
        "--status", action="store_true", help="show applied/pending and exit"
    )
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)

    try:
        if args.status:
            done = applied_versions(engine)
            for mig in discover_migrations():
                mark = "applied" if mig.version in done else "pending"
                print(f"  {mig.version}  {mig.path.name:32} [{mark}]")
            return 0

        applied = apply_migrations(engine)
    except OperationalError as exc:
        # Connection-class failure. Fail loud, but readable — not a 60-line
        # SQLAlchemy traceback.
        print(
            f"error: cannot open the database at the configured [db] url "
            f"(from {cfg.path}).\n"
            f"  {exc.orig}\n"
            f"  * SQLite: use an ABSOLUTE path in a directory the service user "
            f"can write, e.g. sqlite:////var/lib/netmon/netmon.db\n"
            f"  * MariaDB: check host/credentials/reachability, e.g. "
            f"mysql+pymysql://user:pass@host/netmon?charset=utf8mb4",
            file=sys.stderr,
        )
        return 2
    except SQLAlchemyError as exc:
        # A statement failed (e.g. bad DDL). Show the DB message + offending
        # SQL (SQLAlchemy embeds it) without the Python traceback. Migrations
        # use CREATE TABLE IF NOT EXISTS, so a fixed migration can be re-run
        # safely — already-created tables are skipped.
        print(f"error: migration failed.\n  {exc}", file=sys.stderr)
        return 3

    if applied:
        print(f"applied migrations: {', '.join(applied)}")
    else:
        print("no pending migrations")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
