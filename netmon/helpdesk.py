"""Frontline Help Desk adapter — server-side only (docs/spec/25-helpdesk.md).

Everything vendor-specific about the help desk lives in this module: the login
call, the bearer token, the route names, the two-layer export payload, the
field spellings. The browser only ever sees NetMon's own ``/api/helpdesk/*``
shapes, so a Frontline release that renames a field is a change here and
nowhere else.

What this module will and will not do:

* **Reads only.** Every call is a documented *read*. Several are POSTs because
  that is how Frontline exposes them (a grid query carries its paging in a
  body); none of them changes ticket state. The mutation routes in the
  workbook (ChangeTicket, CreateComment, CreateTicket, attachments) are not
  wrapped at all — there is no method here a caller could misuse.
* **The credential never leaves the process.** ``HD_API_KEY`` /
  ``HD_API_PASSPHRASE`` come from the environment; the access token is held in
  memory, never in the database, a response, or a log line. Error messages are
  built from the HTTP status and the route only — never from a response body,
  which may echo ticket content.
* **Bounded.** One timeout per request, a single re-authentication on 401, and
  a backoff after failures so an outage costs one fast refusal per request
  rather than a pile of hung workers.

Field mapping is honest about what is validated. The workbook documents routes
from the vendor's JS bundles; it does not document response schemas. So each
canonical field is looked up through a short list of candidate spellings
(``_FIELDS``), and anything not found renders as missing rather than guessed.
``scripts/helpdesk_probe.py`` prints the key names a live instance actually
returns — no values — so this table can be confirmed against reality.
"""

from __future__ import annotations

import base64
import html
import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any, Callable, Iterable

import httpx

from netmon.config import HelpdeskConfig

log = logging.getLogger("netmon.helpdesk")

#: Ticket identifiers are labels. This is the shape accepted before one is put
#: into a URL path — never a numeric conversion, which would drop leading
#: zeros and turn a typo into a different ticket.
TICKET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

#: The access token is documented as valid 8 hours. Renew this long before
#: expiry so a request never races the boundary.
TOKEN_MARGIN_S = 300
DEFAULT_TOKEN_LIFE_S = 8 * 3600

#: Backoff after consecutive failures: 15s, 30s, 60s … capped at 10 minutes.
BACKOFF_BASE_S = 15
BACKOFF_MAX_S = 600

#: Documented grid "state" values.
STATES = {"active": 0, "inactive": 1, "all": 2}


# ── errors ───────────────────────────────────────────────────────────────────

