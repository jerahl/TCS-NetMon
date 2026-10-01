"""Change tracking API — what was changed, why, expected vs actual (spec 24 §10).

The companion to `issues.py`. An issue records a problem; a change records a
deliberate act taken against one, together with the prediction made beforehand
and the outcome observed afterwards.

Two rules shape the whole file.

**The prediction is written before the result and cannot be edited after.**
`expected` locks the moment a change is applied. A change log where the
expectation can be adjusted once the answer is known records nothing — it is
the comparison that has value, not either half alone.

**An applied change that nobody verified is the headline, not a footnote.**
`/api/changes/outstanding` exists so the UI can lead with that number rather
than discover it by filtering. This is the project's fail-loud rule (CLAUDE.md
§4.5) applied to our own work instead of to a collector.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import current_user, get_config, get_engine
from netmon.config import ROLES, Config
from netmon.models.schemas import UserSession

log = logging.getLogger("netmon.api.changes")

router = APIRouter(prefix="/api/changes", tags=["changes"])


# ── vocabulary ───────────────────────────────────────────────────────────────

#: proposed → approved → applied → verified, with two ways out.
#:
#: `approved` is its own state because several of these need a decision from
#: somebody else before they are made, and "waiting on approval" must not look
#: identical to "nobody has started".
STATUSES = ("proposed", "approved", "applied", "verified", "reverted", "abandoned")

#: The honest comparison of `expected` against `actual`.
#:
#: `no_effect` and `worse` are first-class answers. A change log in which every
#: entry reads as a success is one nobody learns anything from, and the two
#: states most worth finding later are "we were sure and we were wrong" and
#: "this made it worse".
VERDICTS = ("pending", "as_expected", "partial", "no_effect", "worse")

RISKS = ("low", "medium", "high")

#: Which devices were changed, and which were deliberately left alone.
ROLES_DEV = ("target", "baseline")

#: Statuses where the change is on the network right now.
LIVE = ("applied", "verified")

#: Statuses after which `expected` is frozen — see the module docstring.
_EXPECTATION_LOCKED = ("applied", "verified", "reverted")


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def _cfg(request: Request) -> Config:
    return get_config(request)


def _refused(message: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)


def _at_least(user: UserSession, minimum: str) -> bool:
    return ROLES.index(user.role.value) >= ROLES.index(minimum)


def _require_enabled(cfg: Config) -> None:
    if not cfg.issues.enabled:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="the issue tracker is disabled ([issues] enabled)")


def _require_operator(user: UserSession) -> None:
    """Changes are operator-and-above, with no viewer carve-out.

    Deliberately unlike issues, where `[issues] allow_viewer_reports` lets
    anyone signed in file a report. Reporting a problem is something a teacher
    should be able to do; recording that the network was reconfigured is not —
    the record would be unreliable, and the act it describes is one only an
    operator could have performed.
    """
    if not _at_least(user, "operator"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="recording a change requires the operator role")


def _require_admin(user: UserSession) -> None:
    if not _at_least(user, "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="requires role admin or higher")


def _get(engine: Engine, change_id: int) -> dict:
    row = db.fetch_one(engine, "SELECT * FROM changes WHERE id = :id", {"id": change_id})
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail=f"change {change_id} not found")
    return dict(row)


def _devices(engine: Engine, change_id: int) -> list[dict]:
    rows = db.fetch_all(engine, """
        SELECT cd.device_id, cd.role, cd.note, d.name, d.site, d.device_type
          FROM change_devices cd
          LEFT JOIN devices d ON d.id = cd.device_id
         WHERE cd.change_id = :id
         ORDER BY cd.role DESC, d.name IS NULL, d.name
    """, {"id": change_id})
    out = []
    for r in rows:
        r = dict(r)
        out.append({
            "device_id": r["device_id"],
            "role": r["role"],
            # A device that left the registry keeps its row — migration 037 has
            # no FK to `devices` for exactly this reason.
            "name": r["name"] or f"device {r['device_id']}, no longer registered",
            "registered": r["name"] is not None,
            "site": r["site"], "device_type": r["device_type"], "note": r["note"],
        })
    return out


def _detail(engine: Engine, change_id: int) -> dict:
    change = _get(engine, change_id)
    change["devices"] = _devices(engine, change_id)
    if change.get("issue_id"):
        issue = db.fetch_one(engine, "SELECT id, title, status FROM issues WHERE id = :i",
                             {"i": change["issue_id"]})
        change["issue"] = dict(issue) if issue else None
    else:
        change["issue"] = None
    return change


def _note_on_issue(engine: Engine, issue_id: int | None, body: str, author: str) -> None:
    """Record a change's milestone on its issue's timeline.

    Changes get no thread of their own. The discussion belongs on the issue, and
    a second comment system would split the story of one problem across two
    places — so applying or verifying a change writes into the issue instead.
    """
    if not issue_id:
        return
    if not db.fetch_one(engine, "SELECT id FROM issues WHERE id = :i", {"i": issue_id}):
        return
    now = _now()
    db.execute(engine, """
        INSERT INTO issue_comments (issue_id, kind, body, author, created_at)
        VALUES (:i, 'status_change', :b, :a, :t)
    """, {"i": issue_id, "b": body, "a": author, "t": now})
    db.execute(engine, "UPDATE issues SET updated_at = :t WHERE id = :i",
               {"t": now, "i": issue_id})


def _set_devices(engine: Engine, change_id: int, targets: list[int],
                 baselines: list[int]) -> None:
    overlap = set(targets) & set(baselines)
    if overlap:
        raise _refused(
            f"device {sorted(overlap)[0]} is listed as both a target and a baseline — "
            "a device held as a control cannot also be the one being changed")
    db.execute(engine, "DELETE FROM change_devices WHERE change_id = :c", {"c": change_id})
    for did in sorted(set(targets)):
        db.execute(engine, "INSERT INTO change_devices (change_id, device_id, role) "
                   "VALUES (:c, :d, 'target')", {"c": change_id, "d": did})
    for did in sorted(set(baselines)):
        db.execute(engine, "INSERT INTO change_devices (change_id, device_id, role) "
                   "VALUES (:c, :d, 'baseline')", {"c": change_id, "d": did})


# ── request bodies ───────────────────────────────────────────────────────────

class ChangeCreate(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    what: str = Field(min_length=1, max_length=64000)
    why: str = Field(min_length=1, max_length=64000)
    expected: str = Field(min_length=1, max_length=64000)
    issue_id: int | None = None
    site: str | None = None
    risk: str = "low"
    rollback: str | None = None
    target_device_ids: list[int] = Field(default_factory=list)
    baseline_device_ids: list[int] = Field(default_factory=list)


class ChangePatch(BaseModel):
    title: str | None = Field(default=None, min_length=3, max_length=200)
    what: str | None = None
    why: str | None = None
    expected: str | None = None
    actual: str | None = None
    status: str | None = None
    verdict: str | None = None
    risk: str | None = None
    site: str | None = None
    rollback: str | None = None
    issue_id: int | None = None
    target_device_ids: list[int] | None = None
    baseline_device_ids: list[int] | None = None


class Applied(BaseModel):
    """Marking a change as applied. `at` allows recording one made earlier."""
    at: datetime | None = None
    note: str | None = Field(default=None, max_length=1000)


class Verified(BaseModel):
    """The whole point of the table: what actually happened, and the verdict."""
    actual: str = Field(min_length=1, max_length=64000)
    verdict: str


# ── meta and outstanding ─────────────────────────────────────────────────────

@router.get("/meta")
def changes_meta(request: Request, user: UserSession = Depends(current_user)) -> dict:
    cfg = _cfg(request)
    _require_enabled(cfg)
    return {
        "statuses": list(STATUSES),
        "verdicts": list(VERDICTS),
        "risks": list(RISKS),
        "device_roles": list(ROLES_DEV),
        "live_statuses": list(LIVE),
        "me": user.username,
        "can": {"record": _at_least(user, "operator"),
                "admin": _at_least(user, "admin")},
    }


@router.get("/outstanding")
def outstanding(request: Request, engine: Engine = Depends(get_engine),
                _user: UserSession = Depends(current_user)) -> dict:
    """Changes that are on the network but whose result nobody has written down.

    Its own endpoint, not a filter, because this is the number the page should
    lead with. A change log's value is almost entirely in showing which
    predictions were never checked — left as something you have to think to ask
    for, nobody asks.
    """
    _require_enabled(_cfg(request))
    rows = db.fetch_all(engine, """
        SELECT id, title, site, applied_at, applied_by, risk, issue_id
          FROM changes
         WHERE status = 'applied' AND verdict = 'pending'
         ORDER BY applied_at
    """)
    return {"count": len(rows), "changes": [dict(r) for r in rows]}


# ── list and read ────────────────────────────────────────────────────────────

@router.get("")
def list_changes(
    request: Request,
    status_: str | None = Query(default=None, alias="status"),
    verdict: str | None = None,
    issue_id: int | None = None,
    device_id: int | None = None,
    site: str | None = None,
    q: str | None = None,
    limit: int = Query(default=200, ge=1, le=1000),
    engine: Engine = Depends(get_engine),
    _user: UserSession = Depends(current_user),
) -> list[dict]:
    """Changes, most recent activity first.

    `status=live` is a pseudo-filter for "on the network now" (applied or
    verified), which is the question asked far more often than any single
    status.
    """
    _require_enabled(_cfg(request))
    where: list[str] = []
    params: dict[str, object] = {"limit": limit}

    if status_ == "live":
        where.append("c.status IN ('applied', 'verified')")
    elif status_ == "unverified":
        where.append("c.status = 'applied' AND c.verdict = 'pending'")
    elif status_:
        where.append("c.status = :status")
        params["status"] = status_
    if verdict:
        where.append("c.verdict = :verdict")
        params["verdict"] = verdict
    if issue_id:
        where.append("c.issue_id = :issue_id")
        params["issue_id"] = issue_id
    if site:
        where.append("c.site = :site")
        params["site"] = site
    if device_id:
        where.append("EXISTS (SELECT 1 FROM change_devices x "
                     "WHERE x.change_id = c.id AND x.device_id = :device_id)")
        params["device_id"] = device_id
    if q:
        where.append("(c.title LIKE :q OR c.what LIKE :q OR c.why LIKE :q)")
        params["q"] = f"%{q}%"

    clause = (" WHERE " + " AND ".join(where)) if where else ""
    rows = db.fetch_all(engine, f"""
        SELECT c.*, i.title AS issue_title,
               (SELECT COUNT(*) FROM change_devices x
                 WHERE x.change_id = c.id AND x.role = 'target') AS target_count,
               (SELECT COUNT(*) FROM change_devices x
                 WHERE x.change_id = c.id AND x.role = 'baseline') AS baseline_count
          FROM changes c
          LEFT JOIN issues i ON i.id = c.issue_id{clause}
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT :limit
    """, params)
    return [dict(r) for r in rows]


@router.get("/{change_id}")
def get_change(change_id: int, request: Request,
               engine: Engine = Depends(get_engine),
               _user: UserSession = Depends(current_user)) -> dict:
    _require_enabled(_cfg(request))
    return _detail(engine, change_id)


# ── create and edit ──────────────────────────────────────────────────────────

def _validate(status_: str | None = None, verdict: str | None = None,
              risk: str | None = None) -> None:
    if status_ is not None and status_ not in STATUSES:
        raise _refused(f"status must be one of {', '.join(STATUSES)}")
    if verdict is not None and verdict not in VERDICTS:
        raise _refused(f"verdict must be one of {', '.join(VERDICTS)}")
    if risk is not None and risk not in RISKS:
        raise _refused(f"risk must be one of {', '.join(RISKS)}")


@router.post("", status_code=status.HTTP_201_CREATED)
def create_change(body: ChangeCreate, request: Request,
                  engine: Engine = Depends(get_engine),
                  user: UserSession = Depends(current_user)) -> dict:
    cfg = _cfg(request)
    _require_enabled(cfg)
    _require_operator(user)
    _validate(risk=body.risk)

    if body.issue_id and not db.fetch_one(engine, "SELECT id FROM issues WHERE id = :i",
                                          {"i": body.issue_id}):
        raise _refused(f"issue {body.issue_id} does not exist")

    now = _now()
    db.execute(engine, """
        INSERT INTO changes (issue_id, title, what, why, expected, status, verdict,
                             risk, site, rollback, proposed_by, proposed_at, updated_at)
        VALUES (:issue_id, :title, :what, :why, :expected, 'proposed', 'pending',
                :risk, :site, :rollback, :who, :at, :at)
    """, {
        "issue_id": body.issue_id, "title": body.title.strip(), "what": body.what,
        "why": body.why, "expected": body.expected, "risk": body.risk,
        "site": (body.site or "").strip() or None, "rollback": body.rollback,
        "who": user.username, "at": now,
    })
    cid = int(db.fetch_one(engine, """
        SELECT id FROM changes WHERE proposed_by = :w AND proposed_at = :a
         ORDER BY id DESC LIMIT 1
    """, {"w": user.username, "a": now})["id"])

    if body.target_device_ids or body.baseline_device_ids:
        _set_devices(engine, cid, body.target_device_ids, body.baseline_device_ids)

    _note_on_issue(engine, body.issue_id,
                   f"change #{cid} proposed — {body.title.strip()}", user.username)
    log.info("change %d proposed by %s: %s", cid, user.username, body.title.strip())
    return _detail(engine, cid)


@router.patch("/{change_id}")
def patch_change(change_id: int, body: ChangePatch, request: Request,
                 engine: Engine = Depends(get_engine),
                 user: UserSession = Depends(current_user)) -> dict:
    """Edit a change.

    `expected` is refused once the change has been applied. That is the one
    rule this table exists to enforce: a prediction that can be revised after
    the result is known is not a prediction, and the whole record becomes
    decorative. Everything else stays editable, because a rollback note or a
    clarified `what` is worth improving at any point.
    """
    cfg = _cfg(request)
    _require_enabled(cfg)
    _require_operator(user)
    change = _get(engine, change_id)
    _validate(body.status, body.verdict, body.risk)

    if body.expected is not None and change["status"] in _EXPECTATION_LOCKED:
        raise _refused(
            "`expected` cannot be edited once a change has been applied — it is "
            "the prediction this record exists to check. Put the revision in "
            "`actual` when verifying, where it reads as a correction rather "
            "than replacing what was originally believed.")

    if body.issue_id is not None and body.issue_id and not db.fetch_one(
            engine, "SELECT id FROM issues WHERE id = :i", {"i": body.issue_id}):
        raise _refused(f"issue {body.issue_id} does not exist")

    sets, params = ["updated_at = :updated_at"], {"updated_at": _now(), "id": change_id}
    for col in ("title", "what", "why", "expected", "actual", "status", "verdict",
                "risk", "rollback", "issue_id"):
        val = getattr(body, col)
        if val is not None:
            sets.append(f"{col} = :{col}")
            params[col] = val.strip() if col == "title" else val
    if body.site is not None:
        sets.append("site = :site")
        params["site"] = body.site.strip() or None

    db.execute(engine, f"UPDATE changes SET {', '.join(sets)} WHERE id = :id", params)

    if body.target_device_ids is not None or body.baseline_device_ids is not None:
        _set_devices(engine, change_id,
                     body.target_device_ids if body.target_device_ids is not None
                     else [d["device_id"] for d in _devices(engine, change_id)
                           if d["role"] == "target"],
                     body.baseline_device_ids if body.baseline_device_ids is not None
                     else [d["device_id"] for d in _devices(engine, change_id)
                           if d["role"] == "baseline"])
    return _detail(engine, change_id)


@router.delete("/{change_id}")
def delete_change(change_id: int, request: Request,
                  engine: Engine = Depends(get_engine),
                  user: UserSession = Depends(current_user)) -> dict:
    cfg = _cfg(request)
    _require_enabled(cfg)
    _require_admin(user)
    change = _get(engine, change_id)
    if change["status"] in LIVE:
        raise _refused(
            "this change is on the network — deleting the record would leave the "
            "configuration with no explanation. Mark it reverted or abandoned "
            "instead.")
    db.execute(engine, "DELETE FROM changes WHERE id = :id", {"id": change_id})
    log.info("change %d deleted by admin %s", change_id, user.username)
    return {"deleted": change_id}


# ── the lifecycle ────────────────────────────────────────────────────────────

@router.post("/{change_id}/apply")
def apply_change(change_id: int, body: Applied, request: Request,
                 engine: Engine = Depends(get_engine),
                 user: UserSession = Depends(current_user)) -> dict:
    """Record that a change went in. NetMon does not make it — it records it."""
    cfg = _cfg(request)
    _require_enabled(cfg)
    _require_operator(user)
    change = _get(engine, change_id)
    if change["status"] in LIVE:
        raise _refused(f"change {change_id} is already {change['status']}")

    at = body.at or _now()
    if isinstance(at, datetime):
        at = at.replace(tzinfo=None, microsecond=0)
    db.execute(engine, """
        UPDATE changes SET status = 'applied', applied_by = :who, applied_at = :at,
                           updated_at = :now
         WHERE id = :id
    """, {"who": user.username, "at": at, "now": _now(), "id": change_id})

    note = f"change #{change_id} applied — {change['title']}"
    if body.note:
        note += f"\n{body.note.strip()}"
    note += "\n\nExpected:\n" + str(change["expected"])
    _note_on_issue(engine, change["issue_id"], note, user.username)
    log.info("change %d applied by %s", change_id, user.username)
    return _detail(engine, change_id)


@router.post("/{change_id}/verify")
def verify_change(change_id: int, body: Verified, request: Request,
                  engine: Engine = Depends(get_engine),
                  user: UserSession = Depends(current_user)) -> dict:
    """Write down what actually happened, and say whether it matched.

    Refused on a change that was never applied: a result for something that did
    not happen is the one entry that would make the whole log untrustworthy.
    """
    cfg = _cfg(request)
    _require_enabled(cfg)
    _require_operator(user)
    change = _get(engine, change_id)
    _validate(verdict=body.verdict)

    if body.verdict == "pending":
        raise _refused("verifying means reaching a verdict — `pending` is what it "
                       "was before")
    if change["applied_at"] is None:
        raise _refused(
            f"change {change_id} has not been applied, so there is no result to "
            "record. Apply it first, or mark it abandoned.")

    db.execute(engine, """
        UPDATE changes SET status = 'verified', actual = :actual, verdict = :verdict,
                           verified_by = :who, verified_at = :at, updated_at = :at
         WHERE id = :id
    """, {"actual": body.actual, "verdict": body.verdict, "who": user.username,
          "at": _now(), "id": change_id})

    _note_on_issue(engine, change["issue_id"],
                   f"change #{change_id} verified — {body.verdict}\n\n"
                   f"Expected:\n{change['expected']}\n\nActual:\n{body.actual}",
                   user.username)
    log.info("change %d verified by %s: %s", change_id, user.username, body.verdict)
    return _detail(engine, change_id)


@router.post("/{change_id}/revert")
def revert_change(change_id: int, body: Applied, request: Request,
                  engine: Engine = Depends(get_engine),
                  user: UserSession = Depends(current_user)) -> dict:
    """Record that a change was backed out.

    The record is kept, not deleted. A change that had to be reverted is the
    most informative row in the table, and the `expected`/`actual` pair is what
    explains why.
    """
    cfg = _cfg(request)
    _require_enabled(cfg)
    _require_operator(user)
    change = _get(engine, change_id)
    if change["applied_at"] is None:
        raise _refused(f"change {change_id} was never applied, so there is nothing "
                       "to revert — mark it abandoned instead")

    db.execute(engine, """
        UPDATE changes SET status = 'reverted', reverted_at = :at, updated_at = :at
         WHERE id = :id
    """, {"at": _now(), "id": change_id})
    note = f"change #{change_id} REVERTED — {change['title']}"
    if body.note:
        note += f"\n{body.note.strip()}"
    _note_on_issue(engine, change["issue_id"], note, user.username)
    log.info("change %d reverted by %s", change_id, user.username)
    return _detail(engine, change_id)
