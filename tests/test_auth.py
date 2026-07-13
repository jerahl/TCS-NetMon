import pytest
from fastapi import Response

from netmon.api.auth_routes import complete_login
from netmon.auth.saml import SamlError, role_from_attributes, sp_metadata
from netmon.auth.sessions import SessionStore
from netmon.config import AuthConfig, load_config
from netmon.models.schemas import Role
from tests.conftest import write_config


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
