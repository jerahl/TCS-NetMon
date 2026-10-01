"""Issue tracker API — human-authored problem records (docs/spec/24).

The one part of NetMon a person writes rather than a collector. Everything else
in `api/` reports what a source or a sweep observed; these routes record what
somebody found out, what they plan to do about it, and the evidence.

Two decisions run through the whole file:

**Uploads are raw-body PUTs, not multipart.** Parsing multipart needs
`python-multipart`, a dependency this project has not taken (CLAUDE.md §3), and
there is nothing to gain: one file per request, its name already in the path.
`camera_ops.upload_firmware` made the same call for the same reason.

**The content type is NetMon's decision, never the client's.** These files are
served back to a browser, and a caller-supplied Content-Type is a stored-XSS
primitive. Every upload is sniffed, cross-checked against its extension, and
stored with the type NetMon decided; the download route echoes only that.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import current_user, get_config, get_engine
from netmon.config import ROLES, Config
from netmon.models.schemas import UserSession

log = logging.getLogger("netmon.api.issues")

router = APIRouter(prefix="/api/issues", tags=["issues"])


# ── vocabulary ───────────────────────────────────────────────────────────────

#: Six states, and each earns its place (spec 24 §3). `waiting` means waiting on
#: somebody else — a vendor, a school, an approval — and without it those issues
#: read as untouched. `planned` means the fix is agreed and scheduled but not
#: applied, which is where most of a remediation plan actually sits.
STATUSES = ("open", "investigating", "waiting", "planned", "resolved", "closed")

#: The project's severity words minus `ok` — an issue is never "ok" — so the
#: existing Dot/SevText primitives render these with no second colour scheme.
SEVERITIES = ("crit", "warn", "info")

#: Suggested, not enforced. The set will be wrong within a year and a migration
#: to add `power` would be silly.
CATEGORIES = ("wireless", "switching", "surveillance", "voip", "nac",
              "facilities", "other")

#: Statuses that mean "nobody is working on this any more". `status=open` in a
#: query is shorthand for everything outside this set.
_DONE = ("resolved", "closed")


# ── attachment types ─────────────────────────────────────────────────────────

#: extension → (content type, leading-bytes test). The type NetMon will serve
#: the file as, and the check that the bytes agree with the name.
#:
#: A closed allow-list rather than `mimetypes.guess_type`: this decides a header
#: sent to a browser, and the set of things worth attaching to a network problem
#: is small and knowable. Anything not here is refused at upload with a message
#: naming what is accepted — which is friendlier than storing it and refusing to
#: show it later.
def _png(b: bytes) -> bool: return b.startswith(b"\x89PNG\r\n\x1a\n")
def _jpeg(b: bytes) -> bool: return b.startswith(b"\xff\xd8\xff")
def _gif(b: bytes) -> bool: return b.startswith((b"GIF87a", b"GIF89a"))
def _webp(b: bytes) -> bool: return b[:4] == b"RIFF" and b[8:12] == b"WEBP"
def _pdf(b: bytes) -> bool: return b.startswith(b"%PDF-")
def _zip(b: bytes) -> bool: return b.startswith(b"PK\x03\x04")
def _pcap(b: bytes) -> bool:
    # libpcap in either byte order, plus pcapng's Section Header Block.
    return b[:4] in (b"\xd4\xc3\xb2\xa1", b"\xa1\xb2\xc3\xd4",
                     b"\x4d\x3c\xb2\xa1", b"\xa1\xb2\x3c\x4d",
                     b"\x0a\x0d\x0d\x0a")
def _svg(b: bytes) -> bool:
    head = b[:512].lstrip()
    return head.startswith(b"<?xml") or head.startswith(b"<svg")
def _text(b: bytes) -> bool:
    # No NUL in the first block, and it decodes as UTF-8. Good enough to keep a
    # renamed binary out of a .log, which is all this check is for.
    if b"\x00" in b:
        return False
    try:
        b.decode("utf-8")
    except UnicodeDecodeError:
        # A truncated multi-byte sequence at the block boundary is fine.
        try:
            b[:-3].decode("utf-8")
        except UnicodeDecodeError:
            return False
    return True


ACCEPTED: dict[str, tuple[str, object]] = {
    "png": ("image/png", _png),
    "jpg": ("image/jpeg", _jpeg),
    "jpeg": ("image/jpeg", _jpeg),
    "gif": ("image/gif", _gif),
    "webp": ("image/webp", _webp),
    "svg": ("image/svg+xml", _svg),
    "pdf": ("application/pdf", _pdf),
    "txt": ("text/plain", _text),
    "log": ("text/plain", _text),
    # Handoff notes and investigation write-ups arrive as Markdown more often
    # than as anything else. Served as text/markdown and NOT on the inline
    # list: browsers disagree about whether to render or download it, and a
    # download is the predictable answer.
    "md": ("text/markdown", _text),
    "csv": ("text/csv", _text),
    "json": ("application/json", _text),
    "conf": ("text/plain", _text),
    "cfg": ("text/plain", _text),
    "pcap": ("application/vnd.tcpdump.pcap", _pcap),
    "pcapng": ("application/vnd.tcpdump.pcap", _pcap),
    "zip": ("application/zip", _zip),
}

#: Types the browser may render in place. Everything else downloads.
#:
#: SVG is NOT here, and the omission is the point: an SVG is a script host,
#: NetMon does not sanitize it, and `[issues] allow_viewer_reports` means any
#: signed-in account can upload one. Rendered inline that is stored XSS; as a
#: download it is a file. It is accepted because network diagrams are SVGs.
INLINE_OK = ("image/png", "image/jpeg", "image/gif", "image/webp",
             "application/pdf", "text/plain")

_SAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_name(raw: str) -> str:
    """Reduce a client filename to something safe to put on disk.

    Basename only, no separators, no leading dot, length-capped. The result is
    never trusted alone — it is prefixed with the attachment's own id — but a
    name that cannot traverse is one less thing to reason about.
    """
    name = _SAFE_CHARS.sub("_", os.path.basename(raw.strip()))
    name = name.lstrip(".") or "attachment"
    return name[:120]


def _ext(name: str) -> str:
    _, _, ext = name.rpartition(".")
    return ext.lower() if ext and ext != name else ""


# ── helpers ──────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def _cfg(request: Request) -> Config:
    return get_config(request)


def _refused(message: str) -> HTTPException:
    """409, the shape the rest of the write API uses for a refusal a human
    caused and a human can fix — as distinct from a 400 shape mismatch."""
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def _at_least(user: UserSession, minimum: str) -> bool:
    return ROLES.index(user.role.value) >= ROLES.index(minimum)


def _require_enabled(cfg: Config) -> None:
    if not cfg.issues.enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="the issue tracker is disabled ([issues] enabled)")


def _may_report(cfg: Config, user: UserSession) -> bool:
    """Who may open an issue, comment, or attach a file (spec 24 §5).

    The deliberate departure from the rest of the API, where `viewer` is
    read-only. Confined to these four tables and the attachment directory, and
    switchable without a deploy.
    """
    if _at_least(user, "operator"):
        return True
    return bool(cfg.issues.allow_viewer_reports)


def _require_report(cfg: Config, user: UserSession) -> None:
    if not _may_report(cfg, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="filing issues is limited to operators "
                   "([issues] allow_viewer_reports is off)")


def _require_triage(user: UserSession) -> None:
    if not _at_least(user, "operator"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="changing status, severity, assignee or device links requires "
                   "the operator role — add a comment instead and an operator "
                   "will triage it")


def _require_admin(user: UserSession) -> None:
    if not _at_least(user, "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="requires role admin or higher")


def _issue_dir(cfg: Config, issue_id: int) -> Path:
    return Path(cfg.issues.attachment_dir) / str(int(issue_id))


def _get_issue(engine: Engine, issue_id: int) -> dict:
    row = db.fetch_one(engine, "SELECT * FROM issues WHERE id = :id", {"id": issue_id})
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail=f"issue {issue_id} not found")
    return dict(row)


def _detail(engine: Engine, issue_id: int) -> dict:
    """Issue + devices + comments + attachments, in one response.

    The detail page is one round-trip on purpose: four sequential fetches to
    paint one issue is the kind of thing that makes a page feel slow for no
    reason a user can see.
    """
    issue = _get_issue(engine, issue_id)

    links = db.fetch_all(engine, """
        SELECT il.device_id, il.note, d.name, d.site, d.device_type
          FROM issue_devices il
          LEFT JOIN devices d ON d.id = il.device_id
         WHERE il.issue_id = :id
         ORDER BY d.name IS NULL, d.name
    """, {"id": issue_id})
    devices = []
    for r in links:
        r = dict(r)
        devices.append({
            "device_id": r["device_id"],
            # A device that left the registry keeps its link — see migration
            # 036 — so the row has to render without a join result.
            "name": r["name"] or f"device {r['device_id']}, no longer registered",
            "registered": r["name"] is not None,
            "site": r["site"],
            "device_type": r["device_type"],
            "note": r["note"],
        })

    comments = [dict(r) for r in db.fetch_all(engine, """
        SELECT id, issue_id, kind, body, author, created_at, edited_at
          FROM issue_comments WHERE issue_id = :id ORDER BY created_at, id
    """, {"id": issue_id})]

    attachments = [dict(r) for r in db.fetch_all(engine, """
        SELECT id, issue_id, comment_id, filename, content_type, size_bytes,
               sha256, uploaded_by, uploaded_at
          FROM issue_attachments WHERE issue_id = :id ORDER BY uploaded_at, id
    """, {"id": issue_id})]
    for a in attachments:
        a["url"] = f"/api/issues/{issue_id}/attachments/{a['id']}"
        a["inline"] = a["content_type"] in INLINE_OK
        a["is_image"] = a["content_type"].startswith("image/")

    issue["devices"] = devices
    issue["comments"] = comments
    issue["attachments"] = attachments
    return issue


def _log_entry(engine: Engine, issue_id: int, body: str, author: str) -> None:
    """Write a `status_change` entry into the thread.

    Triage lands in the same table as the conversation so the timeline is one
    ordered query, and so the reason for a change sits next to the change.
    """
    db.execute(engine, """
        INSERT INTO issue_comments (issue_id, kind, body, author, created_at)
        VALUES (:issue_id, 'status_change', :body, :author, :created_at)
    """, {"issue_id": issue_id, "body": body, "author": author, "created_at": _now()})


# ── request bodies ───────────────────────────────────────────────────────────

class IssueCreate(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    body: str = Field(default="", max_length=64000)
    severity: str = "warn"
    category: str = "other"
    site: str | None = None
    device_ids: list[int] = Field(default_factory=list)
    assigned_to: str | None = None


class IssuePatch(BaseModel):
    """Every field optional; each is role-checked individually in the route."""
    title: str | None = Field(default=None, min_length=3, max_length=200)
    body: str | None = Field(default=None, max_length=64000)
    status: str | None = None
    severity: str | None = None
    category: str | None = None
    site: str | None = None
    assigned_to: str | None = None
    device_ids: list[int] | None = None
    #: Optional note carried into the status_change entry — "waiting on the
    #: ExtremeCloud IQ support case", which is the part a reader needs.
    note: str | None = Field(default=None, max_length=1000)


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=64000)


class CommentPatch(BaseModel):
    body: str = Field(min_length=1, max_length=64000)


# ── meta ─────────────────────────────────────────────────────────────────────

@router.get("/meta")
def issues_meta(request: Request, user: UserSession = Depends(current_user)) -> dict:
    """Vocabularies, caps, and what THIS viewer may do.

    The UI asks rather than guesses: a reporter should see the status control
    disabled with a reason, not see it enabled and get a 403 after typing.
    """
    cfg = _cfg(request)
    _require_enabled(cfg)
    return {
        "statuses": list(STATUSES),
        "severities": list(SEVERITIES),
        "categories": list(CATEGORIES),
        "done_statuses": list(_DONE),
        "accepted_extensions": sorted(ACCEPTED),
        "max_attachment_mb": cfg.issues.max_attachment_mb,
        "max_attachments_per_issue": cfg.issues.max_attachments_per_issue,
        "me": user.username,
        "can": {
            "report": _may_report(cfg, user),
            "triage": _at_least(user, "operator"),
            "admin": _at_least(user, "admin"),
        },
    }


# ── list ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_issues(
    request: Request,
    status_: str | None = Query(default=None, alias="status"),
    severity: str | None = None,
    category: str | None = None,
    site: str | None = None,
    assigned_to: str | None = None,
    device_id: int | None = None,
    q: str | None = None,
    limit: int = Query(default=200, ge=1, le=1000),
    engine: Engine = Depends(get_engine),
    _user: UserSession = Depends(current_user),
) -> list[dict]:
    """Issues, newest activity first.

    `status=open` is a pseudo-filter meaning "not resolved or closed" — the
    default view, because the unfinished list is what somebody wants at 7am.
    """
    _require_enabled(_cfg(request))
    where: list[str] = []
    params: dict[str, object] = {"limit": limit}

    if status_ == "open":
        where.append("i.status NOT IN ('resolved', 'closed')")
    elif status_:
        where.append("i.status = :status")
        params["status"] = status_
    if severity:
        where.append("i.severity = :severity")
        params["severity"] = severity
    if category:
        where.append("i.category = :category")
        params["category"] = category
    if site:
        where.append("i.site = :site")
        params["site"] = site
    if assigned_to:
        where.append("i.assigned_to = :assigned_to")
        params["assigned_to"] = assigned_to
    if device_id:
        where.append("EXISTS (SELECT 1 FROM issue_devices x "
                     "WHERE x.issue_id = i.id AND x.device_id = :device_id)")
        params["device_id"] = device_id
    if q:
        # LIKE over title and body. Honest at the scale this lives at (spec 24
        # §9); FULLTEXT is the answer if it stops being, not a dependency.
        where.append("(i.title LIKE :q OR i.body LIKE :q)")
        params["q"] = f"%{q}%"

    clause = (" WHERE " + " AND ".join(where)) if where else ""
    rows = db.fetch_all(engine, f"""
        SELECT i.*,
               (SELECT COUNT(*) FROM issue_comments c
                 WHERE c.issue_id = i.id AND c.kind = 'comment') AS comment_count,
               (SELECT COUNT(*) FROM issue_attachments a
                 WHERE a.issue_id = i.id) AS attachment_count,
               (SELECT COUNT(*) FROM issue_devices x
                 WHERE x.issue_id = i.id) AS device_count
          FROM issues i{clause}
         ORDER BY i.updated_at DESC, i.id DESC
         LIMIT :limit
    """, params)
    return [dict(r) for r in rows]


@router.get("/{issue_id}")
def get_issue(issue_id: int, request: Request,
              engine: Engine = Depends(get_engine),
              _user: UserSession = Depends(current_user)) -> dict:
    _require_enabled(_cfg(request))
    return _detail(engine, issue_id)


# ── create / edit ────────────────────────────────────────────────────────────

def _validate_vocab(severity: str | None, category: str | None,
                    status_: str | None) -> None:
    if severity is not None and severity not in SEVERITIES:
        raise _refused(f"severity must be one of {', '.join(SEVERITIES)}")
    if status_ is not None and status_ not in STATUSES:
        raise _refused(f"status must be one of {', '.join(STATUSES)}")
    if category is not None and not category.strip():
        raise _refused("category cannot be blank")


def _set_devices(engine: Engine, issue_id: int, device_ids: list[int]) -> None:
    wanted = {int(d) for d in device_ids}
    db.execute(engine, "DELETE FROM issue_devices WHERE issue_id = :id",
               {"id": issue_id})
    for did in sorted(wanted):
        db.execute(engine, """
            INSERT INTO issue_devices (issue_id, device_id) VALUES (:i, :d)
        """, {"i": issue_id, "d": did})


@router.post("", status_code=status.HTTP_201_CREATED)
def create_issue(body: IssueCreate, request: Request,
                 engine: Engine = Depends(get_engine),
                 user: UserSession = Depends(current_user)) -> dict:
    cfg = _cfg(request)
    _require_enabled(cfg)
    _require_report(cfg, user)
    _validate_vocab(body.severity, body.category, None)

    # A reporter names the problem; only an operator may hand it to somebody.
    assigned = body.assigned_to if _at_least(user, "operator") else None

    now = _now()
    db.execute(engine, """
        INSERT INTO issues (title, body, status, severity, category, site,
                            reported_by, assigned_to, created_at, updated_at)
        VALUES (:title, :body, 'open', :severity, :category, :site,
                :reported_by, :assigned_to, :created_at, :updated_at)
    """, {
        "title": body.title.strip(), "body": body.body,
        "severity": body.severity, "category": body.category.strip(),
        "site": (body.site or "").strip() or None,
        "reported_by": user.username, "assigned_to": assigned,
        "created_at": now, "updated_at": now,
    })
    row = db.fetch_one(engine, """
        SELECT id FROM issues WHERE reported_by = :who AND created_at = :at
         ORDER BY id DESC LIMIT 1
    """, {"who": user.username, "at": now})
    issue_id = int(row["id"])

    if body.device_ids:
        _set_devices(engine, issue_id, body.device_ids)

    log.info("issue %d opened by %s: %s", issue_id, user.username, body.title.strip())
    return _detail(engine, issue_id)


@router.patch("/{issue_id}")
def patch_issue(issue_id: int, body: IssuePatch, request: Request,
                engine: Engine = Depends(get_engine),
                user: UserSession = Depends(current_user)) -> dict:
    """Field-by-field role check (spec 24 §5).

    Triage fields need operator; rewriting somebody else's title or body needs
    admin — an author correcting their own report is the common case and is
    allowed, but silently editing another person's account of what happened is
    not something an operator should be able to do.
    """
    cfg = _cfg(request)
    _require_enabled(cfg)
    issue = _get_issue(engine, issue_id)
    _validate_vocab(body.severity, body.category, body.status)

    triage_fields = ("status", "severity", "category", "site", "assigned_to",
                     "device_ids")
    touches_triage = any(getattr(body, f) is not None for f in triage_fields)
    if touches_triage:
        _require_triage(user)

    if (body.title is not None or body.body is not None):
        if issue["reported_by"] != user.username and not _at_least(user, "admin"):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="only the reporter or an admin may rewrite the title or "
                       "description — add a comment instead")

    sets: list[str] = []
    params: dict[str, object] = {"id": issue_id}
    entries: list[str] = []

    def put(col: str, val: object) -> None:
        sets.append(f"{col} = :{col}")
        params[col] = val

    if body.title is not None:
        put("title", body.title.strip())
    if body.body is not None:
        put("body", body.body)
    if body.severity is not None and body.severity != issue["severity"]:
        put("severity", body.severity)
        entries.append(f"severity {issue['severity']} → {body.severity}")
    if body.category is not None and body.category.strip() != issue["category"]:
        put("category", body.category.strip())
        entries.append(f"category {issue['category']} → {body.category.strip()}")
    if body.site is not None:
        new_site = body.site.strip() or None
        if new_site != issue["site"]:
            put("site", new_site)
            entries.append(f"site {issue['site'] or '—'} → {new_site or '—'}")
    if body.assigned_to is not None:
        new_assignee = body.assigned_to.strip() or None
        if new_assignee != issue["assigned_to"]:
            put("assigned_to", new_assignee)
            entries.append(
                f"assigned to {new_assignee}" if new_assignee else "unassigned")
    if body.status is not None and body.status != issue["status"]:
        put("status", body.status)
        entries.append(f"status {issue['status']} → {body.status}")
        # resolved_at tracks the transition into a done state, and clears on a
        # reopen — otherwise "closed this month" counts issues that were
        # reopened and are still live.
        if body.status in _DONE and issue["resolved_at"] is None:
            put("resolved_at", _now())
        elif body.status not in _DONE and issue["resolved_at"] is not None:
            put("resolved_at", None)

    if body.device_ids is not None:
        _set_devices(engine, issue_id, body.device_ids)
        entries.append(f"linked devices updated ({len(set(body.device_ids))})")

    if sets:
        put("updated_at", _now())
        db.execute(engine, f"UPDATE issues SET {', '.join(sets)} WHERE id = :id",
                   params)
    elif body.device_ids is not None:
        db.execute(engine, "UPDATE issues SET updated_at = :at WHERE id = :id",
                   {"at": _now(), "id": issue_id})

    if entries:
        text = "; ".join(entries)
        if body.note:
            text += f" — {body.note.strip()}"
        _log_entry(engine, issue_id, text, user.username)

    return _detail(engine, issue_id)


@router.delete("/{issue_id}")
def delete_issue(issue_id: int, request: Request,
                 engine: Engine = Depends(get_engine),
                 user: UserSession = Depends(current_user)) -> dict:
    cfg = _cfg(request)
    _require_enabled(cfg)
    _require_admin(user)
    _get_issue(engine, issue_id)
    # Rows first: a directory removed under a row that survives leaves the UI
    # pointing at files that 404. The reverse — rows gone, files orphaned — is
    # recoverable by hand and is what the storage report exists to surface.
    db.execute(engine, "DELETE FROM issues WHERE id = :id", {"id": issue_id})
    shutil.rmtree(_issue_dir(cfg, issue_id), ignore_errors=True)
    log.info("issue %d deleted by admin %s", issue_id, user.username)
    return {"deleted": issue_id}


# ── comments ─────────────────────────────────────────────────────────────────

@router.post("/{issue_id}/comments", status_code=status.HTTP_201_CREATED)
def add_comment(issue_id: int, body: CommentCreate, request: Request,
                engine: Engine = Depends(get_engine),
                user: UserSession = Depends(current_user)) -> dict:
    cfg = _cfg(request)
    _require_enabled(cfg)
    _require_report(cfg, user)
    _get_issue(engine, issue_id)
    now = _now()
    db.execute(engine, """
        INSERT INTO issue_comments (issue_id, kind, body, author, created_at)
        VALUES (:issue_id, 'comment', :body, :author, :created_at)
    """, {"issue_id": issue_id, "body": body.body, "author": user.username,
          "created_at": now})
    # A comment is activity: it moves the issue up a list sorted by updated_at.
    db.execute(engine, "UPDATE issues SET updated_at = :at WHERE id = :id",
               {"at": now, "id": issue_id})
    row = db.fetch_one(engine, """
        SELECT id FROM issue_comments
         WHERE issue_id = :i AND author = :a AND created_at = :t
         ORDER BY id DESC LIMIT 1
    """, {"i": issue_id, "a": user.username, "t": now})
    return {"id": int(row["id"]), "issue_id": issue_id}


@router.patch("/{issue_id}/comments/{comment_id}")
def edit_comment(issue_id: int, comment_id: int, body: CommentPatch,
                 request: Request, engine: Engine = Depends(get_engine),
                 user: UserSession = Depends(current_user)) -> dict:
    """The author may fix their own comment; an admin may fix anyone's.

    `edited_at` is set either way. A reader of an incident thread needs to know
    the text is not what was originally written.
    """
    _require_enabled(_cfg(request))
    row = db.fetch_one(engine, """
        SELECT * FROM issue_comments WHERE id = :cid AND issue_id = :iid
    """, {"cid": comment_id, "iid": issue_id})
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail=f"comment {comment_id} not found on issue {issue_id}")
    if row["kind"] != "comment":
        raise _refused("a status change is a record of what happened, not a comment; "
                       "it cannot be edited")
    if row["author"] != user.username and not _at_least(user, "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="only the author or an admin may edit a comment")
    db.execute(engine, """
        UPDATE issue_comments SET body = :body, edited_at = :at WHERE id = :cid
    """, {"body": body.body, "at": _now(), "cid": comment_id})
    return {"id": comment_id, "issue_id": issue_id, "edited": True}


@router.delete("/{issue_id}/comments/{comment_id}")
def delete_comment(issue_id: int, comment_id: int, request: Request,
                   engine: Engine = Depends(get_engine),
                   user: UserSession = Depends(current_user)) -> dict:
    cfg = _cfg(request)
    _require_enabled(cfg)
    _require_admin(user)
    # Attachments hung off this comment stay with the issue rather than
    # vanishing: the file is evidence, the comment was only its envelope.
    db.execute(engine, """
        UPDATE issue_attachments SET comment_id = NULL WHERE comment_id = :cid
    """, {"cid": comment_id})
    db.execute(engine, "DELETE FROM issue_comments WHERE id = :cid AND issue_id = :iid",
               {"cid": comment_id, "iid": issue_id})
    return {"deleted": comment_id}


# ── attachments ──────────────────────────────────────────────────────────────

@router.put("/{issue_id}/attachments/{filename}",
            status_code=status.HTTP_201_CREATED)
async def upload_attachment(issue_id: int, filename: str, request: Request,
                            comment_id: int | None = None,
                            engine: Engine = Depends(get_engine),
                            user: UserSession = Depends(current_user)) -> dict:
    """Stream one file into the issue's directory. Raw body, not multipart.

    The body is written to a temporary name in chunks and the byte count is
    checked as it goes, so an oversize upload is aborted and unlinked partway
    rather than after the whole thing has landed on disk. Only once the type is
    decided does the file take its final name.
    """
    cfg = _cfg(request)
    _require_enabled(cfg)
    _require_report(cfg, user)
    _get_issue(engine, issue_id)

    safe = _safe_name(filename)
    ext = _ext(safe)
    if ext not in ACCEPTED:
        raise _refused(
            f"{safe!r} is not a file type NetMon stores. Accepted: "
            + ", ".join("." + e for e in sorted(ACCEPTED)))

    count = db.fetch_one(engine, """
        SELECT COUNT(*) AS n FROM issue_attachments WHERE issue_id = :id
    """, {"id": issue_id})
    if int(count["n"]) >= cfg.issues.max_attachments_per_issue:
        raise _refused(
            f"issue {issue_id} already has {cfg.issues.max_attachments_per_issue} "
            "attachments, the configured maximum "
            "([issues] max_attachments_per_issue)")

    if comment_id is not None:
        owner = db.fetch_one(engine, """
            SELECT id FROM issue_comments WHERE id = :cid AND issue_id = :iid
        """, {"cid": comment_id, "iid": issue_id})
        if owner is None:
            raise _refused(f"comment {comment_id} is not on issue {issue_id}")

    limit = cfg.issues.max_attachment_mb * 1024 * 1024
    directory = _issue_dir(cfg, issue_id)
    directory.mkdir(parents=True, exist_ok=True)
    tmp = directory / f".incoming-{os.getpid()}-{int(_now().timestamp())}-{safe}"

    digest = hashlib.sha256()
    size = 0
    head = b""
    try:
        with tmp.open("wb") as handle:
            async for chunk in request.stream():
                if not chunk:
                    continue
                size += len(chunk)
                if size > limit:
                    raise _refused(
                        f"{safe} is larger than the {cfg.issues.max_attachment_mb} MB "
                        "limit ([issues] max_attachment_mb)")
                if len(head) < 512:
                    head += chunk[: 512 - len(head)]
                digest.update(chunk)
                handle.write(chunk)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise

    if size == 0:
        tmp.unlink(missing_ok=True)
        raise _refused("refusing to store an empty file")

    content_type, looks_right = ACCEPTED[ext]
    if not looks_right(head):
        tmp.unlink(missing_ok=True)
        raise _refused(
            f"{safe} does not contain {content_type} data. The extension and the "
            "file's contents have to agree — NetMon serves this back to a browser "
            "and decides the type from what it stored, not from what was claimed.")

    now = _now()
    db.execute(engine, """
        INSERT INTO issue_attachments (issue_id, comment_id, filename, content_type,
                                       size_bytes, sha256, rel_path, uploaded_by,
                                       uploaded_at)
        VALUES (:issue_id, :comment_id, :filename, :content_type, :size_bytes,
                :sha256, :rel_path, :uploaded_by, :uploaded_at)
    """, {
        "issue_id": issue_id, "comment_id": comment_id, "filename": safe,
        "content_type": content_type, "size_bytes": size,
        "sha256": digest.hexdigest(), "rel_path": "", "uploaded_by": user.username,
        "uploaded_at": now,
    })
    row = db.fetch_one(engine, """
        SELECT id FROM issue_attachments
         WHERE issue_id = :i AND uploaded_by = :u AND uploaded_at = :t
         ORDER BY id DESC LIMIT 1
    """, {"i": issue_id, "u": user.username, "t": now})
    attachment_id = int(row["id"])

    # The id in the name is what lets two uploads of `screenshot.png` coexist,
    # and the readable half is what makes the directory navigable during a
    # restore.
    final_rel = f"{issue_id}/{attachment_id}-{safe}"
    tmp.replace(Path(cfg.issues.attachment_dir) / final_rel)
    db.execute(engine, "UPDATE issue_attachments SET rel_path = :p WHERE id = :id",
               {"p": final_rel, "id": attachment_id})
    db.execute(engine, "UPDATE issues SET updated_at = :at WHERE id = :id",
               {"at": now, "id": issue_id})

    log.info("attachment %d (%s, %d bytes) added to issue %d by %s",
             attachment_id, content_type, size, issue_id, user.username)
    return {
        "id": attachment_id, "issue_id": issue_id, "comment_id": comment_id,
        "filename": safe, "content_type": content_type, "size_bytes": size,
        "sha256": digest.hexdigest(),
        "url": f"/api/issues/{issue_id}/attachments/{attachment_id}",
        "inline": content_type in INLINE_OK,
        "is_image": content_type.startswith("image/"),
    }


@router.get("/{issue_id}/attachments/{attachment_id}")
def download_attachment(issue_id: int, attachment_id: int, request: Request,
                        engine: Engine = Depends(get_engine),
                        _user: UserSession = Depends(current_user)) -> FileResponse:
    """Serve one attachment.

    Three headers carry the whole security posture of this route:
    `Content-Type` is the type NetMon decided at upload (never the client's),
    `Content-Disposition` is `inline` only for the short allow-list and
    `attachment` for everything else, and `nosniff` stops the browser
    second-guessing either of those.
    """
    cfg = _cfg(request)
    _require_enabled(cfg)
    row = db.fetch_one(engine, """
        SELECT * FROM issue_attachments WHERE id = :aid AND issue_id = :iid
    """, {"aid": attachment_id, "iid": issue_id})
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail=f"attachment {attachment_id} not found")

    path = Path(cfg.issues.attachment_dir) / str(row["rel_path"])
    root = Path(cfg.issues.attachment_dir).resolve()
    try:
        resolved = path.resolve()
        resolved.relative_to(root)
    except (OSError, ValueError):
        # rel_path is written by this module alone, so landing here means the
        # row or the store was tampered with. Refuse rather than serve it.
        log.warning("attachment %d has a rel_path outside the store: %r",
                    attachment_id, row["rel_path"])
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="attachment is not readable")
    if not resolved.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="the file for this attachment is missing from the store")

    ctype = str(row["content_type"])
    disposition = "inline" if ctype in INLINE_OK else "attachment"
    name = str(row["filename"]).replace('"', "")
    return FileResponse(
        resolved,
        media_type=ctype,
        headers={
            "Content-Disposition": f'{disposition}; filename="{name}"',
            "X-Content-Type-Options": "nosniff",
            # These are internal records, not public assets; a shared cache
            # holding one would outlive the permission that fetched it.
            "Cache-Control": "private, max-age=300",
        },
    )


@router.delete("/{issue_id}/attachments/{attachment_id}")
def delete_attachment(issue_id: int, attachment_id: int, request: Request,
                      engine: Engine = Depends(get_engine),
                      user: UserSession = Depends(current_user)) -> dict:
    cfg = _cfg(request)
    _require_enabled(cfg)
    _require_admin(user)
    row = db.fetch_one(engine, """
        SELECT * FROM issue_attachments WHERE id = :aid AND issue_id = :iid
    """, {"aid": attachment_id, "iid": issue_id})
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail=f"attachment {attachment_id} not found")
    db.execute(engine, "DELETE FROM issue_attachments WHERE id = :aid",
               {"aid": attachment_id})
    (Path(cfg.issues.attachment_dir) / str(row["rel_path"])).unlink(missing_ok=True)
    log.info("attachment %d removed from issue %d by admin %s",
             attachment_id, issue_id, user.username)
    return {"deleted": attachment_id}
