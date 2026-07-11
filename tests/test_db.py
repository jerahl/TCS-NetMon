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
