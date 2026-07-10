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
from netmon.api import auth_routes, devices, health
from netmon.auth.sessions import SessionStore
from netmon.config import Config, load_config
from netmon.supervisor import Supervisor, build_default_supervisor

log = logging.getLogger("netmon.app")


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
    app.state.supervisor = supervisor or build_default_supervisor()

    app.include_router(health.router)
    app.include_router(auth_routes.router)
    app.include_router(devices.router)

    return app
