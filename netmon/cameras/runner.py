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
from netmon.cameras.platforms import compatible, platform_for, probe_agrees
from netmon.collectors.milestone_client import TASK_UPDATE_HARDWARE
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
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(8 << 20), b""):
                digest.update(chunk)
    except OSError as exc:
        # A store the service cannot read is a configuration problem with a
        # one-line fix, and it must say so. Left unhandled this surfaced as a
        # bare HTTP 500 to the operator (found live 2026-09-09: the images were
        # placed as root 0640, and netmon.service runs as `netmon`).
        raise BatchRefused(
            f"cannot read {row['filename']} from the firmware store: {exc.strerror or exc}. "
            f"The store must be readable by the user the service runs as — "
            f"`chown -R root:netmon {cfg.camera_ops.firmware_dir} && "
            f"chmod -R g+rX {cfg.camera_ops.firmware_dir}`") from exc
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
                 milestone_firmware: Any = None,
                 milestone_client: Any = None) -> None:
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
        #: Callable returning a MilestoneClient, or None. Injected so the
        #: runner never builds one itself and tests never reach a network.
        self._milestone_client = milestone_client
        #: Log "this VMS cannot do it" once per batch, not once per camera.
        self._refresh_unsupported_logged = False
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
            "SELECT i.*, d.name, c.ip, c.model, c.vendor, c.https_enabled, c.https_port, "
            # The Milestone hardware GUID, for the post-flash VMS refresh.
            "c.hardware_id "
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
            table = platform_for(item.get("model"))
            # The probe proves a band; the vendor table names the point. A
            # camera whose model the table knows is judged on the table, and the
            # probe is used to catch the table being wrong about this device.
            if found and table and probe_agrees(found, table) is False:
                message = (f"camera answers as {found} but the vendor table calls "
                           f"{item.get('model')!r} {table} — refusing until that is "
                           f"resolved")
                _set_item(self.engine, item_id, status=ops.FAILED, finished_at=_now(),
                          message=message)
                log.warning("camera batch %s: %s (%s)", self.batch_id, message,
                            item.get("name"))
                return ops.FAILED
            effective = table or found
            if effective and compatible(declared, effective) is not True:
                message = (f"camera is {effective}; this image is built for {declared} — "
                           f"refusing rather than risking a wrong-platform flash")
                _set_item(self.engine, item_id, status=ops.FAILED, finished_at=_now(),
                          message=message)
                log.warning("camera batch %s: %s (%s)", self.batch_id, message,
                            item.get("name"))
                return ops.FAILED
            if effective:
                db.execute(self.engine,
                           "UPDATE cameras SET platform = :p WHERE device_id = :d",
                           {"p": effective, "d": device_id})
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
        # The registry has to learn what the camera just told us, or this device
        # is offered the same image again on the next roll (see
        # `record_observed_firmware`). Only reached on a real run — the dry path
        # returned at WOULD_RUN long before this — and only on a VERIFIED
        # reading, because an unprovable one would block the retry this camera
        # still needs.
        if status == ops.VERIFIED:
            record_observed_firmware(self.engine, device_id, reported)
            # NetMon's registry is now right, but Milestone's is not: its
            # `hardwareDriverSettings.firmwareVersion` is a cache that does not
            # move after a flash. Ask it to re-detect. Off by default, and
            # deliberately *after* the item's own outcome is decided — a failed
            # refresh must never turn a good flash into a failure, so it is
            # logged and audited rather than raised.
            if getattr(self.cfg.camera_ops, "milestone_refresh", False):
                await self._refresh_in_milestone(item, device_id, target)
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

    async def _refresh_in_milestone(self, item: dict, device_id: int,
                                    target: str) -> None:
        """Ask Milestone to re-read this camera, audited, never fatal.

        Best-effort by design. The flash already succeeded and was verified
        against the camera itself; if the VMS will not re-detect, the right
        outcome is a loud audit row and a warning, not a batch that reports
        failure for a camera which is demonstrably running the new firmware.
        """
        hardware_id = str(item.get("hardware_id") or "").strip()
        if not hardware_id:
            log.warning("no Milestone hardware id for %s — cannot refresh the VMS view",
                        item.get("name"))
            return
        try:
            spec = action_or_refuse("milestone_update_hardware")
        except ActionRefused as exc:
            log.error("milestone refresh refused: %s", exc)
            return
        client = self._milestone_client() if self._milestone_client else None
        if client is None:
            log.warning("milestone refresh enabled but no Milestone client is "
                        "configured — skipping for %s", item.get("name"))
            return
        # A VMS that does not offer the task is a capability gap, not a fault:
        # on this estate no hardware advertises UpdateHardware at all. Detect it
        # *before* opening an audit row, so a supported-nowhere feature does not
        # write a "failed" row per camera and make a clean roll look broken. It
        # is logged once per batch rather than per camera for the same reason.
        try:
            available = await client.hardware_tasks(hardware_id)
        except Exception as exc:                          # noqa: BLE001 — never fatal
            log.warning("could not read Milestone tasks for %s: %r", item.get("name"), exc)
            return
        if TASK_UPDATE_HARDWARE not in available:
            if not self._refresh_unsupported_logged:
                self._refresh_unsupported_logged = True
                log.warning(
                    "milestone_refresh is on but this VMS does not offer %s "
                    "(hardware advertises %s) — skipping it for this batch",
                    TASK_UPDATE_HARDWARE, available or "nothing")
            return

        with AuditedAction(self.engine, spec, actor=self.actor, role=self.role,
                           device_id=device_id, target=target,
                           params={"hardware_id": hardware_id,
                                   "batch_id": self.batch_id}) as audit:
            try:
                status_code, body = await client.update_hardware(hardware_id)
            except Exception as exc:                      # noqa: BLE001 — never fatal
                audit.failed(f"UpdateHardware failed: {exc!r}")
                log.warning("milestone refresh failed for %s: %r", item.get("name"), exc)
                return
            if status_code >= 400:
                audit.failed(f"UpdateHardware answered HTTP {status_code}: {body[:200]}",
                             http_status=status_code)
                log.warning("milestone refresh for %s answered HTTP %s",
                            item.get("name"), status_code)
            else:
                audit.ok("Milestone asked to re-detect the camera",
                         http_status=status_code)

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


