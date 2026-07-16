"""Liveness/readiness (unauthenticated) + self-health routes (viewer role):
collector-health pills, the NetMon Status page feed (spec 11 D2), UI meta."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from sqlalchemy.engine import Engine

from netmon import __version__, db
from netmon.api.deps import get_config, get_engine, require_role
from netmon.config import Config
from netmon.models.schemas import (
    CollectorHealth,
    HealthResponse,
    NetmonDbStats,
    NetmonStatus,
    Role,
    SupervisedTask,
    UiMeta,
)

router = APIRouter(tags=["health"])


@router.get("/healthz", response_model=HealthResponse)
def healthz(engine: Engine = Depends(get_engine)) -> HealthResponse:
    db_ok = db.healthcheck(engine)
    # Liveness stays "ok" even when the DB is down — the process is up and can
    # report the degraded dependency (fail loud, not silent: §4.5).
    return HealthResponse(status="ok", version=__version__, db_ok=db_ok)


_COLLECTOR_HEALTH_SQL = """
SELECT name, last_start, last_success, last_error, duration_ms,
       records_written, consecutive_failures, updated_at
FROM collector_health
ORDER BY name
"""


def _derive_status(consecutive_failures: int, last_success) -> str:
    """Honest roll-up for the source-health pills (§4.5 fail-loud).

    A collector with failures reads ``error`` even if it once succeeded; one
    that has never succeeded reads ``unknown`` (never ``ok``); otherwise ``ok``.
    Staleness (last_success too old for the collector's interval) is judged in
    the UI, which knows each pill's cadence.
    """
    if consecutive_failures and consecutive_failures > 0:
        return "error"
    if last_success is None:
        return "unknown"
    return "ok"


def _collector_health_rows(engine: Engine) -> list[CollectorHealth]:
    out: list[CollectorHealth] = []
    for r in db.fetch_all(engine, _COLLECTOR_HEALTH_SQL):
        failures = r.get("consecutive_failures") or 0
        out.append(
            CollectorHealth(
                name=r["name"],
                status=_derive_status(failures, r.get("last_success")),
                last_start=r.get("last_start"),
                last_success=r.get("last_success"),
                last_error=r.get("last_error"),
                duration_ms=r.get("duration_ms"),
                records_written=r.get("records_written"),
                consecutive_failures=failures,
                updated_at=r.get("updated_at"),
            )
        )
    return out


@router.get("/api/collector-health", response_model=list[CollectorHealth])
def collector_health(
    engine: Engine = Depends(get_engine),
    _user=Depends(require_role(Role.viewer)),
) -> list[CollectorHealth]:
    return _collector_health_rows(engine)


@router.get("/api/meta", response_model=UiMeta)
def ui_meta(
    cfg: Config = Depends(get_config),
    _user=Depends(require_role(Role.viewer)),
) -> UiMeta:
    return UiMeta(
        version=__version__,
        zabbix_url=cfg.web.zabbix_url,
        ssheasy_url=cfg.web.ssheasy_url,
    )


def _count(engine: Engine, sql: str, params: dict | None = None) -> int:
    row = db.fetch_one(engine, sql, params)
    return int(next(iter(row.values())) or 0) if row else 0


def _db_stats(engine: Engine, sessions_active: int) -> NetmonDbStats:
    # The 24 h cutoff is computed in Python so the comparison is portable
    # across MariaDB and SQLite (same idiom as /api/events/stats).
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    return NetmonDbStats(
        devices_total=_count(engine, "SELECT COUNT(*) FROM devices"),
        devices_enabled=_count(engine, "SELECT COUNT(*) FROM devices WHERE enabled = 1"),
        state_rows=_count(engine, "SELECT COUNT(*) FROM device_state"),
        events_total=_count(engine, "SELECT COUNT(*) FROM state_events"),
        events_24h=_count(
            engine,
            "SELECT COUNT(*) FROM state_events WHERE occurred_at >= :cutoff",
            {"cutoff": cutoff},
        ),
        alerts_open=_count(engine, "SELECT COUNT(*) FROM alerts WHERE closed_at IS NULL"),
        notifications_shadow=_count(
            engine, "SELECT COUNT(*) FROM notifications WHERE shadow = 1"
        ),
        sessions_active=sessions_active,
    )


@router.get("/api/netmon-status", response_model=NetmonStatus)
def netmon_status(
    request: Request,
    engine: Engine = Depends(get_engine),
    cfg: Config = Depends(get_config),
    _user=Depends(require_role(Role.viewer)),
) -> NetmonStatus:
    """Self-health for the NetMon Status page (spec 11 D2) — the standalone
    replacement for ZCD's Zabbix Status page. Supervisor stats are the running
    process's view (they reset on restart); collector rows come from
    ``collector_health`` and survive restarts."""
    supervisor = getattr(request.app.state, "supervisor", None)
    tasks: list[SupervisedTask] = []
    if supervisor is not None:
        running = supervisor.running_names()
        for spec in supervisor.specs:
            stats = supervisor.stats.get(spec.name)
            last_run = (
                datetime.fromtimestamp(stats.last_run_at, tz=timezone.utc)
                if stats and stats.last_run_at
                else None
            )
            tasks.append(
                SupervisedTask(
                    name=spec.name,
                    enabled=spec.enabled,
                    running=spec.name in running,
                    interval_s=spec.interval_s,
                    timeout_s=spec.timeout_s,
                    runs=stats.runs if stats else 0,
                    failures=stats.failures if stats else 0,
                    last_run_at=last_run,
                    last_error=stats.last_error if stats else None,
                )
            )

    started_at = getattr(request.app.state, "started_at", None)
    sessions = getattr(request.app.state, "sessions", None)
    return NetmonStatus(
        version=__version__,
        started_at=(
            datetime.fromtimestamp(started_at, tz=timezone.utc) if started_at else None
        ),
        uptime_s=(time.time() - started_at) if started_at else None,
        db_ok=db.healthcheck(engine),
        engine_enabled=cfg.engine.enabled,
        engine_shadow=cfg.engine.shadow,
        poller_enabled=cfg.poller.enabled,
        snmp_inventory_enabled=cfg.snmp_inventory.enabled,
        tasks=tasks,
        collectors=_collector_health_rows(engine),
        db=_db_stats(engine, sessions.count() if sessions is not None else 0),
    )