class HelpdeskError(Exception):
    """A failure with a kind the UI can explain.

    kind ∈ unconfigured | unavailable | auth | inaccessible | not_found | bad_response
    ``message`` is safe to show and to log: built from status codes and route
    names, never from a response body.
    """

    def __init__(self, kind: str, message: str, *, status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.status = status


# ── pure parsers (unit-tested against fixtures) ─────────────────────────────

def _maybe_json(value: Any, what: str) -> Any:
    """Frontline wraps some payloads as a JSON *string* inside JSON."""
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            raise HelpdeskError("bad_response", f"{what}: inner payload is not valid JSON")
    return value


def parse_login(payload: Any, *, now: float | None = None) -> tuple[str, float]:
    """``{token, refreshToken}`` → (token, expiry epoch).

    Expiry comes from the JWT's own ``exp`` when it has one (decoded, not
    verified — NetMon is the token's bearer, not its judge), else the
    documented eight hours.
    """
    now = time.time() if now is None else now
    if not isinstance(payload, dict):
        raise HelpdeskError("bad_response", "login: expected a JSON object")
    token = None
    for k, v in payload.items():
        if k.lower() in ("token", "accesstoken", "access_token") and isinstance(v, str):
            token = v.strip()
    if not token:
        raise HelpdeskError("bad_response", "login: response carried no token")
    expiry = now + DEFAULT_TOKEN_LIFE_S
    parts = token.split(".")
    if len(parts) == 3:
        try:
            pad = "=" * (-len(parts[1]) % 4)
            claims = json.loads(base64.urlsafe_b64decode(parts[1] + pad))
            exp = claims.get("exp")
            if isinstance(exp, (int, float)) and exp > now:
                expiry = min(float(exp), now + DEFAULT_TOKEN_LIFE_S * 2)
        except (ValueError, TypeError):
            pass  # an opaque token is fine; fall back to the documented life
    return token, expiry


def parse_grid(payload: Any) -> tuple[int, list[dict]]:
    """Export/grid response → (totalCount, rows).

    Documented as ``{"totalCount": 180, "result": "[...]"}`` where ``result``
    is itself a JSON string. Both layers are validated; a list-valued
    ``result`` is accepted too, since a later build may stop double-encoding.
    """
    if not isinstance(payload, dict):
        raise HelpdeskError("bad_response", "ticket list: expected a JSON object")
    lower = {k.lower(): v for k, v in payload.items()}
    if "result" not in lower:
        raise HelpdeskError("bad_response", "ticket list: no 'result' field")
    rows = _maybe_json(lower["result"], "ticket list")
    if rows is None:
        rows = []
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise HelpdeskError("bad_response", "ticket list: 'result' is not a list of objects")
    total = lower.get("totalcount")
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        # A missing or nonsense total must not be invented; the row count is
        # what we actually hold.
        total = len(rows)
    return total, rows


def parse_rows(payload: Any, what: str) -> list[dict]:
    """A lookup/list response in any of the shapes seen: a bare list, or an
    object whose ``result`` / ``data`` / ``items`` holds the list (possibly as a
    JSON string)."""
    payload = _maybe_json(payload, what)
    if isinstance(payload, dict):
        lower = {k.lower(): v for k, v in payload.items()}
        for key in ("result", "data", "items", "records"):
            if key in lower:
                payload = _maybe_json(lower[key], what)
                break
    if payload is None:
        return []
    if not isinstance(payload, list) or not all(isinstance(r, dict) for r in payload):
        raise HelpdeskError("bad_response", f"{what}: expected a list of objects")
    return payload


def _ci(row: dict, *names: str) -> Any:
    """Case-insensitive first-present lookup, one level into ``ticketDetails``."""
    if not isinstance(row, dict):
        return None
    lower = {k.lower(): v for k, v in row.items()}
    for n in names:
        v = lower.get(n.lower())
        if v not in (None, ""):
            return v
    nested = lower.get("ticketdetails")
    if isinstance(nested, dict):
        return _ci({k: v for k, v in nested.items() if k.lower() != "ticketdetails"}, *names)
    return None


def _text(v: Any, limit: int = 300) -> str | None:
    if v is None:
        return None
    if isinstance(v, dict):
        v = _ci(v, "name", "displayName", "description", "value")
        if v is None:
            return None
    s = str(v).strip()
    return s[:limit] if s else None


def _ref(v: Any) -> str | None:
    """An identifier as a string, exactly as given (ints included, no floats)."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, float):
        if not v.is_integer():
            return None
        v = int(v)
    s = str(v).strip()
    return s if TICKET_RE.match(s) else None


#: Candidate spellings per canonical field. Starting points from the workbook
#: (export CSV columns, grid fields createdDate / slaTargetDate); the probe
#: confirms or corrects them.
_FIELDS: dict[str, tuple[str, ...]] = {
    "ticket": ("ticketNumber", "ticketNo", "ticketID", "ticketId", "number", "id"),
    "subject": ("subject", "ticketSubject", "title", "summary"),
    "status": ("statusName", "status", "ticketStatus", "statusDescription"),
    "status_id": ("statusID", "statusId"),
    "priority": ("priorityName", "ticketPriorityName", "priority", "ticketPriority"),
    "priority_id": ("ticketPriorityID", "priorityID", "priorityId"),
    "site": ("siteName", "site", "locationName", "building"),
    "site_id": ("siteID", "siteId"),
    "room": ("roomName", "room", "location"),
    "category": ("problemTypeHierarchy", "problemTypeName", "problemType", "category"),
    "assigned_to": ("assignedToName", "assignedTo", "assignedToUserName", "technicianName",
                    "assignedTechnician"),
    "assigned_id": ("assignedToUserID", "assignedToUserId"),
    "created": ("createdDate", "dateCreated", "createDate", "submittedDate"),
    "updated": ("lastModifiedDate", "modifiedDate", "updatedDate", "lastUpdatedDate",
                "lastActivityDate"),
    "due": ("slaTargetDate", "dueDate"),
    "closed": ("closedDate", "dateClosed", "resolvedDate"),
    "is_active": ("isActive", "active", "isOpen"),
    "description": ("ticketDescription", "description", "details", "body"),
}


def field(row: dict, name: str, limit: int = 300) -> str | None:
    return _text(_ci(row, *_FIELDS[name]), limit)


def normalize_ticket(row: dict, *, with_description: bool = False) -> dict | None:
    """One vendor ticket row → NetMon's ticket summary. None if it has no
    usable identifier (a row we cannot key cannot be linked or opened)."""
    ref = _ref(_ci(row, *_FIELDS["ticket"]))
    if ref is None:
        return None
    active = _ci(row, *_FIELDS["is_active"])
    out = {
        "ticket": ref,
        "subject": field(row, "subject"),
        "status": field(row, "status", 100),
        "status_id": _ref(_ci(row, *_FIELDS["status_id"])),
        "priority": field(row, "priority", 100),
        "priority_id": _ref(_ci(row, *_FIELDS["priority_id"])),
        "site": field(row, "site", 200),
        "site_id": _ref(_ci(row, *_FIELDS["site_id"])),
        "room": field(row, "room", 200),
        "category": field(row, "category"),
        "assigned_to": field(row, "assigned_to", 200),
        "assigned_id": _ref(_ci(row, *_FIELDS["assigned_id"])),
        "created": field(row, "created", 40),
        "updated": field(row, "updated", 40),
        "due": field(row, "due", 40),
        "closed": field(row, "closed", 40),
        "is_active": (bool(active) if isinstance(active, (bool, int)) else None),
    }
    if with_description:
        out["description"] = html_to_text(_ci(row, *_FIELDS["description"]))
    return out


def normalize_lookup(rows: Iterable[dict], id_names: tuple[str, ...],
                     name_names: tuple[str, ...]) -> list[dict]:
    out = []
    for r in rows:
        rid = _ref(_ci(r, *id_names))
        name = _text(_ci(r, *name_names), 200)
        if rid is None or name is None:
            continue
        item = {"id": rid, "name": name}
        active = _ci(r, "isActive", "active", "enabled")
        if isinstance(active, (bool, int)):
            item["active"] = bool(active)
        out.append(item)
    return out


_COMMENT_PRIVATE = ("isPrivate", "privateNote", "isPrivateNote", "private", "isInternal")


def normalize_comment(row: dict) -> dict:
    priv = _ci(row, *_COMMENT_PRIVATE)
    return {
        "id": _ref(_ci(row, "ticketCommentID", "commentID", "id")),
        "created": _text(_ci(row, "createdDate", "dateCreated", "commentDate"), 40),
        "author": _text(_ci(row, "createdByName", "createdBy", "userName", "author"), 200),
        "body": html_to_text(_ci(row, "comment", "commentText", "body", "note", "text")),
        # None means the response did not say. The UI must then not present
        # the comment as public — see spec 25 §6.
        "private": (bool(priv) if isinstance(priv, (bool, int)) else None),
    }


def normalize_attachment(row: dict) -> dict:
    size = _ci(row, "fileSize", "size", "sizeBytes")
    return {
        "id": _ref(_ci(row, "ticketAttachmentID", "attachmentID", "id")),
        "filename": _text(_ci(row, "fileName", "originalFileName", "name"), 255),
        "size": size if isinstance(size, int) and not isinstance(size, bool) else None,
        "created": _text(_ci(row, "createdDate", "dateCreated", "uploadedDate"), 40),
    }


def normalize_history(row: dict) -> dict:
    return {
        "field": _text(_ci(row, "fieldName", "field", "displayName"), 100),
        "old": _text(_ci(row, "oldValue", "previousValue", "from"), 300),
        "new": _text(_ci(row, "newValue", "value", "to"), 300),
        "at": _text(_ci(row, "createdDate", "changedDate", "dateChanged", "date"), 40),
        "by": _text(_ci(row, "changedByName", "createdByName", "userName", "changedBy"), 200),
    }


class _TextOnly(HTMLParser):
    _BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "pre",
              "blockquote", "table", "ul", "ol"}
    _SKIP = {"script", "style", "head", "title", "noscript"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip += 1
        elif tag in self._BLOCK:
            self.out.append("\n")
        if tag == "li":
            self.out.append("• ")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip:
            self._skip -= 1
        elif tag in self._BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.out.append(data)


def html_to_text(value: Any, limit: int = 64000) -> str | None:
    """Help desk HTML → plain text.

    Ticket bodies and comments are authored in a rich-text editor and arrive
    as HTML. Rendering that HTML in NetMon would make every ticket submitter a
    script author on an operator's session, so it is reduced to text here —
    the browser receives no markup to render, only characters.
    """
    if value is None:
        return None
    s = str(value)
    if "<" in s:
        p = _TextOnly()
        try:
            p.feed(s)
            p.close()
            s = "".join(p.out)
        except Exception:  # malformed markup: fall back to stripping tags
            s = html.unescape(re.sub(r"<[^>]*>", " ", s))
    else:
        s = html.unescape(s)
    s = re.sub(r"[ \t\r\f\v]+", " ", s)
    s = re.sub(r" *\n *", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s).strip()
    return s[:limit] or None


def created_filter(days: int, *, now: datetime | None = None) -> dict:
    """Kendo composite filter on createdDate (the one grid filter the workbook
    confirmed live). UTC ISO with milliseconds, as documented."""
    now = now or datetime.now(timezone.utc)
    since = (now - timedelta(days=days)).replace(microsecond=0)
    return {"logic": "and", "filters": [{
        "field": "createdDate", "operator": "gte",
        "value": since.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    }]}


def grid_body(state: int, filt: dict | None) -> dict:
    """The documented grid/export request. pageNumber/pageCount 0/0 = all rows
    — callers bound it with a createdDate filter (or the Active state)."""
    return {"pageNumber": 0, "pageCount": 0, "state": state, "filter": filt,
            "sort": None, "visibleCustomColumns": []}


# ── client ───────────────────────────────────────────────────────────────────

@dataclass
class _Token:
    value: str
    expires_at: float


class FrontlineClient:
    """Thread-safe synchronous client. NetMon's helpdesk routes are plain
    ``def`` handlers (run in the threadpool), so blocking I/O here never stalls
    the event loop the supervised tasks share (see the 502 incident in
    supervisor.py)."""

    def __init__(self, cfg: HelpdeskConfig, *, transport: httpx.BaseTransport | None = None,
                 clock: Callable[[], float] = time.time):
        self.cfg = cfg
        self._clock = clock
        self._http = httpx.Client(base_url=cfg.base_url, timeout=cfg.timeout_s,
                                  verify=cfg.verify_ssl, transport=transport,
                                  headers={"Accept": "application/json"})
        self._token: _Token | None = None
        self._lock = threading.Lock()
        self._failures = 0
        self._blocked_until = 0.0
        self.last_ok: float | None = None
        self.last_error: str | None = None

    # -- state ---------------------------------------------------------------

    def status(self) -> dict:
        now = self._clock()
        return {
            "configured": self.cfg.has_credentials,
            "backoff_s": max(0, int(self._blocked_until - now)),
            "consecutive_failures": self._failures,
            "last_error": self.last_error,
            "token_valid": bool(self._token and self._token.expires_at - TOKEN_MARGIN_S > now),
        }

    def _fail(self, err: HelpdeskError) -> HelpdeskError:
        # Only an outage trips the breaker. not_found / inaccessible are
        # answers about one ticket, and bad_response (an unknown route, an
        # unexpected shape) is a fact about one route — letting either block
        # every other call would turn a renamed lookup into a full outage.
        if err.kind in ("unavailable", "auth"):
            self._failures += 1
            delay = min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** (self._failures - 1))
            self._blocked_until = self._clock() + delay
            self.last_error = err.message
        return err

    def _ok(self) -> None:
        self._failures = 0
        self._blocked_until = 0.0
        self.last_ok = self._clock()
        self.last_error = None

    # -- auth ----------------------------------------------------------------

    def _login(self) -> str:
        if not self.cfg.has_credentials:
            raise HelpdeskError("unconfigured", "HD_API_KEY / HD_API_PASSPHRASE are not set")
        try:
            resp = self._http.post("Login/AuthorizeAPI", json={
                "SecretKey": self.cfg.api_key, "Passphrase": self.cfg.passphrase})
        except httpx.HTTPError as exc:
            raise HelpdeskError("unavailable", f"login: {type(exc).__name__}")
        if resp.status_code in (401, 403):
            raise HelpdeskError("auth", f"login refused (HTTP {resp.status_code}) — check the "
                                "API key and passphrase", status=resp.status_code)
        if resp.status_code >= 400:
            raise HelpdeskError("unavailable", f"login: HTTP {resp.status_code}",
                                status=resp.status_code)
        try:
            payload = resp.json()
        except ValueError:
            raise HelpdeskError("bad_response", "login: response is not JSON")
        token, expiry = parse_login(payload, now=self._clock())
        self._token = _Token(token, expiry)
        return token

    def _bearer(self, force: bool = False) -> str:
        with self._lock:
            tok = self._token
            if force or tok is None or tok.expires_at - TOKEN_MARGIN_S <= self._clock():
                return self._login()
            return tok.value

    # -- requests ------------------------------------------------------------

    def request(self, method: str, path: str, body: Any = None) -> Any:
        """One read call. Re-authenticates once on 401; never retries anything
        else (no idempotency guarantee is assumed, even for reads)."""
        if self._blocked_until > self._clock():
            raise HelpdeskError(
                "unavailable",
                f"help desk unavailable — retrying in {int(self._blocked_until - self._clock())}s"
                + (f" (last error: {self.last_error})" if self.last_error else ""))
        try:
            for attempt in (0, 1):
                token = self._bearer(force=attempt == 1)
                try:
                    resp = self._http.request(
                        method, path, json=body,
                        headers={"Authorization": f"Bearer {token}"})
                except httpx.HTTPError as exc:
                    raise HelpdeskError("unavailable", f"{_route(path)}: {type(exc).__name__}")
                if resp.status_code == 401 and attempt == 0:
                    continue
                return self._decode(resp, path)
            raise HelpdeskError("auth", f"{_route(path)}: still unauthorised after re-login",
                                status=401)
        except HelpdeskError as err:
            raise self._fail(err)

    def _decode(self, resp: httpx.Response, path: str) -> Any:
        code = resp.status_code
        route = _route(path)
        if code == 404:
            raise HelpdeskError("not_found", f"{route}: not found", status=404)
        if code in (401, 403):
            raise HelpdeskError("inaccessible", f"{route}: access denied (HTTP {code})", status=code)
        if code == 444:
            raise HelpdeskError("bad_response", f"{route}: route unknown to this help desk build",
                                status=444)
        if code >= 400:
            raise HelpdeskError("unavailable", f"{route}: HTTP {code}", status=code)
        if not resp.content:
            self._ok()
            return None
        try:
            payload = resp.json()
        except ValueError:
            raise HelpdeskError("bad_response", f"{route}: response is not JSON")
        self._ok()
        return payload

    # -- documented read routes --------------------------------------------

    def home(self) -> Any:
        try:
            resp = self._http.get("Home")
        except httpx.HTTPError as exc:
            raise HelpdeskError("unavailable", f"Home: {type(exc).__name__}")
        return self._decode(resp, "Home")

    def ticket_grid(self, state: int, filt: dict | None) -> tuple[int, list[dict]]:
        return parse_grid(self.request(
            "POST", f"Ticket/GetExportDataTickets/{self.cfg.scope_user_id}",
            grid_body(state, filt)))

    def ticket(self, ref: str) -> dict:
        _check_ref(ref)
        payload = _maybe_json(self.request("GET", f"Ticket/{ref}"), "ticket")
        if isinstance(payload, dict) and len(payload) == 1:
            only = next(iter(payload.values()))
            if isinstance(only, dict):
                payload = only
        if not isinstance(payload, dict):
            raise HelpdeskError("bad_response", "ticket: expected a JSON object")
        return payload

    def comments(self, ref: str) -> list[dict]:
        _check_ref(ref)
        return parse_rows(self.request(
            "POST", f"Ticket/{ref}/GetTicketComments",
            {"pageNumber": 0, "pageCount": 0, "privateNotesOnly": False}), "comments")

    def attachments(self, ref: str) -> list[dict]:
        _check_ref(ref)
        return parse_rows(self.request(
            "POST", f"Ticket/{ref}/GetAllAttachments",
            {"pageNumber": 0, "pageCount": 0}), "attachments")

    def history(self, ref: str) -> list[dict]:
        _check_ref(ref)
        return parse_rows(self.request(
            "POST", f"Ticket/{ref}/TicketFieldHistory/GetTicketHistory",
            {"pageNumber": 0, "pageCount": 0}), "history")

    def statuses(self) -> list[dict]:
        return normalize_lookup(parse_rows(self.request("POST", "Status/GetActiveStatuses", {}),
                                           "statuses"),
                                ("statusID", "statusId", "id"), ("statusName", "name", "status"))

    def priorities(self) -> list[dict]:
        return normalize_lookup(parse_rows(self.request(
            "POST", "TicketPriority/GetPriorities", {"pageNumber": 0, "pageCount": 0}),
            "priorities"),
            ("ticketPriorityID", "priorityID", "id"), ("priorityName", "name", "priority"))

    def sites(self) -> list[dict]:
        return normalize_lookup(parse_rows(self.request(
            "POST", "Location/GetSites",
            {"pageNumber": 0, "pageCount": 0, "includeDisable": False}), "sites"),
            ("siteID", "siteId", "id"), ("siteName", "name", "site"))

    def categories(self) -> list[dict]:
        return normalize_lookup(parse_rows(self.request(
            "POST", "ProblemTypes/GetProblemTypesHierarchy",
            {"pageNumber": 0, "pageCount": 0, "includeDisable": False}), "categories"),
            ("problemTypeID", "problemTypeId", "id"),
            ("problemTypeHierarchy", "hierarchy", "problemTypeName", "name"))

    def technicians(self) -> list[dict]:
        return normalize_lookup(parse_rows(self.request("GET", "User/GetAllTechnicians"),
                                           "technicians"),
                                ("userID", "userId", "id"),
                                ("fullName", "displayName", "name", "userName"))

    def close(self) -> None:
        self._http.close()


def _route(path: str) -> str:
    """A path with identifiers masked, for messages: Ticket/4821/X → Ticket/{n}/X."""
    return re.sub(r"/[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*", "/{n}", "/" + path.strip("/"))[1:]


def _check_ref(ref: str) -> None:
    if not TICKET_RE.match(str(ref or "")):
        raise HelpdeskError("not_found", "invalid ticket identifier")
