"""Bulk camera operations API (spec 20 S8 / D11) — admin only.

The surface an admin drives a firmware roll from. Everything dangerous about it
lives one layer down in `netmon.cameras`; what this module adds is the same set
of rules stated at the edge, because an endpoint that trusts its caller is how a
closed registry stops being closed:

* **Admin, always.** D4's operator actions go through a platform that validates
  them; this goes straight to hardware, and the floor is raised accordingly.
* **Nothing addressable comes from the caller.** A request carries device ids
  and an image id — never a URL, a path, a filename, a command or a model. The
  target is rebuilt from the registry and the image from the store, exactly as
  the snapshot proxy does.
* **Dry-run is the default and has to be turned off twice**: once in config
  (`[camera_ops] dry_run = false`) and once per batch. A caller cannot arm a
  live batch while config says dry-run.
* **Refusals are 409s with the reason**, not 500s. Nothing was sent, and the
  operator gets the sentence rather than a stack trace.

Upload is streamed to disk in chunks and hashed as it lands: the images on this
estate run to 988 MiB, and reading one into memory to hash it would be a
gigabyte of resident data for a checksum.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.engine import Engine

from netmon import db
from netmon.api.deps import current_user, get_engine, require_role
from netmon.cameras import ops
from netmon.cameras.runner import BatchRefused, BatchRunner, load_image
from netmon.config import Config
from netmon.models.schemas import Role

log = logging.getLogger("netmon.api.camera_ops")

router = APIRouter(prefix="/api/surveillance", tags=["camera-ops"])

#: A filename is a name, not a path. Anything else is refused before it reaches
#: the filesystem — this is the one endpoint that writes a file to disk.
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$")
_CHUNK = 8 << 20


def _cfg(request: Request) -> Config:
    return request.app.state.config


def _actor(user) -> str:
    return getattr(user, "username", None) or "unknown"


def _refused(message: str) -> HTTPException:
    return HTTPException(status_code=409, detail=message)


# ── firmware store ────────────────────────────────────────────────────────

@router.get("/firmware")
def list_firmware(engine: Engine = Depends(get_engine),
                  _user=Depends(require_role(Role.admin))) -> list[dict]:
    rows = db.fetch_all(engine, "SELECT * FROM firmware_images ORDER BY vendor, version")
    out = []
    for r in rows:
        row = dict(r)
        row["models"] = json.loads(row.get("models") or "[]")
        out.append(row)
    return out


class RegisterBody(BaseModel):
    """Metadata for an image already in the store."""
    vendor: str = Field(min_length=1, max_length=32)
    version: str = Field(min_length=1, max_length=64)
    filename: str = Field(min_length=1, max_length=128)
    models: list[str] = Field(min_length=1)
    platform: str = ""
    notes: str = ""


@router.put("/firmware/{vendor}/{filename}")
async def upload_firmware(vendor: str, filename: str, request: Request,
                          _user=Depends(require_role(Role.admin))) -> dict:
    """Stream an image into the store. Raw body, not multipart.

    Deliberately not a multipart form: parsing a 988 MiB multipart body needs a
    dependency this project has not taken, and would buy nothing — there is one
    file and its name is already in the path. The body is written straight to
    disk in chunks, so an image larger than memory is a non-event.

    This only *places* the file. Registering it — with the model allow-list and
    platform that decide which cameras may ever receive it — is a second,
    deliberate call.
    """
    cfg = _cfg(request)
    vendor = vendor.strip().lower()
    if not _SAFE_NAME.match(vendor) or not _SAFE_NAME.match(filename.strip()):
        raise _refused("vendor and filename must be plain names — no paths, no separators")
    store = Path(cfg.camera_ops.firmware_dir) / vendor
    store.mkdir(parents=True, exist_ok=True)
    path = store / filename.strip()
    if path.exists():
        raise _refused(f"{filename} is already in the store; remove it deliberately first")

    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("wb") as handle:
            async for chunk in request.stream():
                if chunk:
                    digest.update(chunk)
                    size += len(chunk)
                    handle.write(chunk)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    if size == 0:
        path.unlink(missing_ok=True)
        raise _refused("refusing to store an empty firmware image")
    log.info("firmware image %s/%s stored by an admin (%d bytes, sha %s)",
             vendor, filename, size, digest.hexdigest()[:12])
    return {"vendor": vendor, "filename": path.name, "size_bytes": size,
            "sha256": digest.hexdigest(), "registered": False}


@router.post("/firmware")
def register_firmware(body: RegisterBody, request: Request,
                      engine: Engine = Depends(get_engine),
                      user=Depends(require_role(Role.admin))) -> dict:
    """Register an image that is in the store, hashing it as it is read.

    The allow-list has no "all" value by design: 84 model×firmware pairs live on
    this estate and a wrong image is a truck roll, so an image that names no
    model may touch nothing.

    `platform` is the CPP generation the image is built for. Optional, and worth
    supplying — it is the only one of these checks a machine can make, and it is
    what catches a CPP14 image aimed at a CPP7.3 camera.
    """
    cfg = _cfg(request)
    vendor = body.vendor.strip().lower()
    name = body.filename.strip()
    if not _SAFE_NAME.match(vendor) or not _SAFE_NAME.match(name):
        raise _refused("vendor and filename must be plain names — no paths, no separators")
    models = [m.strip() for m in body.models if m.strip()]
    if not models:
        raise _refused("an image with no model allow-list may touch nothing; name the "
                       "models it is built for")
    path = Path(cfg.camera_ops.firmware_dir) / vendor / name
    if not path.is_file():
        raise _refused(f"{vendor}/{name} is not in the firmware store")

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(chunk)
    sha = digest.hexdigest()
    if db.fetch_one(engine, "SELECT id FROM firmware_images WHERE sha256 = :s", {"s": sha}):
        raise _refused("an image with this SHA-256 is already registered")

    db.execute(engine, """
        INSERT INTO firmware_images
            (vendor, version, platform, filename, rel_path, size_bytes, sha256, models,
             notes, uploaded_by, uploaded_at)
        VALUES (:v, :ver, :pf, :fn, :rel, :sz, :sha, :m, :notes, :by, :at)""",
        {"v": vendor, "ver": body.version.strip(), "pf": body.platform.strip() or None,
         "fn": name, "rel": f"{vendor}/{name}", "sz": path.stat().st_size, "sha": sha,
         "m": json.dumps(models), "notes": body.notes.strip() or None,
         "by": _actor(user), "at": datetime.now(timezone.utc)})
    image_id = int(db.fetch_one(engine, "SELECT MAX(id) AS id FROM firmware_images")["id"])
    log.warning("firmware image %s registered by %s for %s (%s)",
                name, _actor(user), models, body.platform or "no platform stated")
    return {"id": image_id, "filename": name, "size_bytes": path.stat().st_size,
            "sha256": sha, "models": models, "platform": body.platform.strip() or None}


class AmendBody(BaseModel):
    """What may be changed on a registered image, and what may not."""
    models: list[str] | None = None
    platform: str | None = None
    notes: str | None = None


@router.patch("/firmware/{image_id}")
def amend_firmware(image_id: int, body: AmendBody, request: Request,
                   engine: Engine = Depends(get_engine),
                   user=Depends(require_role(Role.admin))) -> dict:
    """Widen (or correct) an image's model allow-list, platform or notes.

    Deliberately narrow: the file, its SHA-256 and its size are **not**
    amendable. Those identify the image that was vetted, and letting them move
    under an existing id would mean a batch created yesterday points at
    different bytes today.

    Widening an allow-list is a real safety decision — it says "this image may
    now reach these cameras too" — so it is logged at warning level with who did
    it and what changed, and an empty list is refused: an image that names no
    model may touch nothing.
    """
    row = db.fetch_one(engine, "SELECT * FROM firmware_images WHERE id = :i", {"i": image_id})
    if row is None:
        raise HTTPException(status_code=404, detail="no such firmware image")
    before = json.loads(row["models"] or "[]")

    fields: dict[str, object] = {}
    if body.models is not None:
        models = [m.strip() for m in body.models if m.strip()]
        if not models:
            raise _refused("an image with no model allow-list may touch nothing")
        fields["models"] = json.dumps(models)
    if body.platform is not None:
        fields["platform"] = body.platform.strip() or None
    if body.notes is not None:
        fields["notes"] = body.notes.strip() or None
    if not fields:
        raise _refused("nothing to change")

    sets = ", ".join(f"{k} = :{k}" for k in fields)
    db.execute(engine, f"UPDATE firmware_images SET {sets} WHERE id = :id",
               {**fields, "id": image_id})
    after = json.loads(fields.get("models", row["models"]) or "[]")
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    log.warning("firmware image %s (%s) amended by %s: models +%s -%s%s",
                image_id, row["version"], _actor(user), added or "none",
                removed or "none",
                f", platform -> {fields['platform']}" if "platform" in fields else "")
    return {"id": image_id, "models": after, "added": added, "removed": removed,
            "platform": fields.get("platform", row["platform"])}


# ── batches ───────────────────────────────────────────────────────────────

class BatchBody(BaseModel):
    op: str = Field(default="firmware_update")
    device_ids: list[int] = Field(min_length=1)
    firmware_id: int | None = None
    dry_run: bool | None = None
    not_before: datetime | None = None


@router.get("/batches")
def list_batches(engine: Engine = Depends(get_engine),
                 _user=Depends(require_role(Role.admin))) -> list[dict]:
    return [dict(r) for r in db.fetch_all(engine, """
        SELECT b.*, f.version AS firmware_version, f.filename AS firmware_filename,
               (SELECT COUNT(*) FROM camera_batch_items i WHERE i.batch_id = b.id) AS items,
               (SELECT COUNT(*) FROM camera_batch_items i WHERE i.batch_id = b.id
                 AND i.status = 'verified') AS verified
        FROM camera_batches b
        LEFT JOIN firmware_images f ON f.id = b.firmware_id
        ORDER BY b.id DESC LIMIT 50""")]


@router.get("/batches/{batch_id}")
def batch_detail(batch_id: int, engine: Engine = Depends(get_engine),
                 _user=Depends(require_role(Role.admin))) -> dict:
    batch = db.fetch_one(engine, """
        SELECT b.*, f.version AS firmware_version, f.filename AS firmware_filename,
               f.platform AS firmware_platform
        FROM camera_batches b LEFT JOIN firmware_images f ON f.id = b.firmware_id
        WHERE b.id = :i""", {"i": batch_id})
    if batch is None:
        raise HTTPException(status_code=404, detail="no such batch")
    items = db.fetch_all(engine, """
        SELECT i.*, d.name, c.ip, c.model, c.platform
        FROM camera_batch_items i
        JOIN devices d ON d.id = i.device_id
        LEFT JOIN cameras c ON c.device_id = i.device_id
        WHERE i.batch_id = :i ORDER BY i.ring, i.id""", {"i": batch_id})
    return {**dict(batch), "items": [dict(r) for r in items]}


@router.post("/batches")
def create_batch(body: BatchBody, request: Request,
                 engine: Engine = Depends(get_engine),
                 user=Depends(require_role(Role.admin))) -> dict:
    """Create a batch and pre-flight it. Sends nothing, whatever the flags say.

    `dry_run` cannot be turned off here while config says dry-run: arming a live
    batch takes an edit to `netmon.conf` as well, so no single request — and no
    single mistake — can put firmware on a camera.
    """
    cfg = _cfg(request)
    image = None
    if body.op == "firmware_update":
        if not body.firmware_id:
            raise _refused("firmware_update needs a firmware_id from the store")
        row = db.fetch_one(engine, "SELECT * FROM firmware_images WHERE id = :i",
                           {"i": body.firmware_id})
        if row is None:
            raise _refused(f"firmware image {body.firmware_id} is not registered")
        image = dict(row)

    dry = cfg.camera_ops.dry_run or (body.dry_run is not False)
    try:
        return ops.create_batch(engine, cfg, op=body.op, device_ids=body.device_ids,
                                image=image, actor=_actor(user), dry_run=dry,
                                not_before=body.not_before)
    except ValueError as exc:
        raise _refused(str(exc)) from exc


@router.post("/batches/{batch_id}/start")
async def start_batch(batch_id: int, request: Request,
                      engine: Engine = Depends(get_engine),
                      user=Depends(require_role(Role.admin))) -> dict:
    """Run a batch. Returns as soon as it is running, not when it finishes.

    A firmware roll takes minutes per ring, so the request must not hold a
    connection open for it. Progress lives in the rows — which is also what
    makes a batch survive a restart with its record intact.
    """
    cfg = _cfg(request)
    running = getattr(request.app.state, "camera_batches", None)
    if running is None:
        running = request.app.state.camera_batches = {}
    if batch_id in running and not running[batch_id]["task"].done():
        raise _refused(f"batch {batch_id} is already running")

    runner = BatchRunner(engine, cfg, batch_id, actor=_actor(user), role="admin")
    try:
        # Fail fast on the guards — flags, schedule, a missing or altered image —
        # so the caller is told now rather than finding a failed batch later.
        batch = db.fetch_one(engine, "SELECT * FROM camera_batches WHERE id = :i",
                             {"i": batch_id})
        if batch is None:
            raise HTTPException(status_code=404, detail="no such batch")
        runner._guard(dict(batch))
        if not batch["dry_run"]:
            load_image(engine, cfg, int(batch["firmware_id"]))
    except BatchRefused as exc:
        raise _refused(str(exc)) from exc

    task = asyncio.create_task(runner.run(), name=f"camera-batch-{batch_id}")
    running[batch_id] = {"task": task, "runner": runner}
    log.warning("camera batch %s started by %s (dry_run=%s)",
                batch_id, _actor(user), bool(batch["dry_run"]))
    return {"batch_id": batch_id, "status": "running", "dry_run": bool(batch["dry_run"])}


@router.post("/batches/{batch_id}/abort")
def abort_batch(batch_id: int, request: Request,
                engine: Engine = Depends(get_engine),
                user=Depends(require_role(Role.admin))) -> dict:
    """Stop a batch between items.

    It cannot interrupt an upload already in flight — a half-written flash is
    worse than a finished one — so this stops the batch progressing rather than
    stopping the camera being written to.
    """
    running = getattr(request.app.state, "camera_batches", {}) or {}
    entry = running.get(batch_id)
    message = f"aborted by {_actor(user)}"
    if entry is not None:
        entry["runner"].abort(message)
        return {"batch_id": batch_id, "status": "aborted"}
    batch = db.fetch_one(engine, "SELECT status FROM camera_batches WHERE id = :i",
                         {"i": batch_id})
    if batch is None:
        raise HTTPException(status_code=404, detail="no such batch")
    if batch["status"] in ("done", "aborted"):
        raise _refused(f"batch {batch_id} is already {batch['status']}")
    BatchRunner(engine, _cfg(request), batch_id).abort(message)
    return {"batch_id": batch_id, "status": "aborted"}


@router.get("/camera-ops")
def camera_ops_status(request: Request,
                      _user=Depends(require_role(Role.admin))) -> dict:
    """What the UI needs to render the tab honestly: which gates are closed."""
    c = _cfg(request).camera_ops
    return {
        "enabled": c.enabled,
        "dry_run": c.dry_run,
        "firmware_update": c.firmware_update,
        "config_change": c.config_change,
        "proving_device_id": c.proving_device_id,
        "canary_count": c.canary_count,
        "ring_size": c.ring_size,
        "max_batch": c.max_batch,
        "abort_pct": c.abort_pct,
        "account_configured": bool(ops.credentials(_cfg(request))[0]),
        # The catalogue is deferred, so the UI must not offer a config-change
        # button that would only ever be refused.
        "config_catalogue": [],
    }
