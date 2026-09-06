from netmon import db


def test_sqlite_engine_healthcheck(tmp_path):
    engine = db.make_engine(f"sqlite:///{tmp_path / 'h.db'}")
    assert db.healthcheck(engine) is True


def test_mariadb_driver_available():
    # Building a mysql+pymysql engine loads the dialect, which imports the
    # PyMySQL DBAPI — so this fails loudly if the approved driver is missing.
    # No connection is attempted.
    engine = db.make_engine("mysql+pymysql://u:p@localhost/netmon?charset=utf8mb4")
    assert engine.dialect.name == "mysql"
    assert engine.dialect.driver == "pymysql"


def test_healthcheck_false_on_bad_url():
    # Unreachable DB → healthcheck returns False rather than raising (fail loud
    # at the boundary, but /healthz stays answerable).
    engine = db.make_engine("sqlite:////nonexistent/dir/cannot/create.db")
    assert db.healthcheck(engine) is False


def test_decimal_columns_come_back_as_numbers(tmp_path):
    """MariaDB returns SUM() as Decimal, and FastAPI serialises a Decimal as a
    JSON *string*.

    Every SUM-based count therefore reached the browser quoted, where `+`
    concatenates rather than adds — a site with 1 camera down and 0 unreachable
    rendered "10" — and `"0"` being truthy tinted every tile as a failure.

    SQLite returns a plain int for SUM, so no query-level test on this backend
    can reproduce it, and `Decimal("1") == 1` means a value assertion passes on
    both backends. Hence a direct test of the conversion, and an assertion on
    the *type* rather than the value.
    """
    import json
    from decimal import Decimal

    from netmon.db import _plain

    row = _plain({"count": Decimal("7"), "gb": Decimal("12.5"),
                  "zero": Decimal("0"), "name": "x", "nothing": None})
    assert isinstance(row["count"], int) and row["count"] == 7
    assert isinstance(row["gb"], float) and row["gb"] == 12.5
    # Zero especially: as the string "0" it is truthy in JavaScript, which is
    # what turned "no cameras down" into a red tile.
    assert isinstance(row["zero"], int) and row["zero"] == 0
    assert row["name"] == "x" and row["nothing"] is None

    # The property that actually matters: no quotes once it is JSON.
    assert json.dumps(row) == '{"count": 7, "gb": 12.5, "zero": 0, "name": "x", "nothing": null}'
