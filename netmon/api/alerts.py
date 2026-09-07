"""Alerts + maintenance windows API."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import get_engine, require_role
from netmon.models.schemas import Role, UserSession

router = APIRouter(prefix="/api", tags=["alerts"])


@router.get("/alerts")
def list_alerts(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
    include_closed: bool = False,
    device_id: int | None = None,
    device_type: str | None = None,
    limit: int | None = None,
) -> list[dict]:
    conds = []
    params: dict = {}
    if not include_closed:
        conds.append("a.closed_at IS NULL")
    if device_id is not None:
        # Device-scoped view (the Switches page Triggers tab).
        conds.append("a.device_id = :device_id")
        params["device_id"] = device_id
    if device_type:
        # Domain-scoped view: the Surveillance page's alarm feed asks for
        # `camera,recording_server`, which is ZCD's "VMS alarms" pane without
        # a second alert store behind it. A comma list rather than one type
        # because a domain is rarely one device_type, and filtering in the
        # browser would mean shipping every open alert in the estate (2,742 at
        # last count) to render ten rows.
        wanted = [t.strip() for t in device_type.split(",") if t.strip()]
        if wanted:
            keys = [f"dt{i}" for i in range(len(wanted))]
            conds.append(f"d.device_type IN ({', '.join(':' + k for k in keys)})")
            params.update(dict(zip(keys, wanted)))
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    # `limit` is applied in SQL, not in the caller, so a feed asking for ten
    # rows costs ten rows.
    tail = ""
    if limit is not None and limit > 0:
        tail = " LIMIT :limit"
        params["limit"] = int(limit)
    rows = db.fetch_all(
        engine,
        f"SELECT a.id, a.device_id, d.name AS device_name, "
        f"d.site AS site, d.device_type AS device_type, r.name AS rule_name, "
        f"r.severity, a.opened_at, a.last_seen_at, a.closed_at, a.acked_by, a.acked_at, "
        f"a.assigned_to "
        f"FROM alerts a "
        f"JOIN alert_rules r ON r.id = a.rule_id "
        f"LEFT JOIN devices d ON d.id = a.device_id {where} "
        f"ORDER BY a.opened_at DESC{tail}",
        params,
    )
    return [dict(r) for r in rows]


@router.post("/alerts/{alert_id}/ack")
def ack_alert(
    alert_id: int,
    engine: Engine = Depends(get_engine),
    user: UserSession = Depends(require_role(Role.operator)),
) -> dict:
    n = db.execute(
        engine,
        "UPDATE alerts SET acked_by = :by, acked_at = :at WHERE id = :id AND closed_at IS NULL",
        {"by": user.username, "at": datetime.now(timezone.utc), "id": alert_id},
    )
    if not n:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="open alert not found")
    return {"status": "acked", "alert_id": alert_id, "acked_by": user.username}


class AssignBody(BaseModel):
    # None / "" clears the assignment (an operator un-assigning themselves).
    assignee: str | None = None


@router.post("/alerts/{alert_id}/assign")
def assign_alert(
    alert_id: int,
    body: AssignBody,
    engine: Engine = Depends(get_engine),
    user: UserSession = Depends(require_role(Role.operator)),
) -> dict:
    """Set (or clear) ``alerts.assigned_to`` — the events/problems Assign action."""
    assignee = (body.assignee or "").strip() or None
    n = db.execute(
        engine,
        "UPDATE alerts SET assigned_to = :who WHERE id = :id AND closed_at IS NULL",
        {"who": assignee, "id": alert_id},
    )
    if not n:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="open alert not found")
    return {"status": "assigned", "alert_id": alert_id, "assigned_to": assignee}


@router.post("/alerts/{alert_id}/suppress")
def suppress_alert(
    alert_id: int,
    engine: Engine = Depends(get_engine),
    user: UserSession = Depends(require_role(Role.operator)),
    hours: float = 1.0,
) -> dict:
    """"Suppress 1 h" → a device-scoped maintenance window (spec 10 §2).

    Maintenance suppresses NOTIFICATION, not state recording (§6 invariant), so
    the alert stays visible and keeps updating; only the engine stops emailing
    on it. The window is scoped to the alert's device.
    """
    row = db.fetch_one(engine, "SELECT device_id FROM alerts WHERE id = :id", {"id": alert_id})
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="alert not found")
    now = datetime.now(timezone.utc)
    ends = now + timedelta(hours=max(hours, 0.0))
    db.execute(
        engine,
        "INSERT INTO maintenance_windows (scope_type, scope_value, starts_at, ends_at, created_by) "
        "VALUES ('device', :dev, :s, :e, :by)",
        {"dev": str(row["device_id"]), "s": now, "e": ends, "by": user.username},
    )
    return {"status": "suppressed", "alert_id": alert_id, "device_id": row["device_id"],
            "until": ends.isoformat()}


class MaintenanceWindow(BaseModel):
    scope_type: str  # device | site | device_type
    scope_value: str
    starts_at: datetime
    ends_at: datetime


@router.get("/maintenance")
def list_maintenance(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[dict]:
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT id, scope_type, scope_value, starts_at, ends_at, created_by, created_at "
        "FROM maintenance_windows ORDER BY starts_at DESC",
    )]


@router.post("/maintenance")
def create_maintenance(
    body: MaintenanceWindow,
    engine: Engine = Depends(get_engine),
    user: UserSession = Depends(require_role(Role.operator)),
) -> dict:
    if body.scope_type not in ("device", "site", "device_type"):
        raise HTTPException(status_code=422, detail="scope_type must be device|site|device_type")
    db.execute(
        engine,
        "INSERT INTO maintenance_windows (scope_type, scope_value, starts_at, ends_at, created_by) "
        "VALUES (:st, :sv, :s, :e, :by)",
        {"st": body.scope_type, "sv": body.scope_value, "s": body.starts_at,
         "e": body.ends_at, "by": user.username},
    )
    return {"status": "created"}
