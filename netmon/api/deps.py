"""Shared FastAPI dependencies: app state accessors and role gating."""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status

from netmon.auth.sessions import COOKIE_NAME, SessionStore
from netmon.config import ROLES, Config
from netmon.models.schemas import Role, UserSession


def get_config(request: Request) -> Config:
    return request.app.state.config


def get_engine(request: Request):
    return request.app.state.engine


def get_sessions(request: Request) -> SessionStore:
    return request.app.state.sessions


def current_user(
    request: Request,
    cfg: Config = Depends(get_config),
    sessions: SessionStore = Depends(get_sessions),
) -> UserSession:
    """Resolve the authenticated principal or raise 401.

    Honours the local-dev auth bypass (config already refuses it when
    ``secure_cookies=true``, so it cannot be live in production).
    """
    if cfg.auth.dev_bypass_user:
        return UserSession(
            username=cfg.auth.dev_bypass_user,
            role=Role(cfg.auth.dev_bypass_role or "admin"),
            groups=[],
        )

    token = request.cookies.get(COOKIE_NAME)
    session = sessions.get(token)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not authenticated",
        )
    return session


def require_role(minimum: Role):
    """Dependency factory gating a route on a minimum role.

    Roles are ordered viewer < operator < admin (config.ROLES).
    """
    threshold = ROLES.index(minimum.value)

    def _dep(user: UserSession = Depends(current_user)) -> UserSession:
        if ROLES.index(user.role.value) < threshold:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"requires role {minimum.value} or higher",
            )
        return user

    return _dep
