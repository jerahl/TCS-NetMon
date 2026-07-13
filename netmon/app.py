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

from fastapi import FastAPI

from netmon import __version__, db, migrate
from netmon.api import auth_routes, devices, health, status
from netmon.auth.sessions import SessionStore
from netmon.config import Config, load_config
from netmon.poller.poller import Poller
from netmon.supervisor import Supervisor, _heartbeat

log = logging.getLogger("netmon.app")


def register_tasks(supervisor: Supervisor, cfg: Config, engine) -> None:
    """Register supervised tasks once the engine exists (called in lifespan).

    Always runs the heartbeat self-task; adds the poller tasks when
    ``[poller] enabled``. Collectors (Phase 3+) register here too.
    """
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
    register_tasks(supervisor, cfg, app.state.engine)
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

    return app
