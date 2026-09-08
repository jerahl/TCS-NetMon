"""The batch executor (spec 20 S8 / D11) — canary, rings, abort, verify.

This is the piece that can actually send something to a camera, so read the
guards before the logic:

* `[camera_ops] enabled` and `firmware_update` must both be true, or the runner
  refuses the batch and says which flag stopped it.
* `dry_run` (default true) walks every step and sends **nothing**.
* `proving_device_id`, while set, means pre-flight has already refused every
  camera but the nominated one — enforced there, not here, so no path around it
  exists.
* Every item goes through the D4 audit chokepoint, so what NetMon sent to a
  device is recorded in one table whatever asked for it.

**The canary is a gate, not a first item.** Ring 0 runs alone and the batch stops
until it verifies. That is the only thing standing between a bad image and the
second camera, so a canary that comes back `indeterminate` — the camera answered,
but in a format that cannot prove the version — halts the batch too. "Probably
worked" is not the evidence a fleet-wide roll should proceed on.

**Verification is a read, never the upload's return code** (S8 condition 7). A
Bosch camera answers the upload long before it has finished flashing, so the
POST returning 200 says only that the bytes arrived. The runner waits for the
device to come back and *report* the new version — vendor read first, Milestone's
value as fallback, and it records which one answered because they are not worth
the same.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy.engine import Engine

from netmon import db
from netmon.actions import ActionRefused, AuditedAction, action_or_refuse
from netmon.cameras import firmware as fw
from netmon.cameras import ops
from netmon.cameras.vendors import profile_for
from netmon.cameras.vendors.bosch import (
    VendorReadUnavailable, VendorWriteUnavailable,
)

log = logging.getLogger("netmon.cameras.runner")

#: How often a camera is asked whether it has come back. A Bosch flash plus
#: reboot is minutes, not seconds, so polling harder buys nothing and adds
#: requests to a device that is mid-upgrade.
POLL_INTERVAL_S = 10.0


class BatchRefused(Exception):
    """The batch may not run at all. Nothing was sent."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _set_item(engine: Engine, item_id: int, **fields: Any) -> None:
    sets = ", ".join(f"{k} = :{k}" for k in fields)
    db.execute(engine, f"UPDATE camera_batch_items SET {sets} WHERE id = :id",
               {**fields, "id": item_id})


def _set_batch(engine: Engine, batch_id: int, **fields: Any) -> None:
    sets = ", ".join(f"{k} = :{k}" for k in fields)
    db.execute(engine, f"UPDATE camera_batches SET {sets} WHERE id = :id",
               {**fields, "id": batch_id})


def load_image(engine: Engine, cfg: Any, image_id: int) -> tuple[dict, Path]:
    """The image row plus its verified path.

    The SHA-256 is re-computed here rather than trusted from upload: an image
    that changed on disk between vetting and roll is not the image that was
    vetted, and the difference is a bricked camera.

    The **path** comes back, not the bytes. These files are not small — the
    CPP14 image on this estate is 988 MiB — and holding one in memory while
    three uploads run concurrently is a gigabyte of resident data for no reason.
    Each upload streams from its own handle instead.
    """
    row = db.fetch_one(engine, "SELECT * FROM firmware_images WHERE id = :i", {"i": image_id})
    if row is None:
        raise BatchRefused(f"firmware image {image_id} is not registered")
    path = Path(cfg.camera_ops.firmware_dir) / str(row["rel_path"])
    if not path.is_file():
        raise BatchRefused(f"firmware image {row['filename']} is missing from the store")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != str(row["sha256"]).lower():
        raise BatchRefused(
            f"firmware image {row['filename']} does not match the SHA-256 recorded at "
            f"upload — refusing to push an image that changed on disk")
    return dict(row), path


