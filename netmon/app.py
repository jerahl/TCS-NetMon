"""FastAPI application factory + lifespan task supervisor.

Boot sequence (lifespan startup):
  1. load + validate config (fail loud on missing secrets)
  2. build the DB engine
  3. optionally apply pending migrations ([db] auto_migrate)
  4. build the session store
  5. start the supervised-task scaffold

Shutdown reverses (4)–(5): the supervisor cancels every task cleanly.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

WEB_DIR = Path(__file__).resolve().parent / "web"

from netmon import __version__, db, migrate
from netmon.api import alerts, auth_routes, devices, health, nac, status
from netmon.auth.sessions import SessionStore
from netmon.engine.engine import AlertEngine
from netmon.collectors.milestone import MilestoneCollector, MilestoneError
from netmon.collectors.packetfence import PfCollector
from netmon.collectors.pf_client import PfError
from netmon.collectors.rconfig import RConfigCollector
from netmon.collectors.rconfig_client import RConfigError
from netmon.collectors.threecx import ThreeCxCollector
from netmon.collectors.threecx_client import ThreeCxError
from netmon.collectors.xiq import XiqCollector
from netmon.collectors.xiq_client import XiqError
from netmon.config import Config, load_config
from netmon.poller.poller import Poller
from netmon.supervisor import Supervisor, _heartbeat

log = logging.getLogger("netmon.app")


def register_tasks(app: FastAPI, cfg: Config, engine) -> None:
    """Register supervised tasks once the engine exists (called in lifespan).

    Always runs the heartbeat self-task; adds the poller and enabled source
    collectors. A misconfigured source is logged and skipped, never fatal.
    """
    supervisor: Supervisor = app.state.supervisor
    supervisor.register("heartbeat", _heartbeat, interval_s=30.0, timeout_s=5.0)

    if cfg.poller.enabled:
        poller = Poller(engine, cfg.poller)  # one instance → shared hysteresis state
        supervisor.register(
            "poller_ping", poller.run_ping,
            interval_s=cfg.poller.ping_interval_s, timeout_s=cfg.poller.ping_interval_s,
        )
        supervisor.register(
            "poller_snmp", poller.run_snmp,
            interval_s=cfg.poller.snmp_interval_s, timeout_s=cfg.poller.snmp_interval_s,
        )
        log.info("poller enabled: ping/%ss, snmp/%ss", cfg.poller.ping_interval_s, cfg.poller.snmp_interval_s)

    if cfg.source_enabled("xiq"):
        try:
            xiq = XiqCollector.from_config(engine, cfg)
        except XiqError as exc:
            log.error("XIQ collector not started: %s", exc)
        else:
            supervisor.register("xiq", xiq.run_guarded, interval_s=xiq.interval_s, timeout_s=xiq.timeout_s)
            log.info("XIQ collector enabled: status/%ss", xiq.interval_s)

    if cfg.source_enabled("packetfence"):
        try:
            pf = PfCollector.from_config(engine, cfg)
        except PfError as exc:
            log.error("PacketFence collector not started: %s", exc)
        else:
            app.state.pf = pf  # NAC endpoint reads its cached snapshot
            supervisor.register("packetfence", pf.run_guarded, interval_s=pf.interval_s, timeout_s=pf.timeout_s)
            log.info("PacketFence collector enabled: %ss", pf.interval_s)

    if cfg.source_enabled("milestone"):
        try:
            ms = MilestoneCollector.from_config(engine, cfg)
        except MilestoneError as exc:
            log.error("Milestone collector not started: %s", exc)
        else:
            supervisor.register("milestone", ms.run_guarded, interval_s=ms.interval_s, timeout_s=ms.timeout_s)
            log.info("Milestone collector enabled: %ss", ms.interval_s)

    if cfg.source_enabled("threecx"):
        try:
            tcx = ThreeCxCollector.from_config(engine, cfg)
        except ThreeCxError as exc:
            log.error("3CX collector not started: %s", exc)
        else:
            supervisor.register("threecx", tcx.run_guarded, interval_s=tcx.interval_s, timeout_s=tcx.timeout_s)
            log.info("3CX collector enabled: %ss", tcx.interval_s)

    if cfg.source_enabled("rconfig"):
        try:
            rc = RConfigCollector.from_config(engine, cfg)
        except RConfigError as exc:
            log.error("rConfig collector not started: %s", exc)
        else:
            supervisor.register("rconfig", rc.run_guarded, interval_s=rc.interval_s, timeout_s=rc.timeout_s)
            log.info("rConfig collector enabled: %ss", rc.interval_s)

    if cfg.engine.enabled:
        alert_engine = AlertEngine(engine, cfg.engine)
        supervisor.register("engine", alert_engine.run_guarded,
                            interval_s=alert_engine.interval_s, timeout_s=alert_engine.timeout_s)
        log.info("alert engine enabled: %ss, shadow=%s", cfg.engine.interval_s, cfg.engine.shadow)


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg: Config = app.state.config  # set by create_app before the app runs
    app.state.engine = db.make_engine(cfg.db.url)

    if cfg.db.auto_migrate:
        applied = migrate.apply_migrations(app.state.engine)
        if applied:
            log.info("auto-migrate applied: %s", ", ".join(applied))

    app.state.sessions = SessionStore(ttl_seconds=cfg.web.session_ttl)

    supervisor: Supervisor = app.state.supervisor
    register_tasks(app, cfg, app.state.engine)
    await supervisor.start()
    try:
        yield
    finally:
        await supervisor.stop()
        app.state.engine.dispose()


def create_app(
    config: Config | None = None,
    supervisor: Supervisor | None = None,
) -> FastAPI:
    """Build the app.

    ``config``/``supervisor`` are injectable for tests; production passes
    neither and the config is loaded from disk.
    """
    cfg = config or load_config()

    app = FastAPI(
        title="TCS NetMon",
        version=__version__,
        description="Federated network/wireless/voice/surveillance monitoring.",
        lifespan=lifespan,
    )
    app.state.config = cfg
    # Bare supervisor; tasks are registered in the lifespan once the engine
    # exists (register_tasks). Tests may inject their own.
    app.state.supervisor = supervisor or Supervisor()

    app.include_router(health.router)
    app.include_router(auth_routes.router)
    app.include_router(devices.router)
    app.include_router(status.router)
    app.include_router(nac.router)
    app.include_router(alerts.router)

    # Static React UI (Phase 4), if built. Guarded so the app still boots when
    # the bundle is absent (fresh clone / API-only dev). Build with
    # `npm --prefix frontend ci && npm --prefix frontend run build`.
    ui_built = (WEB_DIR / "index.html").is_file()

    # Root → the UI (or /docs when the UI isn't built) so visiting the bare host
    # doesn't 404. Registered before the mount.
    @app.get("/", include_in_schema=False)
    def _root() -> RedirectResponse:
        return RedirectResponse(url="/ui/" if ui_built else "/docs")

    if ui_built:
        app.mount("/ui", StaticFiles(directory=WEB_DIR, html=True), name="ui")
    else:
        log.warning("UI bundle not found at %s; /ui disabled (run the frontend build)", WEB_DIR)

    return app
