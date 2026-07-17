"""Settings API — web-editable configuration overlay (docs/spec/12).

Read is admin-gated; writes additionally require ``[security] allow_web_edit``
in netmon.conf (S5), and secret writes require a ``settings_key`` (S4).
Secrets are write-only: no route here ever returns a secret value.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.engine import Engine

from netmon import db, secretbox, settings as reg
from netmon.api.deps import get_engine, require_role
from netmon.config import Config
from netmon.models.schemas import Role, UserSession
from netmon.supervisor import Supervisor

log = logging.getLogger("netmon.api.settings")

router = APIRouter(prefix="/api", tags=["settings"])


def _require_edit(cfg: Config) -> None:
    if not cfg.security.allow_web_edit:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="web settings editing is disabled — set [security] "
                   "allow_web_edit = true in netmon.conf to enable it",
        )


def _audit(engine: Engine, d: reg.SettingDef, action: str, old: str | None,
           new: str | None, who: str) -> None:
    """Append to settings_audit. Secret values are redacted at write time."""
    if d.kind == "secret":
        old = new = None
    db.execute(
        engine,
        "INSERT INTO settings_audit (`key`, action, old_value, new_value, changed_by, changed_at) "
        "VALUES (:k, :a, :o, :n, :by, :at)",
        {"k": d.key, "a": action, "o": old, "n": new, "by": who,
         "at": datetime.now(timezone.utc)},
    )


def _entry(d: reg.SettingDef, base: Config, overrides: dict[str, str | None],
           values: dict, errors: dict[str, str]) -> dict:
    """One GET row: effective value + provenance, secrets masked."""
    fval = reg.file_value(base, d)
    has_override = d.key in overrides
    source = "override" if has_override else (
        "file" if fval != d.default else "default"
    )
    out = {
        "key": d.key, "label": d.label, "description": d.description,
        "kind": d.kind, "secret": d.kind == "secret", "restart": d.restart,
        "source": source, "error": errors.get(d.key),
        "min": d.min, "max": d.max,
    }
    if d.kind == "secret":
        effective = values.get(d.key) if has_override and d.key in values else fval
        out["value"] = None
        out["is_set"] = bool(effective)
    else:
        out["value"] = values.get(d.key) if d.key in values else fval
        out["is_set"] = None
    return out


@router.get("/settings")
def list_settings(
    request: Request,
    engine: Engine = Depends(get_engine),
    _user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    base: Config = request.app.state.base_config
    try:
        overrides = reg.load_overrides(engine)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"app_settings unavailable (run migration 008): {exc}",
        ) from exc
    values, errors = reg.resolve_overrides(overrides, base.security.settings_key)

    groups: list[dict] = []
    for section, label in reg.SECTION_LABELS.items():
        defs = [d for d in reg.REGISTRY if d.section == section]
        if defs:
            groups.append({
                "section": section, "label": label,
                "settings": [_entry(d, base, overrides, values, errors) for d in defs],
            })
    return {
        "edit_enabled": base.security.allow_web_edit,
        "secrets_enabled": bool(base.security.settings_key),
        "restart_pending": [d.key for d in reg.REGISTRY if d.restart and d.key in overrides],
        "groups": groups,
    }


class ValueBody(BaseModel):
    value: bool | int | str | None = None


@router.put("/settings/{key}")
def put_setting(
    key: str,
    body: ValueBody,
    request: Request,
    engine: Engine = Depends(get_engine),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    d = reg.BY_KEY.get(key)
    if d is None:
        raise HTTPException(status_code=404, detail=f"unknown setting {key!r}")
    base: Config = request.app.state.base_config
    _require_edit(base)
    try:
        canon = reg.canonicalize(d, body.value)
    except reg.SettingValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if d.kind == "secret":
        if not base.security.settings_key:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="no [security] settings_key configured — secrets cannot "
                       "be stored. Generate one with: python -c \"import "
                       "secrets; print(secrets.token_hex(32))\" and add it to "
                       "netmon.conf.",
            )
        stored = secretbox.seal(base.security.settings_key, canon)
    else:
        stored = canon

    old = db.fetch_one(engine, "SELECT value FROM app_settings WHERE `key` = :k", {"k": key})
    now = datetime.now(timezone.utc)
    if old is None:
        db.execute(
            engine,
            "INSERT INTO app_settings (`key`, value, is_secret, updated_by, updated_at) "
            "VALUES (:k, :v, :s, :by, :at)",
            {"k": key, "v": stored, "s": int(d.kind == "secret"), "by": user.username, "at": now},
        )
    else:
        db.execute(
            engine,
            "UPDATE app_settings SET value = :v, is_secret = :s, updated_by = :by, "
            "updated_at = :at WHERE `key` = :k",
            {"k": key, "v": stored, "s": int(d.kind == "secret"), "by": user.username, "at": now},
        )
    _audit(engine, d, "set", old["value"] if old else None, canon, user.username)
    log.info("setting %s %s by %s", key, "updated" if old else "overridden", user.username)

    overrides = reg.load_overrides(engine)
    values, errors = reg.resolve_overrides(overrides, base.security.settings_key)
    return _entry(d, base, overrides, values, errors)


@router.delete("/settings/{key}")
def delete_setting(
    key: str,
    request: Request,
    engine: Engine = Depends(get_engine),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    d = reg.BY_KEY.get(key)
    if d is None:
        raise HTTPException(status_code=404, detail=f"unknown setting {key!r}")
    base: Config = request.app.state.base_config
    _require_edit(base)
    old = db.fetch_one(engine, "SELECT value FROM app_settings WHERE `key` = :k", {"k": key})
    if old is None:
        raise HTTPException(status_code=404, detail=f"no override for {key!r}")
    db.execute(engine, "DELETE FROM app_settings WHERE `key` = :k", {"k": key})
    _audit(engine, d, "clear", old["value"], None, user.username)
    log.info("setting %s override cleared by %s", key, user.username)
    return {"status": "cleared", "key": key}


@router.get("/settings/audit")
def settings_audit(
    engine: Engine = Depends(get_engine),
    _user: UserSession = Depends(require_role(Role.admin)),
    limit: int = 100,
) -> list[dict]:
    return db.fetch_all(
        engine,
        "SELECT id, `key`, action, old_value, new_value, changed_by, changed_at "
        "FROM settings_audit ORDER BY id DESC LIMIT :n",
        {"n": max(1, min(limit, 500))},
    )


@router.post("/settings/apply")
async def apply_settings(
    request: Request,
    engine: Engine = Depends(get_engine),
    user: UserSession = Depends(require_role(Role.admin)),
) -> dict:
    """Rebuild the overlaid config and restart the supervised tasks (S7).

    Serialized by an app-level lock; concurrent applies queue. Supervisor
    stats reset (visible on NetMon Status) — honest, not a bug.
    """
    from netmon.app import register_tasks  # local import: app.py imports this router

    app = request.app
    base: Config = app.state.base_config
    _require_edit(base)

    lock: asyncio.Lock = app.state.apply_lock
    async with lock:
        new_cfg = reg.overlay_config(base, engine)
        old_sup: Supervisor = app.state.supervisor
        await old_sup.stop()
        app.state.config = new_cfg
        app.state.supervisor = Supervisor()
        register_tasks(app, new_cfg, engine)
        await app.state.supervisor.start()

    overrides = reg.load_overrides(engine)
    log.info("settings applied by %s: supervisor restarted with %d task(s)",
             user.username, len(app.state.supervisor.specs))
    return {
        "status": "applied",
        "tasks": [s.name for s in app.state.supervisor.specs],
        "restart_required": [d.key for d in reg.REGISTRY if d.restart and d.key in overrides],
    }