class BatchRunner:
    """Runs one batch. Construct, `await run()`, read the rows afterwards."""

    def __init__(self, engine: Engine, cfg: Any, batch_id: int, *,
                 actor: str = "netmon", role: str = "admin",
                 client_factory: Any = None, sleep: Any = None,
                 milestone_firmware: Any = None) -> None:
        self.engine = engine
        self.cfg = cfg
        self.batch_id = batch_id
        self.actor = actor
        self.role = role
        # Injected so every path here is exercised against a fake transport
        # before it is allowed near hardware (S8: "fixture-tested against a fake
        # transport before it ever sees a device").
        self._client_factory = client_factory
        self._sleep = sleep or asyncio.sleep
        self._milestone_firmware = milestone_firmware
        self.aborted = False

    # ── guards ────────────────────────────────────────────────────────────

    def _guard(self, batch: dict) -> None:
        ops_cfg = self.cfg.camera_ops
        if batch["status"] in ("running", "done", "aborted"):
            raise BatchRefused(f"batch {self.batch_id} is already {batch['status']}")
        if batch["dry_run"]:
            return                      # a dry run needs no arming at all
        if not ops_cfg.enabled:
            raise BatchRefused("[camera_ops] enabled = false")
        if batch["op"] == "firmware_update" and not ops_cfg.firmware_update:
            raise BatchRefused("[camera_ops] firmware_update = false")
        if batch["op"] == "config_change" and not ops_cfg.config_change:
            raise BatchRefused("[camera_ops] config_change = false")
        user, password = ops.credentials(self.cfg)
        if not (user and password):
            raise BatchRefused("no camera account configured")
        if batch["not_before"] and _now() < _as_dt(batch["not_before"]):
            raise BatchRefused(f"batch is scheduled for {batch['not_before']}")

    # ── the run ───────────────────────────────────────────────────────────

    async def run(self) -> dict:
        batch = db.fetch_one(self.engine, "SELECT * FROM camera_batches WHERE id = :i",
                             {"i": self.batch_id})
        if batch is None:
            raise BatchRefused(f"batch {self.batch_id} does not exist")
        batch = dict(batch)
        self._guard(batch)

        dry = bool(batch["dry_run"])
        image, path = (None, None)
        if not dry:
            image, path = load_image(self.engine, self.cfg, int(batch["firmware_id"]))
        else:
            row = db.fetch_one(self.engine, "SELECT * FROM firmware_images WHERE id = :i",
                               {"i": batch["firmware_id"]})
            image = dict(row) if row else {"version": "?", "filename": "?"}

        _set_batch(self.engine, self.batch_id, status="running", started_at=_now(),
                   message=None)
        rings = self._rings()
        summary = {"verified": 0, "indeterminate": 0, "failed": 0, "would_run": 0}

        try:
            summary = await self._run_rings(rings, batch, image, path, dry=dry,
                                            summary=summary)
        except Exception as exc:                     # noqa: BLE001 — settle, then re-raise
            # Whatever went wrong, the rows must not be left mid-flight. A batch
            # stuck on "running" is indistinguishable from one still working,
            # which is the shape of staleness this project exists to refuse.
            self._halt(f"batch stopped on an unexpected error: {type(exc).__name__}: "
                       f"{str(exc) or 'no detail'}")
            db.execute(self.engine,
                       "UPDATE camera_batch_items SET status = 'failed', finished_at = :t, "
                       "message = COALESCE(message, :m) WHERE batch_id = :b "
                       "AND status = 'running'",
                       {"t": _now(), "m": f"batch stopped: {type(exc).__name__}",
                        "b": self.batch_id})
            raise

        if not self.aborted:
            _set_batch(self.engine, self.batch_id, status="done", finished_at=_now())
        return {"batch_id": self.batch_id, "dry_run": dry, **summary,
                "aborted": self.aborted}

    async def _run_rings(self, rings: list, batch: dict, image: dict, path: Path | None,
                         *, dry: bool, summary: dict) -> dict:
        for ring_index, items in rings:
            if self.aborted:
                break
            results = await self._run_ring(items, batch, image, path, dry=dry)
            for status in results:
                summary[status] = summary.get(status, 0) + 1

            if dry:
                continue
            # The canary gate. Ring 0 is one camera (or `canary_count` of them)
            # and the batch does not continue unless every one of them *proved*
            # it landed. `indeterminate` stops here too: a roll should not
            # proceed on "probably worked".
            if ring_index == 0:
                if any(s != ops.VERIFIED for s in results):
                    self._halt("canary did not verify — batch stopped before the "
                               "second camera")
                    break
                continue
            bad = sum(1 for s in results if s in (ops.FAILED, ops.INDETERMINATE))
            pct = (bad * 100) // max(1, len(results))
            if pct > int(batch["abort_pct"]):
                self._halt(f"ring {ring_index} failed {pct}% (threshold "
                           f"{batch['abort_pct']}%) — batch halted")
                break
        return summary

    def _rings(self) -> list[tuple[int, list[dict]]]:
        rows = db.fetch_all(
            self.engine,
            "SELECT i.*, d.name, c.ip, c.model, c.vendor, c.https_enabled, c.https_port "
            "FROM camera_batch_items i "
            "JOIN devices d ON d.id = i.device_id "
            "LEFT JOIN cameras c ON c.device_id = i.device_id "
            "WHERE i.batch_id = :b AND i.status IN ('pending','would_run') "
            "ORDER BY i.ring, i.id", {"b": self.batch_id})
        out: dict[int, list[dict]] = {}
        for r in rows:
            out.setdefault(int(r["ring"]), []).append(dict(r))
        return sorted(out.items())

    def _halt(self, message: str) -> None:
        self.aborted = True
        _set_batch(self.engine, self.batch_id, status="aborted", finished_at=_now(),
                   message=message)
        # Everything not yet attempted is skipped with the same reason, so the
        # batch page explains itself without anyone reading a log.
        db.execute(self.engine,
                   "UPDATE camera_batch_items SET status = 'skipped', message = :m "
                   "WHERE batch_id = :b AND status IN ('pending','would_run')",
                   {"m": message, "b": self.batch_id})
        log.warning("camera batch %s halted: %s", self.batch_id, message)

    def abort(self, message: str = "aborted by an operator") -> None:
        self._halt(message)

    async def _run_ring(self, items: list[dict], batch: dict, image: dict,
                        path: Path | None, *, dry: bool) -> list[str]:
        sem = asyncio.Semaphore(max(1, int(batch["max_concurrent"])))

        async def one(item: dict) -> str:
            async with sem:
                return await self._run_item(item, batch, image, path, dry=dry)

        return list(await asyncio.gather(*(one(i) for i in items)))

    async def _run_item(self, item: dict, batch: dict, image: dict, path: Path | None,
                        *, dry: bool) -> str:
        item_id = int(item["id"])
        device_id = int(item["device_id"])
        target = f"{item.get('name')} ({item.get('ip')})"

        if dry:
            _set_item(self.engine, item_id, status=ops.WOULD_RUN, finished_at=_now(),
                      message=f"would upload {image.get('filename')} "
                              f"({image.get('version')})")
            return ops.WOULD_RUN

        profile = profile_for(item.get("vendor"))
        if profile is None:                      # pre-flight caught this already
            _set_item(self.engine, item_id, status=ops.FAILED, finished_at=_now(),
                      message="no vendor profile")
            return ops.FAILED

        _set_item(self.engine, item_id, status=ops.RUNNING, started_at=_now())
        base = _base_url(item)

        # The last gate, and the one that is machine-checked rather than typed.
        # An image built for another CPP generation meets "flash type
        # incompatible" at best; the model allow-list cannot catch it, because
        # allow-lists are written by people and this is exactly the mistake a
        # person makes (found live 2026-09-08, before anything was pushed).
        declared = str(image.get("platform") or "").strip()
        if declared:
            found = await self._probe_platform(item, base)
            if found and found != declared:
                message = (f"camera is {found}; this image is built for {declared} — "
                           f"refusing rather than risking a wrong-platform flash")
                _set_item(self.engine, item_id, status=ops.FAILED, finished_at=_now(),
                          message=message)
                log.warning("camera batch %s: %s (%s)", self.batch_id, message,
                            item.get("name"))
                return ops.FAILED
            if found:
                db.execute(self.engine,
                           "UPDATE cameras SET platform = :p WHERE device_id = :d",
                           {"p": found, "d": device_id})
        try:
            spec = action_or_refuse("camera_firmware_update")
        except ActionRefused as exc:             # registry drift; refuse loudly
            _set_item(self.engine, item_id, status=ops.FAILED, finished_at=_now(),
                      message=str(exc))
            return ops.FAILED

        with AuditedAction(self.engine, spec, actor=self.actor, role=self.role,
                           device_id=device_id, target=target,
                           params={"image": image.get("filename"),
                                   "version": image.get("version"),
                                   "batch_id": self.batch_id}) as audit:
            user, password = ops.credentials(self.cfg)
            ops_cfg = self.cfg.camera_ops
            timeout = httpx.Timeout(ops_cfg.timeout_s, connect=ops_cfg.connect_timeout_s)
            factory = self._client_factory or (
                lambda: httpx.AsyncClient(timeout=timeout, verify=ops_cfg.verify_ssl))
            # ONE auth object for both requests below, deliberately. Digest is a
            # challenge/response: the first request goes out unauthenticated,
            # collects a 401, and is repeated with credentials. For a 91 MiB
            # image that means shipping the whole file to be told "authenticate
            # first" — and this camera drops the connection rather than reading
            # it, which is what killed both live attempts at 0.8 s.
            #
            # So a cheap GET collects the challenge first. httpx caches it on the
            # auth object, and the upload then goes out authenticated on its
            # first and only send.
            auth = httpx.DigestAuth(user, password)
            # Its own handle, streamed: one 988 MiB image times three concurrent
            # uploads is a gigabyte of resident data that buys nothing.
            try:
                # A profile that will not build the request refuses here, before
                # a socket is opened — the batch item says why, and no camera is
                # touched.
                with open(path, "rb") as handle:                # noqa: PTH123
                    request = profile.firmware_upload_request(base, str(image["filename"]),
                                                              handle)
                    async with factory() as client:
                        if hasattr(profile, "version_read_request"):
                            await client.get(profile.version_read_request(base)["url"],
                                             auth=auth)
                        resp = await client.post(request["url"], files=request["files"],
                                                 auth=auth)
            except VendorWriteUnavailable as exc:
                audit.failed(str(exc))
                _set_item(self.engine, item_id, status=ops.FAILED, finished_at=_now(),
                          audit_id=audit.audit_id, message=str(exc))
                return ops.FAILED
            except (httpx.HTTPError, OSError) as exc:
                # The camera closing the connection mid-upload is a *failure of
                # this item*, not of the batch. Letting it propagate killed the
                # run and left the rows saying "running" forever — a monitoring
                # system that lies about its own state (found live 2026-09-08).
                #
                # The class is the diagnosis and `str()` on several httpx errors
                # is empty, so the class name is what gets recorded.
                reason = (f"{type(exc).__name__} during upload: "
                          f"{str(exc) or 'no detail from the transport'}")
                audit.failed(reason)
                _set_item(self.engine, item_id, status=ops.FAILED, finished_at=_now(),
                          audit_id=audit.audit_id, message=reason)
                log.warning("camera batch %s: upload to %s failed: %s",
                            self.batch_id, item.get("name"), reason)
                return ops.FAILED
            status_code = getattr(resp, "status_code", 0)
            if status_code >= 400:
                audit.failed(f"upload answered HTTP {status_code}", http_status=status_code)
                _set_item(self.engine, item_id, status=ops.FAILED, finished_at=_now(),
                          audit_id=audit.audit_id,
                          message=f"upload answered HTTP {status_code}")
                return ops.FAILED
            audit.ok("upload accepted; awaiting read-back", http_status=status_code)

        # The upload returning 200 means the bytes arrived, nothing more. What
        # counts is the device coming back and reporting the new version.
        status, reported, by = await self._verify(item, base, str(image["version"]),
                                                  int(batch["reboot_timeout_s"]))
        _set_item(self.engine, item_id, status=status, finished_at=_now(),
                  after_value=reported, verified_by=by, audit_id=audit.audit_id,
                  message={
                      ops.VERIFIED: f"reported {reported}",
                      ops.INDETERMINATE: f"reported {reported!r}, which cannot prove "
                                         f"{image['version']}",
                      ops.FAILED: f"did not reach {image['version']} "
                                  f"(last seen {reported!r})",
                  }.get(status))
        return status

    async def _verify(self, item: dict, base: str, version: str,
                      timeout_s: int) -> tuple[str, str | None, str | None]:
        """Poll until the camera reports a version, or the timeout expires.

        Vendor read first because it is per camera and immediate; Milestone's
        value as fallback because the vendor read is not available on Bosch yet
        (the RCP+ command code is undocumented — see the profile). `verified_by`
        records which answered: a Milestone-sourced confirmation is weaker
        evidence, being at most one identity-backfill cycle old, and the item
        should not pretend otherwise.
        """
        # Counted in polls rather than wall-clock, so an injected sleep in tests
        # actually shortens the wait instead of leaving the loop spinning
        # against a clock nothing advances.
        attempts = max(1, int(max(30.0, float(timeout_s)) // POLL_INTERVAL_S))
        last: str | None = None
        for _ in range(attempts):
            await self._sleep(POLL_INTERVAL_S)
            reported, by = await self._read_version(item, base)
            if reported:
                last = reported
                verdict = fw.verify(reported, version)
                if verdict == fw.VERIFIED:
                    return ops.VERIFIED, reported, by
                if verdict == fw.INDETERMINATE:
                    return ops.INDETERMINATE, reported, by
                # MISMATCH: still on the old version. Keep waiting — a camera
                # mid-flash reports the old version right up until it reboots.
        return ops.FAILED, last, None

    async def _probe_platform(self, item: dict, base: str) -> str | None:
        """Ask the camera which generation it is, or None if it will not say.

        None does not wave the camera through: a declared image platform with an
        unreadable camera platform leaves the decision to the model allow-list,
        which is the weaker of the two checks and is why this one exists. The
        caller treats only a *contradiction* as fatal, because a camera that
        cannot be asked is a camera whose upload will fail safely at the vendor's
        own signature and flash-type checks.
        """
        profile = profile_for(item.get("vendor"))
        if profile is None or not hasattr(profile, "platform_probe_requests"):
            return None
        user, password = ops.credentials(self.cfg)
        ops_cfg = self.cfg.camera_ops
        timeout = httpx.Timeout(ops_cfg.timeout_s, connect=ops_cfg.connect_timeout_s)
        factory = self._client_factory or (
            lambda: httpx.AsyncClient(timeout=timeout, verify=ops_cfg.verify_ssl))
        try:
            async with factory() as client:
                for probe in profile.platform_probe_requests(base):
                    resp = await client.get(probe["url"],
                                            auth=httpx.DigestAuth(user, password))
                    if (getattr(resp, "status_code", 0) < 400
                            and profile.answered(getattr(resp, "text", "") or "")):
                        return str(probe["platform"])
        except Exception as exc:                 # noqa: BLE001 — a probe is not a push
            log.warning("platform probe failed for %s: %r", item.get("name"), exc)
        return None

    async def _read_version(self, item: dict, base: str) -> tuple[str | None, str | None]:
        """The camera's own answer, or Milestone's if the camera will not give one.

        Vendor first because it is immediate and precise: Bosch's
        CONF_SOFTWARE_VERSION_FORMATTED returns `<major>.<minor>.<build>`, which
        is the precision `firmware.verify` needs to say VERIFIED rather than
        INDETERMINATE. Milestone's value is at most one identity-backfill cycle
        old and is often the compact `783` form, so it can confirm a release but
        rarely a build — hence `verified_by`, so the two are never confused.
        """
        profile = profile_for(item.get("vendor"))
        if profile is not None and hasattr(profile, "version_read_request"):
            try:
                request = profile.version_read_request(base)
                user, password = ops.credentials(self.cfg)
                ops_cfg = self.cfg.camera_ops
                timeout = httpx.Timeout(ops_cfg.timeout_s, connect=ops_cfg.connect_timeout_s)
                factory = self._client_factory or (
                    lambda: httpx.AsyncClient(timeout=timeout, verify=ops_cfg.verify_ssl))
                async with factory() as client:
                    resp = await client.get(request["url"],
                                            auth=httpx.DigestAuth(user, password))
                if getattr(resp, "status_code", 0) < 400:
                    version = request["parse"](getattr(resp, "text", "") or "")
                    if version:
                        return version, "vendor"
            except VendorReadUnavailable:
                pass
            except Exception as exc:             # noqa: BLE001 — fall back, loudly
                log.warning("vendor firmware read failed for %s: %r", item.get("name"), exc)
        if self._milestone_firmware is not None:
            return self._milestone_firmware(int(item["device_id"])), "milestone"
        row = db.fetch_one(self.engine, "SELECT firmware FROM cameras WHERE device_id = :d",
                           {"d": item["device_id"]})
        return ((row or {}).get("firmware"), "milestone")


def _base_url(item: dict) -> str:
    """Where this camera answers, from the stored row — never a caller's string.

    Same rule as the snapshot proxy: the address is rebuilt from the `cameras`
    row, so a batch can only ever reach an address Milestone registered.
    """
    ip = str(item.get("ip") or "").strip()
    if not ip:
        raise BatchRefused("camera has no registered address")
    tls = item.get("https_enabled") == 1
    scheme = "https" if tls else "http"
    port = item.get("https_port") if tls else None
    default = 443 if tls else 80
    hostport = f"{ip}:{port}" if port and int(port) != default else ip
    return f"{scheme}://{hostport}"


def _as_dt(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(str(value)).replace(tzinfo=timezone.utc)


def image_models(image: dict) -> list[str]:
    return list(json.loads(image.get("models") or "[]"))
