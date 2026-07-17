"""Authentication: a login page (SSO + break-glass local), SAML SP, logout.

`/login` is the prompt users land on when unauthenticated. It offers ClassLink
SSO (`/auth/sso` → IdP) and, as a fallback that works with no IdP/network, a
local account form (`/auth/local`). SAML ACS/metadata + logout/me round it out.
"""

from __future__ import annotations

import html
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
    err_html = ('<p style="color:#e5484d;margin:0 0 12px">Invalid credentials.</p>'
                if error else "")
    sso_html = (
        '<a class="btn primary" href="/auth/sso">Sign in with ClassLink</a>' if sso else ""
    )
    # The local (break-glass) form is always shown — it's the fallback when the
    # IdP / network is down. The "or" divider only appears between two methods.
    divider = '<div class="or">or</div>' if sso else ""
    local_html = (
        '<form method="post" action="/auth/local">'
        '<label>Username<input name="username" autocomplete="username" required></label>'
        '<label>Password<input name="password" type="password" autocomplete="current-password" required></label>'
        '<button class="btn" type="submit">Sign in (local)</button>'
        '</form>'
    )

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
  {err_html}{sso_html}{divider}{local_html}
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


def saml_debug_page(
    attributes: dict[str, list],
    name_id: str | None,
    name_id_format: str | None,
    session_index: str | None,
    cfg: Config,
) -> str:
    """Render the received assertion's attributes + role-mapping verdict.

    Shown by the ACS when ``[auth] saml_debug=true`` instead of issuing a
    session — a read-only diagnostic so the admin can see exactly what
    ClassLink releases and fill in the ``saml_role_*`` / ``saml_group_*`` maps.
    Every value comes from the IdP and is untrusted, so escape everything.
    """
    e = html.escape

    def _row(name: str, values: list) -> str:
        vals = "".join(
            f'<li><code>{e(str(v))}</code></li>' for v in values
        ) or '<li class="muted">(no values)</li>'
        return f'<tr><td><code>{e(str(name))}</code></td><td><ul>{vals}</ul></td></tr>'

    if attributes:
        attr_rows = "".join(_row(n, v) for n, v in sorted(attributes.items()))
    else:
        attr_rows = ('<tr><td colspan=2 class="muted">The assertion carried no '
                     'attributes. Check the ClassLink app\'s attribute release '
                     'configuration.</td></tr>')

    report = saml.explain_role_mapping(attributes, cfg.auth)
    if report["mapped_role"]:
        vias = ", ".join(
            f'{m["role"]}'
            + (f' via {cfg.auth.role_attr}={m["via_role"]}' if m["via_role"] else "")
            + (f' via {cfg.auth.group_attr}={m["via_group"]}' if m["via_group"] else "")
            for m in report["matches"]
        )
        verdict = (
            f'<p class="ok">Maps to role <b>{e(report["mapped_role"])}</b> '
            f'(highest of: {e(vias)}).</p>'
        )
    else:
        verdict = (
            '<p class="bad">Maps to <b>no NetMon role</b> — this user would be '
            'denied. Add one of the values seen above to '
            f'<code>[auth] saml_role_{{viewer|operator|admin}}</code> (matched '
            f'against attribute <code>{e(cfg.auth.role_attr)}</code>) or '
            f'<code>saml_group_*</code> (against '
            f'<code>{e(cfg.auth.group_attr)}</code>).</p>'
        )

    meta_rows = "".join(
        f'<tr><td>{e(k)}</td><td><code>{e(str(v)) if v else "—"}</code></td></tr>'
        for k, v in (
            ("NameID", name_id),
            ("NameID format", name_id_format),
            ("SessionIndex", session_index),
            ("role attribute (saml_role_attr)", cfg.auth.role_attr),
            ("group attribute (saml_group_attr)", cfg.auth.group_attr),
        )
    )

    return f"""<!doctype html><meta charset=utf-8><title>SAML debug · TCS NetMon</title>
<style>
  body{{margin:0;padding:32px;background:#12141c;color:#e9e9ed;
       font:14px system-ui,sans-serif;line-height:1.5}}
  .wrap{{max-width:900px;margin:0 auto}}
  h1{{font-size:20px;margin:0 0 4px}} .sub{{color:#8a8f98;margin:0 0 24px;font-size:12px}}
  h2{{font-size:14px;margin:28px 0 8px;color:#9184d9}}
  table{{width:100%;border-collapse:collapse;background:#1b1e29;border:1px solid #2b2f42;
         border-radius:8px;overflow:hidden}}
  td{{padding:8px 12px;border-top:1px solid #2b2f42;vertical-align:top}}
  td:first-child{{color:#8a8f98;width:34%;white-space:nowrap}}
  ul{{margin:0;padding-left:18px}} code{{color:#e9e9ed;background:#12141c;padding:1px 5px;border-radius:4px}}
  .ok{{color:#30a46c}} .bad{{color:#e5484d}} .muted{{color:#8a8f98}}
  .banner{{background:#3a2d12;border:1px solid #7a5c1e;color:#f5c451;padding:10px 14px;
           border-radius:8px;margin:0 0 20px;font-size:12px}}
</style>
<div class="wrap">
  <h1>SAML attribute debug</h1>
  <p class="sub">TCS NetMon · <code>saml_debug=true</code></p>
  <div class="banner">Debug mode is on: the assertion validated but <b>no session was
  issued</b>. Turn <code>[auth] saml_debug</code> off and restart once mapping is done.</div>

  <h2>Assertion</h2>
  <table><tbody>{meta_rows}</tbody></table>

  <h2>Attributes released by the IdP</h2>
  <table><tbody>{attr_rows}</tbody></table>

  <h2>Role mapping</h2>
  {verdict}
</div>"""


