from netmon.auth.ldap import role_for_groups
from netmon.auth.sessions import SessionStore
from netmon.models.schemas import Role


def test_role_for_groups_picks_highest():
    group_map = {
        "viewer": "CN=NetMon-Viewers,DC=x",
        "operator": "CN=NetMon-Operators,DC=x",
        "admin": "CN=NetMon-Admins,DC=x",
    }
    # Member of viewer + admin → admin wins.
    role = role_for_groups(
        ["CN=NetMon-Viewers,DC=x", "CN=NetMon-Admins,DC=x", "CN=Other,DC=x"],
        group_map,
    )
    assert role is Role.admin


def test_role_for_groups_case_insensitive_and_none():
    group_map = {"operator": "CN=NetMon-Operators,DC=x"}
    assert role_for_groups(["cn=netmon-operators,dc=x"], group_map) is Role.operator
    assert role_for_groups(["CN=Unmapped,DC=x"], group_map) is None


def test_session_store_lifecycle():
    store = SessionStore(ttl_seconds=3600)
    token = store.create("alice", Role.operator, ["CN=Ops,DC=x"])
    sess = store.get(token)
    assert sess is not None and sess.username == "alice" and sess.role is Role.operator
    store.destroy(token)
    assert store.get(token) is None
    assert store.get(None) is None


def test_session_expiry():
    store = SessionStore(ttl_seconds=-1)  # already expired on creation
    token = store.create("bob", Role.viewer, [])
    assert store.get(token) is None
