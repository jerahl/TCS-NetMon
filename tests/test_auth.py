import pytest
from fastapi import Response
from fastapi.testclient import TestClient

from netmon.api.auth_routes import complete_login
from netmon.app import create_app
from netmon.auth.local import check_local, hash_password, verify_password
from netmon.auth.saml import SamlError, role_from_attributes, sp_metadata
from netmon.auth.sessions import SessionStore
from netmon.config import AuthConfig, load_config
from netmon.models.schemas import Role
from netmon.supervisor import Supervisor
from tests.conftest import write_config


def _local_conf(tmp_path, password="s3cret"):
    conf = tmp_path / "netmon.conf"
    conf.write_text(
        f"[db]\nurl = sqlite:///{tmp_path/'x.db'}\n[web]\nsecure_cookies = false\n"
        f"[auth]\nlocal_user = netmon-admin\n"
        f"local_password_hash = {hash_password(password)}\nlocal_role = admin\n"
    )
    return conf


def _auth():
    return AuthConfig(
        role_attr="role",
        group_attr="group_ids",
        role_values={"admin": {"Administrator"}, "viewer": {"Staff"}},
        group_values={"operator": {"42"}},
    )


def test_role_from_attributes_picks_highest():
    cfg = _auth()
    # Staff (viewer) + group 42 (operator) → operator wins.
    assert role_from_attributes({"role": ["Staff"], "group_ids": ["42"]}, cfg) is Role.operator
    # Administrator role claim → admin.
    assert role_from_attributes({"role": ["Administrator"], "group_ids": ["1"]}, cfg) is Role.admin
    # Nothing mapped → None (denied).
    assert role_from_attributes({"role": ["Nobody"], "group_ids": ["999"]}, cfg) is None


def test_session_store_lifecycle():
    store = SessionStore(ttl_seconds=3600)
    token = store.create("alice", Role.operator, ["42"])
    sess = store.get(token)
    assert sess is not None and sess.username == "alice" and sess.role is Role.operator
    store.destroy(token)
    assert store.get(token) is None


def test_session_expiry():
    store = SessionStore(ttl_seconds=-1)
    assert store.get(store.create("bob", Role.viewer, [])) is None


def _db_store(tmp_path, ttl=3600):
    from netmon import db
    from netmon.auth.sessions import DbSessionStore
    from tests.conftest import create_core_tables

    engine = db.make_engine(f"sqlite:///{tmp_path/'sess.db'}")
    create_core_tables(engine)
    return DbSessionStore(engine, ttl_seconds=ttl), engine


def test_db_session_store_lifecycle(tmp_path):
    store, engine = _db_store(tmp_path)
    token = store.create("alice", Role.operator, ["42"])
    sess = store.get(token)
    assert sess is not None and sess.username == "alice" and sess.role is Role.operator
    assert sess.groups == ["42"]
    assert store.count() == 1

    # A second store over the same DB sees the session — this is the property
    # the in-memory store lacked (restart/multi-worker survival).
    from netmon.auth.sessions import DbSessionStore
    other = DbSessionStore(engine, ttl_seconds=3600)
    assert other.get(token) is not None

    store.destroy(token)
    assert store.get(token) is None
    assert store.count() == 0


def test_db_session_store_expiry_and_purge(tmp_path):
    store, engine = _db_store(tmp_path, ttl=-1)
    token = store.create("bob", Role.viewer, [])
    assert store.get(token) is None  # already expired
    assert store.count() == 0

    # purge_expired removes the dead rows outright.
    token2 = store.create("carol", Role.viewer, [])
    assert store.purge_expired() >= 1
    from netmon import db as _db
    n = _db.fetch_one(engine, "SELECT COUNT(*) AS n FROM sessions")["n"]
    assert n == 0, "expired rows must not accumulate"
    assert store.get(token2) is None


def test_db_session_store_never_stores_raw_token(tmp_path):
    store, engine = _db_store(tmp_path)
    token = store.create("alice", Role.admin, [])
    from netmon import db as _db
    rows = _db.fetch_all(engine, "SELECT token_hash FROM sessions")
    assert rows and all(r["token_hash"] != token for r in rows)
    assert all(len(r["token_hash"]) == 64 for r in rows)  # sha256 hex digest


