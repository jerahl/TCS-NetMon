"""Helpdesk API — Frontline tickets through NetMon, plus NetMon-owned links
(docs/spec/25-helpdesk.md).

Two very different kinds of data meet here, and the module keeps them apart:

* **Tickets** belong to Frontline. They are read through ``netmon.helpdesk``
  on demand, cached briefly in memory, and never stored beyond a thin summary
  of tickets somebody linked (``helpdesk_ticket_cache``). No route here writes
  to the help desk.
* **Links** belong to NetMon (``helpdesk_links``). They are ordinary local
  rows: they load when the help desk is down, they survive a ticket that has
  gone missing, and removing one deletes neither the ticket nor the record.

Access is NetMon's decision, made per request, never inherited from the
integration account: ``[helpdesk] min_role`` gates ticket reads,
``detail_role`` gates comments / history / attachment lists (which may hold
private notes), ``link_role`` gates link changes. A viewer can still see that
an issue is linked to ticket #4821 — the number is NetMon's fact — but not
what the ticket says.

Every handler is a plain ``def``: the adapter does blocking I/O, and FastAPI
runs sync handlers in its threadpool, away from the event loop the supervised
tasks share.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

from netmon import db
from netmon.api.deps import current_user, get_engine
from netmon.config import ROLES, Config, HelpdeskConfig
from netmon.helpdesk import (STATES, TICKET_RE, FrontlineClient, HelpdeskError,
                             created_filter, normalize_attachment, normalize_comment,
                             normalize_history, normalize_ticket)
from netmon.models.schemas import UserSession

log = logging.getLogger("netmon.api.helpdesk")

router = APIRouter(prefix="/api/helpdesk", tags=["helpdesk"])

RECORD_TYPES = ("problem", "issue", "change")
#: How long a failed lookup is remembered before it is tried again.
LOOKUP_FAIL_CACHE_S = 600
HEALTH_NAME = "helpdesk"

#: HTTP status per adapter error kind. 503 for anything that means "ask
#: again later"; 404 / 403 for answers about one ticket.
_HTTP = {"unconfigured": 503, "unavailable": 503, "auth": 503, "bad_response": 502,
         "inaccessible": 403, "not_found": 404}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None


def _err(e: HelpdeskError) -> HTTPException:
    return HTTPException(status_code=_HTTP.get(e.kind, 502),
                         detail={"kind": e.kind, "message": e.message})


def _rank(user: UserSession) -> int:
    return ROLES.index(user.role.value)


def _allowed(user: UserSession, role: str) -> bool:
    return _rank(user) >= ROLES.index(role)


def _require(user: UserSession, role: str, what: str) -> None:
    if not _allowed(user, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=f"{what} requires role {role} or higher")


def _with_state(rows: list[dict], state: int) -> list[dict]:
    """Normalise rows and fill ``is_active`` from the view that returned them.

    The export rows carry no active flag (probe 2026-10-08), but the view is
    itself the answer: state 0 returns only active tickets, state 1 only
    inactive ones. "All" leaves it unknown unless a row says.
    """
    out = []
    for r in rows:
        t = normalize_ticket(r)
        if not t:
            continue
        if t["is_active"] is None and state != STATES["all"]:
            t["is_active"] = state == STATES["active"]
        out.append(t)
    return out


# ── the service: one adapter + small caches per process ─────────────────────

class HelpdeskService:
    def __init__(self, cfg: HelpdeskConfig, engine: Engine, transport=None):
        self.cfg = cfg
        self.engine = engine
        self.client = FrontlineClient(cfg, transport=transport)
        self._lock = threading.Lock()
        self._lists: dict[tuple[int, int], tuple[float, int, list[dict]]] = {}
        self._lookups: dict[str, tuple[float, list[dict], str | None]] = {}
        self._health_state: tuple[str, float] | None = None

    # -- health: the nav's source pill -------------------------------------

    def _health(self, ok: bool, message: str = "") -> None:
        """Throttled collector_health write: on a change of state, else once a
        minute, so a busy Tickets page is not a write per click."""
        state = "ok" if ok else "error"
        now = time.time()
        if self._health_state and self._health_state[0] == state and now - self._health_state[1] < 60:
            return
        self._health_state = (state, now)
        values: dict[str, Any] = {"updated_at": _now(), "last_start": _now()}
        if ok:
            values.update(last_success=_now(), consecutive_failures=0, last_error=None,
                          duration_ms=0, records_written=0)
        else:
            values.update(last_error=message[:2000],
                          consecutive_failures=self.client._failures or 1, duration_ms=0)
        try:
            db.upsert(self.engine, "collector_health", {"name": HEALTH_NAME}, values)
        except Exception:  # health is advisory; never fail a read over it
            log.warning("helpdesk: could not record collector_health")

    def call(self, fn, *args):
        try:
            out = fn(*args)
        except HelpdeskError as e:
            if e.kind in ("unavailable", "auth", "unconfigured"):
                self._health(False, e.message)
            raise
        self._health(True)
        return out

    # -- lists ---------------------------------------------------------------

    def ticket_list(self, state: int, days: int, *, force: bool = False):
        """(fetched_at, total, rows, stale_error). Bounded: Active is the live
        queue; Inactive / All carry a createdDate window. Reused for
        list_cache_s; on failure the last good list is served, marked stale."""
        key = (state, 0 if state == STATES["active"] else days)
        with self._lock:
            hit = self._lists.get(key)
        if hit and not force and time.time() - hit[0] < self.cfg.list_cache_s:
            return hit[0], hit[1], hit[2], None
        filt = None if state == STATES["active"] else created_filter(days)
        try:
            total, rows = self.call(self.client.ticket_grid, state, filt)
        except HelpdeskError as e:
            if hit:
                return hit[0], hit[1], hit[2], e
            raise
        tickets = _with_state(rows, state)
        fetched = time.time()
        with self._lock:
            self._lists[key] = (fetched, total, tickets)
        self._refresh_cache(tickets)
        return fetched, total, tickets, None

    def ticket_page(self, state: int, days: int, page: int, count: int, direction: str,
                    *, force: bool = False):
        """Server-paged variant for plain browsing (no search, no filters,
        newest/oldest first). Same caching and stale-on-outage rules."""
        key = ("page", state, 0 if state == STATES["active"] else days, page, count, direction)
        with self._lock:
            hit = self._lists.get(key)
        if hit and not force and time.time() - hit[0] < self.cfg.list_cache_s:
            return hit[0], hit[1], hit[2], None
        filt = None if state == STATES["active"] else created_filter(days)
        try:
            total, rows = self.call(self.client.ticket_page, state, filt, page, count, direction)
        except HelpdeskError as e:
            if hit:
                return hit[0], hit[1], hit[2], e
            raise
        tickets = _with_state(rows, state)
        fetched = time.time()
        with self._lock:
            self._lists[key] = (fetched, total, tickets)
        self._refresh_cache(tickets)
        return fetched, total, tickets, None

    def find_in_lists(self, ref: str) -> dict | None:
        with self._lock:
            lists = list(self._lists.values())
        for _, _, rows in lists:
            for t in rows:
                if t["ticket"] == ref:
                    return t
        return None

    def invalidate(self) -> None:
        with self._lock:
            self._lists.clear()

    # -- lookups -------------------------------------------------------------

    def lookup(self, name: str) -> tuple[list[dict], str | None]:
        fns = {"statuses": self.client.statuses, "priorities": self.client.priorities,
               "sites": self.client.sites, "categories": self.client.categories,
               "technicians": self.client.technicians}
        with self._lock:
            hit = self._lookups.get(name)
        if hit and time.time() - hit[0] < (self.cfg.lookup_cache_s if hit[2] is None
                                           else LOOKUP_FAIL_CACHE_S):
            return hit[1], hit[2]
        try:
            items = self.call(fns[name])
        except HelpdeskError as e:
            # Remember a refusal too. On this instance the integration account
            # gets 403 for statuses/priorities/sites and 404 for categories
            # (probe 2026-10-08); asking again on every page load would only
            # add four failing calls per visit.
            items = hit[1] if hit else []
            with self._lock:
                self._lookups[name] = (time.time(), items, e.message)
            return items, e.message
        with self._lock:
            self._lookups[name] = (time.time(), items, None)
        return items, None

    # -- detail --------------------------------------------------------------

    def ticket(self, ref: str) -> tuple[dict, str]:
        """(ticket, source). The documented detail route is source-only in the
        workbook; if this build answers it with an unknown-route / bad shape,
        fall back to the row from a list the help desk did return."""
        try:
            row = self.call(self.client.ticket, ref)
            t = normalize_ticket(row, with_description=True)
            if t is None:
                raise HelpdeskError("bad_response", "ticket: no ticket identifier in response")
            self._cache_state(ref, "ok", t)
            return t, "detail"
        except HelpdeskError as e:
            if e.kind in ("not_found", "inaccessible"):
                self._cache_state(ref, e.kind)
                raise
            fallback = self.find_in_lists(ref)
            if e.kind == "bad_response" and fallback:
                return dict(fallback, description=None), "list"
            raise

    # -- the thin cache of LINKED tickets -----------------------------------

    def _linked_refs(self) -> set[str]:
        return {r["ticket_ref"] for r in db.fetch_all(
            self.engine, "SELECT DISTINCT ticket_ref FROM helpdesk_links WHERE instance = :i",
            {"i": self.cfg.instance})}

    def _refresh_cache(self, tickets: list[dict]) -> None:
        try:
            linked = self._linked_refs()
            for t in tickets:
                if t["ticket"] in linked:
                    self._cache_state(t["ticket"], "ok", t, checked=False)
        except Exception:
            log.warning("helpdesk: summary cache refresh failed")

    def _cache_state(self, ref: str, state: str, t: dict | None = None,
                     checked: bool = True) -> None:
        """Write the summary for a linked ticket. Unlinked tickets are never
        stored: the cache exists to make links readable, nothing else."""
        if not db.fetch_one(self.engine, "SELECT id FROM helpdesk_links "
                            "WHERE instance = :i AND ticket_ref = :t LIMIT 1",
                            {"i": self.cfg.instance, "t": ref}):
            return
        values: dict[str, Any] = {"state": state, "checked_at": _now()}
        if t is not None:
            values.update(
                subject=t.get("subject"), status=t.get("status"), priority=t.get("priority"),
                site=t.get("site"), category=t.get("category"),
                assigned_to=t.get("assigned_to"), created_date=t.get("created"),
                updated_date=t.get("updated"),
                is_active=None if t.get("is_active") is None else int(t["is_active"]),
                fetched_at=_now())
        db.upsert(self.engine, "helpdesk_ticket_cache",
                  {"instance": self.cfg.instance, "ticket_ref": ref}, values)


def _svc(request: Request, engine: Engine) -> HelpdeskService:
    cfg: Config = request.app.state.config
    if not cfg.helpdesk.enabled:
        raise HTTPException(status_code=404, detail={
            "kind": "disabled", "message": "the help desk integration is not enabled"})
    svc = getattr(request.app.state, "helpdesk", None)
    if svc is None:
        svc = HelpdeskService(cfg.helpdesk, engine,
                              transport=getattr(request.app.state, "helpdesk_transport", None))
        request.app.state.helpdesk = svc
    return svc


def _hdcfg(request: Request) -> HelpdeskConfig:
    return request.app.state.config.helpdesk


def _ticket_url(cfg: HelpdeskConfig, ref: str) -> str | None:
    return cfg.ticket_url_template.replace("{ticket}", ref) if cfg.ticket_url_template else None


def _check_ref(ref: str) -> str:
    ref = (ref or "").strip().lstrip("#")
    if not TICKET_RE.match(ref):
        raise HTTPException(status_code=422, detail="not a valid ticket number")
    return ref


# ── status & lookups ─────────────────────────────────────────────────────────

@router.get("/status")
def helpdesk_status(request: Request, engine: Engine = Depends(get_engine),
                    user: UserSession = Depends(current_user)) -> dict:
    """What the integration can do for *this* user right now. Always 200, so
    pages can decide what to show without treating "off" as an error."""
    cfg = _hdcfg(request)
    out = {
        "enabled": cfg.enabled,
        "instance": cfg.instance,
        "can_read": _allowed(user, cfg.min_role),
        "can_read_detail": _allowed(user, cfg.detail_role),
        "can_link": _allowed(user, cfg.link_role) and _allowed(user, cfg.min_role),
        "min_role": cfg.min_role,
        "detail_role": cfg.detail_role,
        "ticket_url": bool(cfg.ticket_url_template),
        "window_days": cfg.window_days,
        "max_window_days": cfg.max_window_days,
        "list_cache_s": cfg.list_cache_s,
        # Ticket mutations are not wrapped by the adapter (spec 25 §9).
        "supports": {"edit": False, "reply": False, "create": False, "upload": False},
    }
    if cfg.enabled:
        svc = _svc(request, engine)
        st = svc.client.status()
        out["health"] = {
            "configured": st["configured"],
            "available": st["configured"] and st["backoff_s"] == 0,
            "backoff_s": st["backoff_s"],
            "last_ok": _iso(svc.client.last_ok),
            "last_error": st["last_error"],
        }
    return out


@router.get("/lookups")
def helpdesk_lookups(request: Request, engine: Engine = Depends(get_engine),
                     user: UserSession = Depends(current_user)) -> dict:
    cfg = _hdcfg(request)
    _require(user, cfg.min_role, "reading help desk tickets")
    svc = _svc(request, engine)
    out = {}
    for name in ("statuses", "priorities", "sites", "categories", "technicians"):
        items, error = svc.lookup(name)
        out[name] = {"items": items, "error": error}
    return out


# ── tickets ──────────────────────────────────────────────────────────────────

def _matches(t: dict, q: str | None, status_: str | None, priority: str | None,
             site: str | None, assigned: str | None) -> bool:
    if q:
        needle = q.lower().lstrip("#")
        hay = " ".join(str(t.get(k) or "") for k in
                       ("ticket", "subject", "site", "room", "category", "assigned_to")).lower()
        if needle not in hay:
            return False
    for want, id_key, name_key in ((status_, "status_id", "status"),
                                   (priority, "priority_id", "priority"),
                                   (site, "site_id", "site"),
                                   (assigned, "assigned_id", "assigned_to")):
        if want and want not in (t.get(id_key), t.get(name_key)):
            return False
    return True


@router.get("/tickets")
def list_tickets(
    request: Request,
    view: str = Query(default="active", pattern="^(active|inactive|all)$"),
    q: str | None = Query(default=None, max_length=200),
    status_: str | None = Query(default=None, alias="status", max_length=100),
    priority: str | None = Query(default=None, max_length=100),
    site: str | None = Query(default=None, max_length=200),
    assigned: str | None = Query(default=None, max_length=200),
    days: int | None = Query(default=None, ge=1),
    sort: str = Query(default="created", pattern="^(created|updated|ticket|priority)$"),
    direction: str = Query(default="desc", alias="dir", pattern="^(asc|desc)$"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    refresh: bool = False,
    engine: Engine = Depends(get_engine),
    user: UserSession = Depends(current_user),
) -> dict:
    cfg = _hdcfg(request)
    _require(user, cfg.min_role, "reading help desk tickets")
    svc = _svc(request, engine)
    window = min(days or cfg.window_days, cfg.max_window_days)
    # Plain browsing — no search, no filter, ordered by created date — uses the
    # help desk's own paging and sort (validated 2026-10-08), so a page costs
    # one page. Anything filtered falls back to the bounded window, filtered by
    # NetMon, because no Kendo filter other than createdDate is validated.
    if (not any((q, status_, priority, site, assigned)) and sort == "created"
            and offset % limit == 0):
        try:
            fetched, total, rows, stale = svc.ticket_page(
                STATES[view], window, offset // limit, limit, direction, force=refresh)
        except HelpdeskError as e:
            raise _err(e)
        return {
            "view": view, "window_days": None if view == "active" else window,
            "items": rows, "total": total, "total_source": total, "offset": offset,
            "limit": limit, "fetched_at": _iso(fetched), "paging": "server",
            "stale": stale is not None,
            "error": ({"kind": stale.kind, "message": stale.message} if stale else None),
        }
    try:
        fetched, total_source, rows, stale = svc.ticket_list(STATES[view], window, force=refresh)
    except HelpdeskError as e:
        raise _err(e)
    hits = [t for t in rows if _matches(t, q, status_, priority, site, assigned)]
    key = {"created": "created", "updated": "updated", "ticket": "ticket",
           "priority": "priority"}[sort]
    # Sorting is NetMon-side: the vendor sort descriptor is unvalidated (spec
    # 25 §5). Missing values sort last either way.
    present = [t for t in hits if t.get(key)]
    missing = [t for t in hits if not t.get(key)]
    if key == "ticket":
        present.sort(key=lambda t: (len(t["ticket"]), t["ticket"]), reverse=direction == "desc")
    else:
        present.sort(key=lambda t: str(t[key]), reverse=direction == "desc")
    hits = present + missing
    return {
        "view": view,
        "window_days": None if view == "active" else window,
        "items": hits[offset:offset + limit],
        "total": len(hits),
        "total_source": total_source,
        "offset": offset,
        "limit": limit,
        "fetched_at": _iso(fetched),
        "paging": "netmon",
        "stale": stale is not None,
        "error": ({"kind": stale.kind, "message": stale.message} if stale else None),
    }


@router.get("/tickets/{ref}")
def get_ticket(ref: str, request: Request, refresh: bool = False,
               engine: Engine = Depends(get_engine),
               user: UserSession = Depends(current_user)) -> dict:
    cfg = _hdcfg(request)
    _require(user, cfg.min_role, "reading help desk tickets")
    ref = _check_ref(ref)
    svc = _svc(request, engine)
    if refresh:
        svc.invalidate()
    try:
        ticket, source = svc.ticket(ref)
    except HelpdeskError as e:
        raise _err(e)
    return {
        "ticket": ticket,
        "source": source,
        "fetched_at": _iso(time.time()),
        "url": _ticket_url(cfg, ref),
        "links": _links_for_ticket(engine, cfg, ref),
    }


def _detail_call(request: Request, engine: Engine, user: UserSession, ref: str,
                 method: str, norm) -> dict:
    cfg = _hdcfg(request)
    _require(user, cfg.min_role, "reading help desk tickets")
    _require(user, cfg.detail_role, "reading ticket comments, history and attachments")
    ref = _check_ref(ref)
    svc = _svc(request, engine)
    try:
        rows = svc.call(getattr(svc.client, method), ref)
    except HelpdeskError as e:
        raise _err(e)
    return {"items": [norm(r) for r in rows], "fetched_at": _iso(time.time()),
            "url": _ticket_url(cfg, ref)}


@router.get("/tickets/{ref}/comments")
def ticket_comments(ref: str, request: Request, engine: Engine = Depends(get_engine),
                    user: UserSession = Depends(current_user)) -> dict:
    out = _detail_call(request, engine, user, ref, "comments", normalize_comment)
    # Visibility is shown only when the response states it. None ≠ public.
    out["visibility_known"] = any(c["private"] is not None for c in out["items"])
    return out


@router.get("/tickets/{ref}/history")
def ticket_history(ref: str, request: Request, engine: Engine = Depends(get_engine),
                   user: UserSession = Depends(current_user)) -> dict:
    return _detail_call(request, engine, user, ref, "history", normalize_history)


@router.get("/tickets/{ref}/attachments")
def ticket_attachments(ref: str, request: Request, engine: Engine = Depends(get_engine),
                       user: UserSession = Depends(current_user)) -> dict:
    """Metadata only. Downloads go through the help desk itself until an
    authorised download path is validated (spec 25 §7)."""
    return _detail_call(request, engine, user, ref, "attachments", normalize_attachment)


# ── local records (problem / issue / change) ────────────────────────────────

def _record(engine: Engine, rtype: str, rid: int) -> dict | None:
    """Uniform summary of a NetMon record, or None if it does not exist."""
    if rtype == "problem":
        r = db.fetch_one(engine, """
            SELECT a.id, r.name AS title, d.name AS device, d.site AS site, r.severity,
                   a.opened_at, a.closed_at
              FROM alerts a JOIN alert_rules r ON r.id = a.rule_id
              LEFT JOIN devices d ON d.id = a.device_id WHERE a.id = :i""", {"i": rid})
        if not r:
            return None
        return {"type": "problem", "id": r["id"],
                "title": f"{r['title']}" + (f" — {r['device']}" if r["device"] else ""),
                "status": "closed" if r["closed_at"] else "open",
                "severity": r["severity"], "site": r["site"],
                "created": r["opened_at"], "updated": r["closed_at"] or r["opened_at"],
                "href": f"#/problems/{r['id']}"}
    if rtype == "issue":
        r = db.fetch_one(engine, "SELECT id, title, status, severity, site, created_at, "
                         "updated_at FROM issues WHERE id = :i", {"i": rid})
        if not r:
            return None
        return {"type": "issue", "id": r["id"], "title": r["title"], "status": r["status"],
                "severity": r["severity"], "site": r["site"], "created": r["created_at"],
                "updated": r["updated_at"], "href": f"#/issues/{r['id']}"}
    if rtype == "change":
        r = db.fetch_one(engine, "SELECT id, title, status, verdict, site, proposed_at, "
                         "updated_at FROM changes WHERE id = :i", {"i": rid})
        if not r:
            return None
        return {"type": "change", "id": r["id"], "title": r["title"], "status": r["status"],
                "verdict": r["verdict"], "site": r["site"], "created": r["proposed_at"],
                "updated": r["updated_at"], "href": f"#/changes/{r['id']}"}
    return None


@router.get("/candidates")
def search_records(
    record_type: str = Query(alias="type", pattern="^(problem|issue|change)$"),
    q: str = Query(default="", max_length=200),
    limit: int = Query(default=25, ge=1, le=100),
    engine: Engine = Depends(get_engine),
    _user: UserSession = Depends(current_user),
) -> list[dict]:
    """Local records for the "Link existing" dialog: id, title, status,
    location and dates — enough to pick the right one."""
    like = f"%{q.strip()}%"
    exact = int(q.strip().lstrip("#")) if q.strip().lstrip("#").isdigit() else -1
    if record_type == "problem":
        rows = db.fetch_all(engine, """
            SELECT a.id FROM alerts a JOIN alert_rules r ON r.id = a.rule_id
              LEFT JOIN devices d ON d.id = a.device_id
             WHERE a.id = :x OR r.name LIKE :q OR d.name LIKE :q OR d.site LIKE :q
             ORDER BY a.closed_at IS NOT NULL, a.opened_at DESC LIMIT :n""",
            {"x": exact, "q": like, "n": limit})
    elif record_type == "issue":
        rows = db.fetch_all(engine, """
            SELECT id FROM issues WHERE id = :x OR title LIKE :q OR site LIKE :q
             ORDER BY updated_at DESC LIMIT :n""", {"x": exact, "q": like, "n": limit})
    else:
        rows = db.fetch_all(engine, """
            SELECT id FROM changes WHERE id = :x OR title LIKE :q OR site LIKE :q
             ORDER BY updated_at DESC LIMIT :n""", {"x": exact, "q": like, "n": limit})
    return [r for r in (_record(engine, record_type, row["id"]) for row in rows) if r]


# ── links ────────────────────────────────────────────────────────────────────

class LinkCreate(BaseModel):
    ticket: str = Field(min_length=1, max_length=64)
    record_type: str
    record_id: int = Field(ge=1)
    note: str | None = Field(default=None, max_length=500)


def _cache_row(engine: Engine, cfg: HelpdeskConfig, ref: str) -> dict | None:
    r = db.fetch_one(engine, "SELECT * FROM helpdesk_ticket_cache "
                     "WHERE instance = :i AND ticket_ref = :t", {"i": cfg.instance, "t": ref})
    return dict(r) if r else None


def _ticket_summary(engine: Engine, cfg: HelpdeskConfig, ref: str, show: bool) -> dict:
    """What a link can say about its ticket without calling the help desk."""
    out: dict[str, Any] = {"ticket": ref, "url": _ticket_url(cfg, ref)}
    c = _cache_row(engine, cfg, ref)
    if c is None:
        out["state"] = "unknown"
        return out
    out["state"] = c["state"]
    out["fetched_at"] = c["fetched_at"]
    out["checked_at"] = c["checked_at"]
    if show:
        out.update(subject=c["subject"], status=c["status"], priority=c["priority"],
                   site=c["site"], category=c["category"], assigned_to=c["assigned_to"],
                   created=c["created_date"], updated=c["updated_date"],
                   is_active=None if c["is_active"] is None else bool(c["is_active"]))
    return out


def _links_for_ticket(engine: Engine, cfg: HelpdeskConfig, ref: str) -> list[dict]:
    out = []
    for r in db.fetch_all(engine, "SELECT * FROM helpdesk_links WHERE instance = :i "
                          "AND ticket_ref = :t ORDER BY record_type, created_at",
                          {"i": cfg.instance, "t": ref}):
        r = dict(r)
        rec = _record(engine, r["record_type"], r["record_id"])
        r["record"] = rec
        r["record_exists"] = rec is not None
        out.append(r)
    return out


def _audit(engine: Engine, cfg: HelpdeskConfig, ref: str, rtype: str, rid: int,
           action: str, actor: str, note: str | None) -> None:
    db.execute(engine, """
        INSERT INTO helpdesk_link_events (instance, ticket_ref, record_type, record_id,
                                          action, actor, note, occurred_at)
        VALUES (:i, :t, :rt, :ri, :a, :u, :n, :at)""",
        {"i": cfg.instance, "t": ref, "rt": rtype, "ri": rid, "a": action, "u": actor,
         "n": note, "at": _now()})
    # Issues have a timeline; the link belongs on it, attributed. Problems and
    # changes have none of their own, so helpdesk_link_events is their trail.
    if rtype == "issue" and db.fetch_one(engine, "SELECT id FROM issues WHERE id = :i",
                                         {"i": rid}):
        verb = "Linked" if action == "link" else "Unlinked"
        db.execute(engine, """
            INSERT INTO issue_comments (issue_id, kind, body, author, created_at)
            VALUES (:i, 'status_change', :b, :a, :t)""",
            {"i": rid, "b": f"{verb} help desk ticket #{ref}" + (f" — {note}" if note else ""),
             "a": actor, "t": _now()})


@router.get("/links")
def list_links(
    request: Request,
    record_type: str | None = Query(default=None, pattern="^(problem|issue|change)$"),
    record_id: int | None = None,
    ticket: str | None = None,
    engine: Engine = Depends(get_engine),
    user: UserSession = Depends(current_user),
) -> dict:
    """Links for one record or one ticket. Local only — works with the help
    desk down. Ticket summaries come from the thin cache and only for roles
    that may read tickets."""
    cfg = _hdcfg(request)
    show = _allowed(user, cfg.min_role)
    if ticket is not None:
        ref = _check_ref(ticket)
        return {"links": _links_for_ticket(engine, cfg, ref),
                "ticket": _ticket_summary(engine, cfg, ref, show)}
    if record_type is None or record_id is None:
        raise HTTPException(status_code=422, detail="give record_type + record_id, or ticket")
    rows = db.fetch_all(engine, "SELECT * FROM helpdesk_links WHERE record_type = :rt "
                        "AND record_id = :ri AND instance = :i ORDER BY created_at",
                        {"rt": record_type, "ri": record_id, "i": cfg.instance})
    links = []
    for r in rows:
        r = dict(r)
        r["ticket_summary"] = _ticket_summary(engine, cfg, r["ticket_ref"], show)
        links.append(r)
    events = [dict(e) for e in db.fetch_all(
        engine, "SELECT * FROM helpdesk_link_events WHERE record_type = :rt "
        "AND record_id = :ri ORDER BY occurred_at DESC, id DESC LIMIT 50",
        {"rt": record_type, "ri": record_id})]
    return {"links": links, "events": events,
            "record": _record(engine, record_type, record_id)}


@router.post("/links", status_code=status.HTTP_201_CREATED)
def create_link(body: LinkCreate, request: Request, engine: Engine = Depends(get_engine),
                user: UserSession = Depends(current_user)) -> dict:
    cfg = _hdcfg(request)
    _require(user, cfg.link_role, "linking help desk tickets")
    _require(user, cfg.min_role, "linking help desk tickets")
    if body.record_type not in RECORD_TYPES:
        raise HTTPException(status_code=422, detail=f"record_type must be one of {RECORD_TYPES}")
    ref = _check_ref(body.ticket)
    if _record(engine, body.record_type, body.record_id) is None:
        raise HTTPException(status_code=404,
                            detail=f"{body.record_type} {body.record_id} does not exist")

    existing = db.fetch_one(engine, """
        SELECT * FROM helpdesk_links WHERE instance = :i AND ticket_ref = :t
           AND record_type = :rt AND record_id = :ri""",
        {"i": cfg.instance, "t": ref, "rt": body.record_type, "ri": body.record_id})
    if existing:
        raise HTTPException(status_code=409, detail={
            "message": f"ticket #{ref} is already linked to this {body.record_type}",
            "link": dict(existing)})

    # The ticket must exist as far as the help desk can tell. Linking a
    # mistyped number would make a link that can never resolve.
    svc = _svc(request, engine)
    try:
        ticket, _ = svc.ticket(ref)
    except HelpdeskError as e:
        if e.kind == "not_found":
            raise HTTPException(status_code=404, detail={
                "kind": "not_found", "message": f"the help desk has no ticket #{ref} "
                "(or it is outside the integration's visibility)"})
        raise _err(e)

    note = (body.note or "").strip() or None
    try:
        db.execute(engine, """
            INSERT INTO helpdesk_links (instance, ticket_ref, record_type, record_id, note,
                                        created_at, created_by)
            VALUES (:i, :t, :rt, :ri, :n, :at, :u)""",
            {"i": cfg.instance, "t": ref, "rt": body.record_type, "ri": body.record_id,
             "n": note, "at": _now(), "u": user.username})
    except IntegrityError:
        # Lost a race with an identical request — the uniqueness constraint
        # is the final word, and the answer is the same as the pre-check's.
        raise HTTPException(status_code=409, detail={
            "message": f"ticket #{ref} is already linked to this {body.record_type}"})
    _audit(engine, cfg, ref, body.record_type, body.record_id, "link", user.username, note)
    svc._cache_state(ref, "ok", ticket)
    link = db.fetch_one(engine, """
        SELECT * FROM helpdesk_links WHERE instance = :i AND ticket_ref = :t
           AND record_type = :rt AND record_id = :ri""",
        {"i": cfg.instance, "t": ref, "rt": body.record_type, "ri": body.record_id})
    out = dict(link)
    out["record"] = _record(engine, body.record_type, body.record_id)
    out["ticket_summary"] = _ticket_summary(engine, cfg, ref, True)
    return out


@router.delete("/links/{link_id}")
def delete_link(link_id: int, request: Request, engine: Engine = Depends(get_engine),
                user: UserSession = Depends(current_user)) -> dict:
    """Remove NetMon's relationship only. The ticket and the record are not
    touched — nothing is sent to the help desk, nothing local is deleted."""
    cfg = _hdcfg(request)
    _require(user, cfg.link_role, "unlinking help desk tickets")
    link = db.fetch_one(engine, "SELECT * FROM helpdesk_links WHERE id = :i", {"i": link_id})
    if not link:
        raise HTTPException(status_code=404, detail="link not found")
    db.execute(engine, "DELETE FROM helpdesk_links WHERE id = :i", {"i": link_id})
    _audit(engine, cfg, link["ticket_ref"], link["record_type"], link["record_id"],
           "unlink", user.username, None)
    # Drop the summary once nothing links to the ticket — the cache holds
    # linked tickets only.
    if not db.fetch_one(engine, "SELECT id FROM helpdesk_links WHERE instance = :i AND "
                        "ticket_ref = :t LIMIT 1", {"i": link["instance"], "t": link["ticket_ref"]}):
        db.execute(engine, "DELETE FROM helpdesk_ticket_cache WHERE instance = :i "
                   "AND ticket_ref = :t", {"i": link["instance"], "t": link["ticket_ref"]})
    return {"deleted": link_id}


@router.post("/links/{link_id}/refresh")
def refresh_link(link_id: int, request: Request, engine: Engine = Depends(get_engine),
                 user: UserSession = Depends(current_user)) -> dict:
    """Re-check one linked ticket against the help desk and update its
    summary/state. A failure leaves the link exactly as it was."""
    cfg = _hdcfg(request)
    _require(user, cfg.min_role, "reading help desk tickets")
    link = db.fetch_one(engine, "SELECT * FROM helpdesk_links WHERE id = :i", {"i": link_id})
    if not link:
        raise HTTPException(status_code=404, detail="link not found")
    svc = _svc(request, engine)
    error = None
    try:
        svc.ticket(link["ticket_ref"])
    except HelpdeskError as e:
        error = {"kind": e.kind, "message": e.message}
    return {"ticket_summary": _ticket_summary(engine, cfg, link["ticket_ref"], True),
            "error": error}
