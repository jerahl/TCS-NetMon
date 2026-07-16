"""Server-side session stores.

Two implementations behind one narrow interface (create/get/destroy/
purge_expired/count):

- ``SessionStore`` — the Phase 1 in-process dict. Kept for tests and as the
  fallback when the ``sessions`` table is absent (migration 007 not applied).
- ``DbSessionStore`` — DB-backed (migration 007; spec 11 §8 debt folded into
  Phase 10.0): sessions survive a restart and are shared across uvicorn
  workers. Only a SHA-256 digest of the opaque cookie token is stored — the
  token itself is never at rest.

Both key sessions by an opaque, high-entropy cookie value; the app picks one
at startup (``netmon.app.lifespan``).
"""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from netmon.models.schemas import Role, UserSession

COOKIE_NAME = "netmon_session"


@dataclass
class _Entry:
    session: UserSession
    expires_at: float


class SessionStore:
    def __init__(self, ttl_seconds: int) -> None:
        self._ttl = ttl_seconds
        self._entries: dict[str, _Entry] = {}

    def create(self, username: str, role: Role, groups: list[str]) -> str:
        token = secrets.token_urlsafe(32)
        self._entries[token] = _Entry(
            session=UserSession(username=username, role=role, groups=groups),
            expires_at=time.time() + self._ttl,
        )
        return token

    def get(self, token: str | None) -> UserSession | None:
        if not token:
            return None
        entry = self._entries.get(token)
        if entry is None:
            return None
        if entry.expires_at < time.time():
            self._entries.pop(token, None)
            return None
        return entry.session

    def destroy(self, token: str | None) -> None:
        if token:
            self._entries.pop(token, None)

    def count(self) -> int:
        """Live (non-expired) session count — surfaced on /api/netmon-status."""
        self.purge_expired()
        return len(self._entries)

    def purge_expired(self) -> int:
        now = time.time()
        stale = [t for t, e in self._entries.items() if e.expires_at < now]
        for t in stale:
            self._entries.pop(t, None)
        return len(stale)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value) -> datetime | None:
    """DB drivers hand back naive datetimes (or ISO strings under SQLite);
    normalize to aware UTC so expiry comparisons are correct."""
    if value is None:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value


class DbSessionStore:
    """Session store over the ``sessions`` table (migration 007).

    Same interface as ``SessionStore``. Expiry is compared in Python
    (portable across MariaDB and the SQLite test DB); expired rows are purged
    opportunistically on ``create`` so the table cannot grow unbounded.
    """

    def __init__(self, engine, ttl_seconds: int) -> None:
        from netmon import db  # local import: auth must not require db at import time

        self._db = db
        self._engine = engine
        self._ttl = ttl_seconds

    def create(self, username: str, role: Role, groups: list[str]) -> str:
        self.purge_expired()
        token = secrets.token_urlsafe(32)
        self._db.execute(
            self._engine,
            "INSERT INTO sessions (token_hash, username, role, groups_json, "
            " created_at, expires_at) "
            "VALUES (:h, :u, :r, :g, :now, :exp)",
            {
                "h": _hash_token(token),
                "u": username,
                "r": role.value,
                "g": json.dumps(groups),
                "now": _utcnow(),
                "exp": _utcnow() + timedelta(seconds=self._ttl),
            },
        )
        return token

    def get(self, token: str | None) -> UserSession | None:
        if not token:
            return None
        row = self._db.fetch_one(
            self._engine,
            "SELECT username, role, groups_json, expires_at FROM sessions "
            "WHERE token_hash = :h",
            {"h": _hash_token(token)},
        )
        if row is None:
            return None
        expires_at = _as_utc(row["expires_at"])
        if expires_at is None or expires_at < _utcnow():
            self.destroy(token)
            return None
        return UserSession(
            username=row["username"],
            role=Role(row["role"]),
            groups=json.loads(row["groups_json"] or "[]"),
        )

    def destroy(self, token: str | None) -> None:
        if token:
            self._db.execute(
                self._engine,
                "DELETE FROM sessions WHERE token_hash = :h",
                {"h": _hash_token(token)},
            )

    def count(self) -> int:
        """Live (non-expired) session count — surfaced on /api/netmon-status."""
        row = self._db.fetch_one(
            self._engine,
            "SELECT COUNT(*) AS n FROM sessions WHERE expires_at >= :now",
            {"now": _utcnow()},
        )
        return int(row["n"] or 0) if row else 0

    def purge_expired(self) -> int:
        return self._db.execute(
            self._engine,
            "DELETE FROM sessions WHERE expires_at < :now",
            {"now": _utcnow()},
        )