def record_observed_firmware(engine: Engine, device_id: int, reported: str | None) -> bool:
    """Persist the version a camera reported about itself. Returns True if changed.

    Without this the registry keeps the *pre-flash* version forever and every
    updated camera stays on the "needs updating" list — which is exactly what
    happened to 50 cameras on 2026-09-09. The batch item recorded
    ``after_value = 7.93.0024``, verified by the camera's own API, while
    ``cameras.firmware`` still read ``7.10.0074``; pre-flight
    (`ops.preflight_firmware`) and the UI both key on `cameras.firmware`, so all
    50 were offered the image they already had.

    Safe against the Milestone collector clobbering it back: the identity
    backfill has no refresh pass (it queues on "not asked"), so once
    `identity_at` is set it reads these values *out of this row* and writes the
    same ones back. A vendor read is therefore durable — and it is the better
    number anyway, being the device's own answer rather than Milestone's cached
    `hardwareDriverSettings`, which is what was stale here.

    Callers must pass only a **verified** reading. Recording an unprovable one
    would be actively harmful, which is not obvious until you try it: a bare
    Bosch ``790`` makes `firmware.same_release` return None, and pre-flight
    refuses an unreadable version outright ("cannot read firmware ... refusing
    rather than guessing"). So storing it would turn a camera that merely needs
    retrying into one that is blocked — at a scale that matters, since 888
    cameras on this estate report versions in that unparseable form. The
    reading is not lost either way: it stays on the batch item as
    ``after_value``, which is where the evidence belongs.
    """
    reported = (reported or "").strip()
    if not reported:
        return False
    changed = db.execute(
        engine,
        "UPDATE cameras SET firmware = :f, updated_at = :now "
        "WHERE device_id = :d AND (firmware IS NULL OR firmware <> :f)",
        {"f": reported, "now": _now(), "d": device_id},
    )
    if changed:
        log.info("camera %s firmware recorded as %s", device_id, reported)
    return bool(changed)


