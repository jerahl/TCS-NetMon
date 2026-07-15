"""Poller status: JSON API + a minimal server-rendered HTML page.

The React UI is Phase 4; this page is deliberately plain HTML (no JS, no CDN)
so the poller's output is inspectable now.
"""

from __future__ import annotations

import html

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import get_engine, require_role
from netmon.models.schemas import DeviceStatus, DimensionState, Role, Severity

router = APIRouter(tags=["status"])

_STATUS_SQL = """
SELECT d.id, d.name, d.site, d.device_type, d.mgmt_ip,
       ps.value AS ping_value, ps.severity AS ping_sev, ps.updated_at AS ping_at,
       ss.value AS snmp_value, ss.severity AS snmp_sev, ss.updated_at AS snmp_at,
       src.value AS src_value, src.severity AS src_sev, src.updated_at AS src_at,
       cb.value AS cb_value, cb.severity AS cb_sev, cb.updated_at AS cb_at,
       rec.value AS rec_value, rec.severity AS rec_sev, rec.updated_at AS rec_at,
       trk.value AS trk_value, trk.severity AS trk_sev, trk.updated_at AS trk_at
FROM devices d
LEFT JOIN device_state ps ON ps.device_id = d.id AND ps.dimension = 'ping'
LEFT JOIN device_state ss ON ss.device_id = d.id AND ss.dimension = 'snmp'
LEFT JOIN device_state src ON src.device_id = d.id AND src.dimension = 'source_status'
LEFT JOIN device_state cb ON cb.device_id = d.id AND cb.dimension = 'config_backup'
LEFT JOIN device_state rec ON rec.device_id = d.id AND rec.dimension = 'recording'
LEFT JOIN device_state trk ON trk.device_id = d.id AND trk.dimension = 'trunk'
WHERE d.enabled = 1
ORDER BY d.name
"""


def _severity(v) -> Severity:
    try:
        return Severity(v) if v else Severity.unknown
    except ValueError:
        return Severity.unknown


def _rows(engine: Engine) -> list[DeviceStatus]:
    out: list[DeviceStatus] = []
    for r in db.fetch_all(engine, _STATUS_SQL):
        out.append(
            DeviceStatus(
                id=r["id"],
                name=r["name"],
                site=r.get("site"),
                device_type=r["device_type"],
                mgmt_ip=r.get("mgmt_ip"),
                ping=DimensionState(
                    value=r.get("ping_value"),
                    severity=_severity(r.get("ping_sev")),
                    updated_at=r.get("ping_at"),
                ),
                snmp=DimensionState(
                    value=r.get("snmp_value"),
                    severity=_severity(r.get("snmp_sev")),
                    updated_at=r.get("snmp_at"),
                ),
                source_status=DimensionState(
                    value=r.get("src_value"),
                    severity=_severity(r.get("src_sev")),
                    updated_at=r.get("src_at"),
                ),
                config_backup=DimensionState(
                    value=r.get("cb_value"),
                    severity=_severity(r.get("cb_sev")),
                    updated_at=r.get("cb_at"),
                ),
                recording=DimensionState(
                    value=r.get("rec_value"),
                    severity=_severity(r.get("rec_sev")),
                    updated_at=r.get("rec_at"),
                ),
                trunk=DimensionState(
                    value=r.get("trk_value"),
                    severity=_severity(r.get("trk_sev")),
                    updated_at=r.get("trk_at"),
                ),
            )
        )
    return out


@router.get("/api/status", response_model=list[DeviceStatus])
def status_json(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[DeviceStatus]:
    return _rows(engine)


_SEV_COLOR = {"ok": "#1fb75a", "warn": "#e8a415", "crit": "#e5484d", "unknown": "#888"}


def _cell(state: DimensionState) -> str:
    color = _SEV_COLOR.get(state.severity.value, "#888")
    val = html.escape(state.value or "—")
    return f'<td style="color:{color};font-weight:600">{val}</td>'


@router.get("/status", response_class=HTMLResponse)
def status_page(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> HTMLResponse:
    rows = _rows(engine)
    body = [
        "<!doctype html><meta charset=utf-8><title>NetMon status</title>",
        "<style>body{font:14px system-ui;margin:1.5rem;background:#161826;color:#e9e9ed}"
        "table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;border-bottom:1px solid #333;text-align:left}"
        "th{font-size:11px;letter-spacing:.05em;color:#888;text-transform:uppercase}</style>",
        f"<h2>Device status <span style='color:#888;font-weight:400'>({len(rows)} devices)</span></h2>",
        "<table><tr><th>Name</th><th>Site</th><th>Type</th><th>Mgmt IP</th>"
        "<th>Ping</th><th>SNMP</th><th>Source</th></tr>",
    ]
    for d in rows:
        body.append(
            "<tr>"
            f"<td>{html.escape(d.name)}</td>"
            f"<td>{html.escape(d.site or '—')}</td>"
            f"<td>{html.escape(d.device_type.value)}</td>"
            f"<td>{html.escape(d.mgmt_ip or '—')}</td>"
            f"{_cell(d.ping)}{_cell(d.snmp)}{_cell(d.source_status)}"
            "</tr>"
        )
    body.append("</table>")
    return HTMLResponse("".join(body))
