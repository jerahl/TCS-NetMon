"""SAML SSO endpoints (ClassLink IdP) + logout / whoami.

Flow: `/auth/login` → redirect to ClassLink → ClassLink POSTs the signed
assertion to `/auth/saml/acs` → NetMon validates it, maps role/group_ids claims
to a NetMon role, issues a session cookie, and redirects to the UI.
`/auth/saml/metadata` serves SP metadata for registering NetMon in ClassLink.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse

from netmon.api.deps import current_user, get_config, get_sessions
from netmon.auth import saml
from netmon.auth.sessions import COOKIE_NAME, SessionStore
from netmon.config import Config
from netmon.models.schemas import Role, UserSession

log = logging.getLogger("netmon.auth")
router = APIRouter(prefix="/auth", tags=["auth"])


def _request_data(request: Request, post_data: dict) -> dict:
    """Shape a FastAPI request for python3-saml (honours the TLS proxy)."""
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("host", request.url.hostname or "")
    return {
        "https": "on" if proto == "https" else "off",
        "http_host": host,
        "script_name": request.url.path,
        "get_data": dict(request.query_params),
        "post_data": post_data,
    }


def complete_login(
    attributes: dict[str, list],
    name_id: str,
    cfg: Config,
    sessions: SessionStore,
    response: Response,
) -> Role:
    """Map assertion claims → role, mint a session, set the cookie. Testable."""
    role = saml.role_from_attributes(attributes, cfg.auth)
    if role is None:
        raise saml.SamlError(f"user {name_id!r} maps to no NetMon role")
    groups = [str(v) for v in attributes.get(cfg.auth.group_attr, [])]
    token = sessions.create(name_id, role, groups)
    response.set_cookie(
        key=COOKIE_NAME, value=token, httponly=True, samesite="lax",
        secure=cfg.web.secure_cookies, max_age=cfg.web.session_ttl,
    )
    return role


@router.get("/login")
def login(request: Request, cfg: Config = Depends(get_config)):
    """SP-initiated SSO: redirect the browser to ClassLink."""
    if cfg.auth.dev_bypass_user:
        return RedirectResponse(url="/ui/")  # dev bypass: already authenticated
    auth = saml.build_auth(_request_data(request, {}), cfg.auth)
    return RedirectResponse(url=auth.login(return_to="/ui/"))


@router.post("/saml/acs")
async def acs(
    request: Request,
    cfg: Config = Depends(get_config),
    sessions: SessionStore = Depends(get_sessions),
):
    """Assertion Consumer Service — ClassLink POSTs the signed response here."""
    form = dict(await request.form())
    auth = saml.build_auth(_request_data(request, form), cfg.auth)
    auth.process_response()
    errors = auth.get_errors()
    if errors or not auth.is_authenticated():
        log.warning("SAML ACS rejected: errors=%s reason=%s", errors, auth.get_last_error_reason())
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="SAML authentication failed")

    response = RedirectResponse(url="/ui/", status_code=status.HTTP_303_SEE_OTHER)
    try:
        complete_login(auth.get_attributes(), auth.get_nameid(), cfg, sessions, response)
    except saml.SamlError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    return response


@router.get("/saml/metadata")
def metadata(cfg: Config = Depends(get_config)) -> Response:
    try:
        xml = saml.sp_metadata(cfg.auth)
    except saml.SamlError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return Response(content=xml, media_type="application/xml")


@router.post("/logout")
def logout(
    request: Request,
    response: Response,
    user: UserSession = Depends(current_user),
    sessions: SessionStore = Depends(get_sessions),
) -> dict[str, str]:
    sessions.destroy(request.cookies.get(COOKIE_NAME))
    response.delete_cookie(COOKIE_NAME)
    return {"status": "logged out"}


@router.get("/me", response_model=UserSession)
def me(user: UserSession = Depends(current_user)) -> UserSession:
    return user