def test_complete_login_maps_role_and_sets_cookie(tmp_path):
    cfg = load_config(write_config(tmp_path, dev_bypass=False, extra_auth="saml_role_admin = Administrator"))
    sessions = SessionStore(3600)
    resp = Response()
    role = complete_login({"role": ["Administrator"], "group_ids": ["9"]}, "alice@tcs", cfg, sessions, resp)
    assert role is Role.admin
    assert "netmon_session=" in resp.headers.get("set-cookie", "")


def test_complete_login_denies_unmapped_user(tmp_path):
    cfg = load_config(write_config(tmp_path, dev_bypass=False, extra_auth="saml_role_admin = Administrator"))
    with pytest.raises(SamlError):
        complete_login({"role": ["Guest"]}, "mallory", cfg, SessionStore(3600), Response())


def test_sp_metadata_generates_xml(tmp_path):
    # Exercises python3-saml wiring end-to-end (skips cleanly if not installed).
    pytest.importorskip("onelogin.saml2")
    cfg = load_config(write_config(tmp_path, dev_bypass=False))
    xml = sp_metadata(cfg.auth)
    assert "entityID" in xml
    assert "AssertionConsumerService" in xml


# --- break-glass local auth --------------------------------------------------

def test_local_password_hash_roundtrip():
    h = hash_password("hunter2")
    assert h.startswith("pbkdf2_sha256$")
    assert verify_password("hunter2", h) is True
    assert verify_password("wrong", h) is False
    assert verify_password("hunter2", "garbage") is False


def test_check_local():
    auth = AuthConfig(local_user="netmon-admin", local_password_hash=hash_password("s3cret"),
                      local_role="admin")
    assert check_local(auth, "netmon-admin", "s3cret") is Role.admin
    assert check_local(auth, "netmon-admin", "nope") is None
    assert check_local(auth, "someone-else", "s3cret") is None
    assert check_local(AuthConfig(), "x", "y") is None  # unconfigured


def test_local_only_config_is_valid(tmp_path):
    cfg = load_config(_local_conf(tmp_path))  # no SAML, no dev bypass → still valid
    assert cfg.auth.local_user == "netmon-admin"


def test_login_page_and_local_login_flow(tmp_path):
    app = create_app(config=load_config(_local_conf(tmp_path)), supervisor=Supervisor())
    with TestClient(app, follow_redirects=False) as client:
        page = client.get("/login")
        assert page.status_code == 200 and "Sign in (local)" in page.text

        bad = client.post("/auth/local", data={"username": "netmon-admin", "password": "nope"})
        assert bad.status_code == 303 and bad.headers["location"] == "/login?error=1"

        ok = client.post("/auth/local", data={"username": "netmon-admin", "password": "s3cret"})
        assert ok.status_code == 303 and ok.headers["location"] == "/ui/"
        # Cookie from the redirect authenticates subsequent requests.
        me = client.get("/auth/me")
        assert me.status_code == 200 and me.json()["role"] == "admin"


def test_login_page_always_shows_local_form(tmp_path):
    # SAML-configured (no local account): the page still shows the local form
    # (break-glass), and the "or" divider appears exactly once between methods.
    app = create_app(config=load_config(write_config(tmp_path, dev_bypass=False)),
                     supervisor=Supervisor())
    with TestClient(app, follow_redirects=False) as client:
        page = client.get("/login")
        assert page.status_code == 200
        assert "Sign in with ClassLink" in page.text
        assert "Sign in (local)" in page.text          # local form present
        assert page.text.count(">or<") == 1            # single divider, not dangling


def test_unauthenticated_api_is_401_without_bypass(tmp_path):
    # (The SPA turns this 401 into a redirect to /login.)
    app = create_app(config=load_config(_local_conf(tmp_path)), supervisor=Supervisor())
    with TestClient(app) as client:
        assert client.get("/api/status").status_code == 401