def reconcile_observed_firmware(engine: Engine, *, apply: bool = False) -> list[dict]:
    """Find (and optionally fix) cameras whose registry firmware lags a verified flash.

    The repair half of the bug `record_observed_firmware` prevents. Any camera
    with a VERIFIED batch item is known to have reported ``after_value`` back to
    NetMon; if ``cameras.firmware`` disagrees, the registry simply never learned
    it. The newest verified item per device wins.

    ``apply=False`` reports without writing, because a bulk correction to the
    registry should be readable before it is run. Dry-run items are excluded by
    the status filter — a `would_run` never touched the camera and its
    ``after_value`` is NULL.
    """
    rows = db.fetch_all(
        engine,
        "SELECT i.device_id, i.after_value, i.finished_at, c.firmware AS registry, "
        "       d.name "
        "FROM camera_batch_items i "
        "JOIN cameras c ON c.device_id = i.device_id "
        "JOIN devices d ON d.id = i.device_id "
        f"WHERE i.status = '{ops.VERIFIED}' AND i.after_value IS NOT NULL "
        "  AND (c.firmware IS NULL OR c.firmware <> i.after_value) "
        "ORDER BY i.device_id, i.finished_at DESC, i.id DESC",
    )
    newest: dict[int, dict] = {}
    for r in rows:
        newest.setdefault(int(r["device_id"]), dict(r))
    drift = list(newest.values())
    if apply:
        for r in drift:
            r["fixed"] = record_observed_firmware(
                engine, int(r["device_id"]), str(r["after_value"]))
        log.warning("firmware reconcile: corrected %d camera(s) whose registry "
                    "lagged a verified flash", sum(1 for r in drift if r.get("fixed")))
    return drift


def milestone_stale_cameras(engine: Engine) -> list[dict]:
    """Cameras NetMon believes are on a version, keyed for a VMS re-detect.

    Scoped to cameras with a verified flash on record — the population whose
    Milestone entry is known to be a stale cache — rather than the whole fleet,
    so a bulk refresh cannot turn into 2,651 re-detects.
    """
    return [dict(r) for r in db.fetch_all(
        engine,
        "SELECT DISTINCT c.device_id, d.name, c.hardware_id, c.firmware "
        "FROM camera_batch_items i "
        "JOIN cameras c ON c.device_id = i.device_id "
        "JOIN devices d ON d.id = i.device_id "
        f"WHERE i.status = '{ops.VERIFIED}' AND i.after_value IS NOT NULL "
        "  AND c.hardware_id IS NOT NULL "
        "ORDER BY d.name",
    )]


