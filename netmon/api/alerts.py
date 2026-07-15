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
) -> list[dict]:
    where = "" if include_closed else "WHERE a.closed_at IS NULL"
    rows = db.fetch_all(
        engine,
        f"SELECT a.id, a.device_id, d.name AS device_name, r.name AS rule_name, "
        f"r.severity, a.opened_at, a.last_seen_at, a.closed_at, a.acked_by, a.acked_at, "
        f"a.assigned_to "
        f"FROM alerts a "
        f"JOIN alert_rules r ON r.id = a.rule_id "
        f"LEFT JOIN devices d ON d.id = a.device_id {where} "
        f"ORDER BY a.opened_at DESC",
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
