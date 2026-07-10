"""Login / logout / whoami."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel

from netmon.api.deps import current_user, get_config, get_sessions
from netmon.auth import ldap
from netmon.auth.sessions import COOKIE_NAME, SessionStore
from netmon.config import Config
from netmon.models.schemas import Role, UserSession

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    username: str
    role: Role


@router.post("/login", response_model=LoginResponse)
def login(
    body: LoginRequest,
    response: Response,
    cfg: Config = Depends(get_config),
    sessions: SessionStore = Depends(get_sessions),
) -> LoginResponse:
    try:
        role, groups = ldap.authenticate(body.username, body.password, cfg.auth)
    except ldap.AuthError as exc:
        # Uniform 401 — do not leak whether it was a bad password vs. no role.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="authentication failed"
        ) from exc

    token = sessions.create(body.username, role, groups)
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        secure=cfg.web.secure_cookies,
        max_age=cfg.web.session_ttl,
    )
    return LoginResponse(username=body.username, role=role)


@router.post("/logout")
def logout(
    request: Request,
    response: Response,
    user: UserSession = Depends(current_user),
    sessions: SessionStore = Depends(get_sessions),
) -> dict[str, str]:
    # current_user validated the session exists; destroy it server-side too,
    # not just the client cookie.
    sessions.destroy(request.cookies.get(COOKIE_NAME))
    response.delete_cookie(COOKIE_NAME)
    return {"status": "logged out"}


@router.get("/me", response_model=UserSession)
def me(user: UserSession = Depends(current_user)) -> UserSession:
    return user
