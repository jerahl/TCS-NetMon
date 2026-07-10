"""Server-side session store.

Phase 1 keeps sessions in process memory keyed by an opaque, high-entropy
cookie value. This is intentionally simple and has one known limitation
documented in spec 01: sessions do not survive a restart and are not shared
across multiple uvicorn workers. Promoting this to a DB/Redis-backed store is
a later hardening item — the interface here is deliberately narrow so that
swap is contained.
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass

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

    def purge_expired(self) -> int:
        now = time.time()
        stale = [t for t, e in self._entries.items() if e.expires_at < now]
        for t in stale:
            self._entries.pop(t, None)
        return len(stale)
