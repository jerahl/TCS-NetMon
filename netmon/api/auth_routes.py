"""Authentication: a login page (SSO + break-glass local), SAML SP, logout.

`/login` is the prompt users land on when unauthenticated. It offers ClassLink
SSO (`/auth/sso` → IdP) and, as a fallback that works with no IdP/network, a
local account form (`/auth/local`). SAML ACS/metadata + logout/me round it out.
"""

from __future__ import annotations

import logging
from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse, RedirectResponse

from netmon.api.deps import current_user, get_config, get_sessions
from netmon.auth import saml
from netmon.auth.local import check_local
from netmon.auth.sessions import COOKIE_NAME, SessionStore
from netmon.config import Config
from netmon.models.schemas import Role, UserSession

log = logging.getLogger("netmon.auth")

router = APIRouter(prefix="/auth", tags=["auth"])
page_router = APIRouter(tags=["auth"])  # top-level /login


def _issue_session(username: str, role: Role, groups: list[str], cfg: Config,
                   sessions: SessionStore, response: Response) -> None:
    token = sessions.create(username, role, groups)
    response.set_cookie(
        key=COOKIE_NAME, value=token, httponly=True, samesite="lax",
        secure=cfg.web.secure_cookies, max_age=cfg.web.session_ttl,
    )


async def _form_dict(request: Request) -> dict[str, str]:
    """Parse an application/x-www-form-urlencoded body with the stdlib (no
    python-multipart dependency). SAML responses and the login form are both
    urlencoded."""
    body = (await request.body()).decode("utf-8", errors="replace")
    return {k: v[0] for k, v in parse_qs(body, keep_blank_values=True).items()}


def _request_data(request: Request, post_data: dict) -> dict:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("host", request.url.hostname or "")
    return {
        "https": "on" if proto == "https" else "off",
        "http_host": host,
        "script_name": request.url.path,
        "get_data": dict(request.query_params),
        "post_data": post_data,
    }


def complete_login(attributes: dict[str, list], name_id: str, cfg: Config,
                   sessions: SessionStore, response: Response) -> Role:
    """Map SAML claims → role, mint a session, set the cookie. Testable."""
    role = saml.role_from_attributes(attributes, cfg.auth)
    if role is None:
        raise saml.SamlError(f"user {name_id!r} maps to no NetMon role")
    groups = [str(v) for v in attributes.get(cfg.auth.group_attr, [])]
    _issue_session(name_id, role, groups, cfg, sessions, response)
    return role


# ── Login page ───────────────────────────────────────────────────────────────

@page_router.get("/login", response_class=HTMLResponse)
def login_page(request: Request, error: int = 0, cfg: Config = Depends(get_config)):
    if cfg.auth.dev_bypass_user:
        return RedirectResponse(url="/ui/")  # dev bypass: already authenticated

    sso = bool(cfg.auth.idp_sso_url)
    local = bool(cfg.auth.local_user and cfg.auth.local_password_hash)
    err_html = ('<p style="color:#e5484d;margin:0 0 12px">Invalid credentials.</p>'
                if error else "")
    sso_html = (
        '<a class="btn primary" href="/auth/sso">Sign in with ClassLink</a>'
        '<div class="or">or</div>' if sso else ""
    )
    local_html = (
        '<form method="post" action="/auth/local">'
        '<label>Username<input name="username" autocomplete="username" required></label>'
        '<label>Password<input name="password" type="password" autocomplete="current-password" required></label>'
        '<button class="btn" type="submit">Sign in (local)</button>'
        '</form>'
        if local else ""
    )
    if not sso and not local:
        local_html = '<p>No login method is configured. See docs/spec/01-foundation.md.</p>'

    body = f"""<!doctype html><meta charset=utf-8><title>Sign in · TCS NetMon</title>
<style>
  body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#12141c;color:#e9e9ed;font:14px system-ui,sans-serif}}
  .card{{background:#1b1e29;border:1px solid #2b2f42;border-radius:12px;padding:28px;width:320px}}
  h1{{font-size:18px;margin:0 0 4px}} .sub{{color:#8a8f98;margin:0 0 20px;font-size:12px}}
  label{{display:block;margin:0 0 12px;font-size:12px;color:#8a8f98}}
  input{{display:block;width:100%;margin-top:4px;padding:8px;border:1px solid #2b2f42;
        border-radius:6px;background:#12141c;color:#e9e9ed;box-sizing:border-box}}
  .btn{{display:block;width:100%;text-align:center;padding:9px;border-radius:6px;cursor:pointer;
       border:1px solid #9184d9;background:transparent;color:#9184d9;font-weight:600;margin-top:4px}}
  .btn.primary{{background:#9184d9;color:#12141c}}
  .or{{text-align:center;color:#8a8f98;margin:14px 0;font-size:12px}}
</style>
<div class="card">
  <h1>TCS NetMon</h1><p class="sub">Network operations</p>
  {err_html}{sso_html}{local_html}
</div>"""
    return HTMLResponse(body)


@router.post("/local")
async def local_login(
    request: Request,
    cfg: Config = Depends(get_config),
    sessions: SessionStore = Depends(get_sessions),
):
    form = await _form_dict(request)
    username = form.get("username", "")
    role = check_local(cfg.auth, username, form.get("password", ""))
    if role is None:
        log.warning("local login failed for %r", username)
        return RedirectResponse(url="/login?error=1", status_code=status.HTTP_303_SEE_OTHER)
    resp = RedirectResponse(url="/ui/", status_code=status.HTTP_303_SEE_OTHER)
    _issue_session(username, role, [], cfg, sessions, resp)
    return resp


# ── SAML SSO ──────────────────────────────────────────────────────────────────

@router.get("/sso")
def sso(request: Request, cfg: Config = Depends(get_config)):
    """SP-initiated SSO: redirect to ClassLink."""
    if cfg.auth.dev_bypass_user:
        return RedirectResponse(url="/ui/")
    auth = saml.build_auth(_request_data(request, {}), cfg.auth)
    return RedirectResponse(url=auth.login(return_to="/ui/"))


@router.post("/saml/acs")
async def acs(
    request: Request,
    cfg: Config = Depends(get_config),
    sessions: SessionStore = Depends(get_sessions),
):
    form = await _form_dict(request)
    auth = saml.build_auth(_request_data(request, form), cfg.auth)
    auth.process_response()
    if auth.get_errors() or not auth.is_authenticated():
        log.warning("SAML ACS rejected: %s / %s", auth.get_errors(), auth.get_last_error_reason())
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