def saml_error_page(errors: list[str], reason: str | None, response_xml: str,
                    cfg: Config) -> str:
    """Render a SAML *validation* failure (before attribute mapping).

    Shown by the ACS when ``saml_debug=true`` and the assertion is rejected —
    the OneLogin error codes, the human-readable reason (the single most useful
    line: signature/audience/destination/clock), and the decoded response XML.
    Only reachable with the debug flag on, so it never leaks to normal users.
    """
    e = html.escape
    codes = ", ".join(e(str(c)) for c in errors) or "(none)"
    reason_html = e(reason) if reason else "(no reason reported by python3-saml)"
    xml_html = (f"<pre>{e(response_xml)}</pre>" if response_xml
                else '<p class="muted">No decoded response available.</p>')

    # Compare what the IdP sent against the SP config — this names the mismatch
    # (audience/destination/deprecated signature) instead of leaving it to the
    # reader's eyes on the raw XML below.
    facts = saml.extract_response_facts(response_xml)

    def _cmp(label: str, got, want: str, matched: bool) -> str:
        got_txt = ", ".join(str(g) for g in got) if isinstance(got, list) else (got or "—")
        badge = ('<span class="ok">match</span>' if matched
                 else '<span class="bad">MISMATCH</span>')
        return (f'<tr><td>{e(label)}</td><td><code>{e(str(got_txt))}</code></td>'
                f'<td><code>{e(want or "—")}</code></td><td>{badge}</td></tr>')

    checks = ""
    if facts["audiences"] or facts["destination"]:
        aud_ok = cfg.auth.sp_entity_id in facts["audiences"]
        dest_ok = (not facts["destination"]
                   or facts["destination"] == cfg.auth.sp_acs_url)
        checks = (
            '<h2>What the IdP sent vs. your config</h2>'
            '<table><tbody>'
            '<tr><td class="muted">check</td><td class="muted">in response</td>'
            '<td class="muted">saml_sp_* config</td><td></td></tr>'
            + _cmp("Audience → saml_sp_entity_id", facts["audiences"],
                   cfg.auth.sp_entity_id, aud_ok)
            + _cmp("Destination → saml_sp_acs_url", facts["destination"],
                   cfg.auth.sp_acs_url, dest_ok)
            + '</tbody></table>'
        )

    sig = facts["signature_method"]
    if sig in saml.DEPRECATED_SIG_ALGS:
        checks += (
            f'<p class="muted" style="margin-top:12px">Signature algorithm: '
            f'<code>{e(sig)}</code> — deprecated (SHA-1). NetMon accepts it '
            f'(python3-saml default), but a stricter <code>rejectDeprecatedAlgorithm</code> '
            f'setting would reject it. ClassLink signs with RSA-SHA1.</p>'
        )

    hints = {
        "invalid_response_signature": "The assertion/response signature did not "
            "verify — the IdP signing cert in saml_idp_x509cert is wrong, stale, "
            "or the IdP is not signing what NetMon expects.",
        "invalid_audience": "The assertion Audience does not equal saml_sp_entity_id "
            "— they must match exactly (the ClassLink app's Entity ID / Audience).",
        "invalid_destination": "The response Destination does not equal saml_sp_acs_url "
            "— check for http vs https or a proxy rewriting the host/path.",
        "response_not_success": "The IdP returned a non-Success status (the user "
            "may not be assigned to this app in ClassLink).",
        "assertion_expired": "Clock skew — NotBefore/NotOnOrAfter rejected. Check NTP "
            "on the NetMon host.",
    }
    matched = [f"<li><b>{e(c)}</b>: {e(h)}</li>"
               for c, h in hints.items() if c in set(errors)]
    hint_html = (f"<h2>Likely cause</h2><ul>{''.join(matched)}</ul>" if matched else "")

    return f"""<!doctype html><meta charset=utf-8><title>SAML error · TCS NetMon</title>
<style>
  body{{margin:0;padding:32px;background:#12141c;color:#e9e9ed;
       font:14px system-ui,sans-serif;line-height:1.5}}
  .wrap{{max-width:900px;margin:0 auto}}
  h1{{font-size:20px;margin:0 0 4px}} .sub{{color:#8a8f98;margin:0 0 24px;font-size:12px}}
  h2{{font-size:14px;margin:28px 0 8px;color:#9184d9}}
  table{{width:100%;border-collapse:collapse;background:#1b1e29;border:1px solid #2b2f42;
         border-radius:8px;overflow:hidden}}
  td{{padding:8px 12px;border-top:1px solid #2b2f42;vertical-align:top}}
  td:first-child{{color:#8a8f98;width:22%;white-space:nowrap}}
  code{{color:#e9e9ed;background:#12141c;padding:1px 5px;border-radius:4px}}
  pre{{background:#1b1e29;border:1px solid #2b2f42;border-radius:8px;padding:14px;
       overflow:auto;max-height:420px;font-size:12px;white-space:pre-wrap;word-break:break-word}}
  .muted{{color:#8a8f98}} ul{{margin:0;padding-left:18px}}
  .banner{{background:#3a1516;border:1px solid #7a2e2e;color:#ff9592;padding:10px 14px;
           border-radius:8px;margin:0 0 20px}}
</style>
<div class="wrap">
  <h1>SAML validation failed</h1>
  <p class="sub">TCS NetMon · <code>saml_debug=true</code> · the assertion was rejected
  before role mapping</p>
  <div class="banner"><b>Reason:</b> {reason_html}</div>

  <table><tbody>
    <tr><td>Error codes</td><td><code>{codes}</code></td></tr>
    <tr><td>SP entityId</td><td><code>{e(cfg.auth.sp_entity_id) or "—"}</code></td></tr>
    <tr><td>SP ACS URL</td><td><code>{e(cfg.auth.sp_acs_url) or "—"}</code></td></tr>
    <tr><td>IdP entityId</td><td><code>{e(cfg.auth.idp_entity_id) or "—"}</code></td></tr>
  </tbody></table>

  {checks}

  {hint_html}

  <h2>Decoded SAML response</h2>
  {xml_html}
</div>"""


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
    # process_response() itself can raise on a malformed/undecodable response
    # (bad base64, not XML); treat that as a validation failure with a reason
    # rather than a bare 500.
    try:
        auth.process_response()
        errors = auth.get_errors()
        reason = auth.get_last_error_reason()
        authenticated = auth.is_authenticated()
    except Exception as exc:  # noqa: BLE001 — surfaced to the operator below
        errors, reason, authenticated = ["exception"], str(exc), False

    if errors or not authenticated:
        log.warning("SAML ACS rejected: %s / %s", errors, reason)
        # Validation failures (signature, audience, destination, clock skew,
        # cert mismatch) happen *before* attribute mapping. In debug mode show
        # the actual reason + decoded response so the operator can fix it
        # without shell access to the logs.
        if cfg.auth.saml_debug:
            xml = getattr(auth, "get_last_response_xml", lambda: "")() or ""
            return HTMLResponse(
                saml_error_page(errors, reason, xml, cfg),
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="SAML authentication failed (enable [auth] saml_debug for the reason)",
        )

    attributes = auth.get_attributes()
    name_id = auth.get_nameid()

    # Diagnostic mode: render what the IdP released instead of logging in, so
    # the admin can fill in the role/group maps. No session is minted.
    if cfg.auth.saml_debug:
        log.warning(
            "SAML debug: assertion for %r validated; attributes released: %s "
            "(no session issued — saml_debug is on)",
            name_id, sorted(attributes),
        )
        return HTMLResponse(saml_debug_page(
            attributes, name_id,
            getattr(auth, "get_nameid_format", lambda: None)(),
            getattr(auth, "get_session_index", lambda: None)(),
            cfg,
        ))

    response = RedirectResponse(url="/ui/", status_code=status.HTTP_303_SEE_OTHER)
    try:
        complete_login(attributes, name_id, cfg, sessions, response)
    except saml.SamlError as exc:
        # A validated user who maps to no role is almost always an attribute-map
        # gap. Log the names present (not values — they may be PII) to point the
        # admin at the fix; enable saml_debug to see the values.
        log.warning(
            "SAML login denied (%s); attributes present: %s — enable "
            "[auth] saml_debug to inspect their values", exc, sorted(attributes),
        )
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
