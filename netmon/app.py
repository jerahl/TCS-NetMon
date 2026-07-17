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

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

WEB_DIR = Path(__file__).resolve().parent / "web"

from netmon import __version__, db, migrate
from netmon import settings as settings_engine
from netmon.api import (
    alerts, auth_routes, devices, events, health, history as history_api, nac,
    registry, search, settings, sites, status, summary, surveillance, switches,
    voip, wireless,
)
from netmon.auth.sessions import DbSessionStore, SessionStore
from netmon.engine.engine import AlertEngine
from netmon.history import HistorySampler
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
from netmon.poller.snmp_inventory import SnmpInventory
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

    if cfg.snmp_inventory.enabled:
        snmp_inv = SnmpInventory.from_config(engine, cfg)
        supervisor.register(
            "snmp_inventory", snmp_inv.run_guarded,
            interval_s=snmp_inv.interval_s, timeout_s=snmp_inv.timeout_s,
        )
        log.info("SNMP inventory sweeps enabled: base interval %ss", snmp_inv.interval_s)

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
            # 10.3: the NAC API reads pf_nodes/snapshot_cache from the DB —
            # the old in-memory app.state.pf snapshot is gone.
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

    if cfg.history.enabled:
        sampler = HistorySampler.from_config(engine, cfg)
        supervisor.register("history", sampler.run_guarded,
                            interval_s=sampler.interval_s, timeout_s=sampler.timeout_s)
        log.info("history sampler enabled: %ss, retain %dh",
                 cfg.history.interval_s, cfg.history.retention_hours)


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg: Config = app.state.config  # set by create_app before the app runs
    app.state.started_at = time.time()  # /api/netmon-status uptime
    app.state.engine = db.make_engine(cfg.db.url)

    if cfg.db.auto_migrate:
        applied = migrate.apply_migrations(app.state.engine)
        if applied:
            log.info("auto-migrate applied: %s", ", ".join(applied))

    # Settings overlay (spec 12): DB overrides on top of the file config.
    # base_config stays the pristine file view (the settings API needs it);
    # everything downstream — routes via get_config, tasks below — sees the
    # overlaid config. Fail-soft: no app_settings table => file config only.
    app.state.base_config = cfg
    cfg = settings_engine.overlay_config(cfg, app.state.engine)
    app.state.config = cfg

    # DB-backed sessions (migration 007): survive restarts, safe for
    # multi-worker uvicorn. If the table is missing (migrations not applied),
    # fall back to the in-process store and say so loudly — logins still work,
    # they just don't survive a restart.
    try:
        db.fetch_one(app.state.engine, "SELECT COUNT(*) FROM sessions")
        app.state.sessions = DbSessionStore(app.state.engine, ttl_seconds=cfg.web.session_ttl)
    except Exception:
        log.warning(
            "sessions table missing (apply migration 007) — using the "
            "in-process session store; sessions will not survive a restart"
        )
        app.state.sessions = SessionStore(ttl_seconds=cfg.web.session_ttl)

    if cfg.auth.saml_debug:
        log.warning(
            "[auth] saml_debug is ON: the SAML ACS dumps assertion attributes "
            "and issues NO session. Turn it off and restart once role mapping "
            "is done."
        )

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
    # Pristine file config; the lifespan overlays DB settings onto
    # app.state.config while the settings API reads/edits against this base.
    app.state.base_config = cfg
    # Bare supervisor; tasks are registered in the lifespan once the engine
    # exists (register_tasks). Tests may inject their own.
    app.state.supervisor = supervisor or Supervisor()
    # Serializes POST /api/settings/apply (config swap + supervisor restart).
    app.state.apply_lock = asyncio.Lock()

    app.include_router(health.router)
    app.include_router(auth_routes.router)
    app.include_router(auth_routes.page_router)
    app.include_router(devices.router)
    app.include_router(status.router)
    app.include_router(sites.router)
    app.include_router(summary.router)
    app.include_router(search.router)
    app.include_router(history_api.router)
    app.include_router(events.router)
    app.include_router(switches.router)
    app.include_router(wireless.router)
    app.include_router(surveillance.router)
    app.include_router(voip.router)
    app.include_router(registry.router)
    app.include_router(nac.router)
    app.include_router(alerts.router)
    app.include_router(settings.router)

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