def _cli_refresh_milestone(engine: Engine, cfg: Any, *, apply: bool) -> int:
    """``--refresh-milestone`` — the repair for cameras already flashed.

    The runner refreshes newly flashed cameras itself; this is for the ones
    flashed before that existed. Sequential on purpose: a re-detect makes the
    recording server talk to the device, and 50 at once is not a load anyone
    asked for.
    """
    import asyncio as _asyncio

    from netmon.collectors.milestone_client import MilestoneClient, MilestoneError

    rows = milestone_stale_cameras(engine)
    if not rows:
        print("no cameras with a verified flash and a Milestone hardware id")
        return 0
    print(f"{len(rows)} camera(s) with a verified flash:")
    for r in rows[:60]:
        print(f"  {r['name']:<40} registry {r['firmware']}")
    if len(rows) > 60:
        print(f"  ... and {len(rows) - 60} more")
    if not apply:
        print("\nre-run with --apply to ask Milestone to re-detect these")
        return 0

    s = (cfg.sources.get("milestone").settings if cfg.sources.get("milestone") else {})
    try:
        client = MilestoneClient(
            host=(s.get("host") or "").strip(), user=(s.get("user") or "").strip(),
            password=s.get("pass") or "", scheme=(s.get("scheme") or "https").strip(),
            client_id=(s.get("client_id") or "GrantValidatorClient").strip(),
            verify_ssl=str(s.get("verify_ssl", "true")).strip().lower()
            in ("1", "true", "yes", "on"))
    except MilestoneError as exc:
        print(f"error: {exc}")
        return 1

    async def go() -> tuple[int, int]:
        from netmon.collectors.milestone_client import MilestoneTaskUnavailable

        # Ask the first camera first. If this VMS does not offer the task, say
        # so once and stop — printing the same capability gap 50 times is not a
        # report, and 50 pointless round trips are not free.
        try:
            available = await client.hardware_tasks(str(rows[0]["hardware_id"]))
        except Exception as exc:                          # noqa: BLE001
            print(f"error: could not read Milestone tasks: {exc!r}")
            return 0, len(rows)
        if TASK_UPDATE_HARDWARE not in available:
            print(f"\nthis VMS does not offer {TASK_UPDATE_HARDWARE}. Hardware "
                  f"advertises: {', '.join(available) or 'nothing'}.")
            print("Nothing sent. Milestone's firmware value stays stale; NetMon's "
                  "own registry is already correct.")
            return 0, 0

        ok = bad = 0
        for r in rows:
            try:
                code, body = await client.update_hardware(str(r["hardware_id"]))
            except MilestoneTaskUnavailable as exc:
                print(f"  skip {r['name']}: {exc}")
                continue
            except Exception as exc:                      # noqa: BLE001
                print(f"  FAIL {r['name']}: {exc!r}")
                bad += 1
                continue
            if code >= 400:
                print(f"  HTTP {code} {r['name']}: {body[:120]}")
                bad += 1
            else:
                print(f"  ok   {r['name']} (HTTP {code})")
                ok += 1
        return ok, bad

    ok, bad = _asyncio.run(go())
    print(f"\nasked Milestone to re-detect {ok} camera(s); {bad} failed")
    return 0 if bad == 0 else 1


def main(argv: list[str] | None = None) -> int:
    """``python -m netmon.cameras.runner --reconcile-firmware [--apply]``.

    A one-shot, because the drift it repairs is historical: once
    `record_observed_firmware` is in place, new flashes record themselves.
    """
    import argparse

    from netmon import db as _db
    from netmon.config import load_config

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reconcile-firmware", action="store_true",
                        help="report cameras whose registry firmware lags a verified flash")
    parser.add_argument("--refresh-milestone", action="store_true",
                        help="ask Milestone to re-detect cameras whose VMS-cached "
                             "firmware disagrees with the registry")
    parser.add_argument("--apply", action="store_true",
                        help="actually do it (default: report only)")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    if not (args.reconcile_firmware or args.refresh_milestone):
        parser.error("choose --reconcile-firmware and/or --refresh-milestone")
    cfg = load_config(args.config)
    engine = _db.make_engine(cfg.db.url)
    from netmon import settings as _settings
    cfg = _settings.overlay_config(cfg, engine)   # effective config, as the app sees it

    if args.refresh_milestone:
        rc = _cli_refresh_milestone(engine, cfg, apply=args.apply)
        if not args.reconcile_firmware:
            return rc

    drift = reconcile_observed_firmware(engine, apply=args.apply)
    if not drift:
        print("no drift: every verified flash is reflected in the registry")
        return 0
    print(f"{len(drift)} camera(s) {'corrected' if args.apply else 'need correcting'}:")
    for r in drift[:60]:
        print(f"  {r['name']:<40} {r['registry'] or '-':>12} -> {r['after_value']}")
    if len(drift) > 60:
        print(f"  ... and {len(drift) - 60} more")
    if not args.apply:
        print("\nre-run with --apply to write these")
    return 0


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


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
