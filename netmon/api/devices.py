"""Device registry read API. Viewer role or higher."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import get_engine, require_role
from netmon.models.schemas import Device, Role

router = APIRouter(prefix="/api/devices", tags=["devices"])

_COLUMNS = (
    "id, name, site, device_type, mgmt_ip, snmp_capable, enabled, "
    "xiq_device_id, pf_node_mac, milestone_hardware_id, rconfig_device_id, threecx_ref"
)


def _to_device(row: dict) -> Device:
    return Device(
        id=row["id"],
        name=row["name"],
        site=row.get("site"),
        device_type=row["device_type"],
        mgmt_ip=row.get("mgmt_ip"),
        snmp_capable=bool(row.get("snmp_capable")),
        enabled=bool(row.get("enabled")),
        xiq_device_id=row.get("xiq_device_id"),
        pf_node_mac=row.get("pf_node_mac"),
        milestone_hardware_id=row.get("milestone_hardware_id"),
        rconfig_device_id=row.get("rconfig_device_id"),
        threecx_ref=row.get("threecx_ref"),
    )


@router.get("", response_model=list[Device])
def list_devices(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
    site: str | None = Query(default=None),
    device_type: str | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=5000),
) -> list[Device]:
    where = []
    params: dict[str, object] = {"limit": limit}
    if site:
        where.append("site = :site")
        params["site"] = site
    if device_type:
        where.append("device_type = :device_type")
        params["device_type"] = device_type
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    rows = db.fetch_all(
        engine,
        f"SELECT {_COLUMNS} FROM devices{clause} ORDER BY name LIMIT :limit",
        params,
    )
    return [_to_device(r) for r in rows]


@router.get("/{device_id}", response_model=Device)
def get_device(
    device_id: int,
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> Device:
    row = db.fetch_one(
        engine, f"SELECT {_COLUMNS} FROM devices WHERE id = :id", {"id": device_id}
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="device not found")
    return _to_device(row)
