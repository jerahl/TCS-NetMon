"""Active Directory authentication via ldap3.

Read-only: NetMon binds to authenticate a user and read their group
membership, and never writes to AD (CLAUDE.md §4.1). The highest role any of
the user's groups grants wins.
"""

from __future__ import annotations

from netmon.config import ROLES, AuthConfig
from netmon.models.schemas import Role


class AuthError(Exception):
    """Raised on a failed bind or an unauthorized (no mapped group) user."""


def role_for_groups(group_dns: list[str], group_map: dict[str, str]) -> Role | None:
    """Return the highest role granted by the user's group memberships.

    ``group_map`` is role-name -> group DN. Comparison is case-insensitive on
    the DN (AD DNs are not case-sensitive).
    """
    member = {dn.lower() for dn in group_dns}
    best: Role | None = None
    for role_name in ROLES:  # low -> high privilege order
        dn = group_map.get(role_name)
        if dn and dn.lower() in member:
            best = Role(role_name)
    return best


def authenticate(username: str, password: str, cfg: AuthConfig) -> tuple[Role, list[str]]:
    """Bind as the user, read group membership, resolve a role.

    :returns: (role, group_dns)
    :raises AuthError: bad credentials, unreachable server, or no mapped role.
    """
    if not username or not password:
        raise AuthError("username and password are required")

    # Imported lazily so unit tests that only exercise role mapping / the dev
    # bypass don't require a live ldap3 network stack.
    from ldap3 import ALL, SUBTREE, Connection, Server
    from ldap3.core.exceptions import LDAPException

    user_dn = cfg.ldap_user_dn_template.format(username=username)
    try:
        server = Server(cfg.ldap_server, get_info=ALL, connect_timeout=10)
        conn = Connection(server, user=user_dn, password=password, auto_bind=True)
    except LDAPException as exc:
        raise AuthError(f"AD bind failed for {username!r}") from exc

    try:
        conn.search(
            search_base=cfg.ldap_base_dn,
            search_filter=f"(sAMAccountName={_escape(username)})",
            search_scope=SUBTREE,
            attributes=["memberOf"],
        )
        group_dns: list[str] = []
        if conn.entries:
            raw = conn.entries[0].memberOf.values if "memberOf" in conn.entries[0] else []
            group_dns = [str(g) for g in raw]
    finally:
        conn.unbind()

    role = role_for_groups(group_dns, cfg.group_map)
    if role is None:
        raise AuthError(
            f"user {username!r} authenticated but belongs to no NetMon role group"
        )
    return role, group_dns


def _escape(value: str) -> str:
    """Escape LDAP filter special characters (RFC 4515)."""
    out = []
    for ch in value:
        if ch in "\\*()\0":
            out.append("\\%02x" % ord(ch))
        else:
            out.append(ch)
    return "".join(out)
