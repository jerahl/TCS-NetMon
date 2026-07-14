"""Break-glass local authentication.

A single local admin account for when the SAML IdP (ClassLink) or the network
is unreachable — NetMon's "keeps working when the network is down" principle
applied to login. The password is stored as a PBKDF2-SHA256 hash in the config
(never plaintext); verification is stdlib-only (no new dependency).

Generate a hash to paste into [auth] local_password_hash:

    python -m netmon.auth.local        # prompts for the password
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import sys

from netmon.config import ROLES, AuthConfig
from netmon.models.schemas import Role

_ALGO = "pbkdf2_sha256"
_ITERATIONS = 240_000


def hash_password(password: str, iterations: int = _ITERATIONS) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"{_ALGO}${iterations}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, iters, salt_b64, hash_b64 = encoded.split("$")
        if algo != _ALGO:
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(iters))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, expected)


def check_local(auth: AuthConfig, username: str, password: str) -> Role | None:
    """Return the local user's role if the credentials match, else None."""
    if not auth.local_user or not auth.local_password_hash:
        return None
    if not hmac.compare_digest(username or "", auth.local_user):
        return None
    if verify_password(password or "", auth.local_password_hash):
        return Role(auth.local_role if auth.local_role in ROLES else "admin")
    return None


def main(argv: list[str] | None = None) -> int:  # pragma: no cover
    import argparse
    import getpass

    parser = argparse.ArgumentParser(description="Generate a NetMon local-user password hash.")
    parser.add_argument("--password", help="password (omit to be prompted)")
    args = parser.parse_args(argv)
    pw = args.password or getpass.getpass("Local password: ")
    if not pw:
        print("error: empty password", file=sys.stderr)
        return 1
    print(hash_password(pw))
    print("\nPut this in /etc/netmon/netmon.conf under [auth] local_password_hash =", file=sys.stderr)
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
