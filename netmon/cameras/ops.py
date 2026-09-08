"""Bulk camera operations: pre-flight and batch planning (spec 20 S8 / D11).

This module decides **which cameras a batch is allowed to touch, and in what
order**. It sends nothing. The executor that eventually does is gated on
`[camera_ops]`, admin-only, dry-run by default, and does not exist yet.

Pre-flight refuses rather than warns (S8 condition 5). That is the difference
between a fleet-wide hardware write and every other action NetMon takes: a
refused camera costs nothing, and a camera that should have been refused costs a
truck roll. Every refusal carries the reason, and the preview shows them before
anything runs — an operator should be able to read why 12 of 50 cameras will be
left alone without opening a log.

The order is canary → rings (S8 condition 6). The canary is not a formality: it
is the only thing standing between a bad image and the second camera, so it runs
alone and the batch stops until it verifies. Rings after it are sized so a
failure rate can be measured before the next one starts.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.cameras import firmware as fw
from netmon.cameras.vendors import profile_for

#: Statuses a `camera_batch_items` row can hold. Named here because the runner,
#: the API and the UI all have to agree, and `indeterminate` is easy to lose.
PENDING = "pending"
WOULD_RUN = "would_run"
RUNNING = "running"
VERIFIED = "verified"
INDETERMINATE = "indeterminate"
FAILED = "failed"
SKIPPED = "skipped"


@dataclass(frozen=True)
class Refusal:
    device_id: int
    name: str
    reason: str


@dataclass
class Preflight:
    """What a batch would do, before it is allowed to do anything."""
    allowed: list[dict] = field(default_factory=list)
    refused: list[Refusal] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return bool(self.allowed)

    def as_dict(self) -> dict:
        return {
            "allowed": [{"device_id": r["device_id"], "name": r["name"],
                         "model": r.get("model"), "firmware": r.get("firmware")}
                        for r in self.allowed],
            "refused": [{"device_id": r.device_id, "name": r.name, "reason": r.reason}
                        for r in self.refused],
            "allowed_count": len(self.allowed),
            "refused_count": len(self.refused),
        }


def credentials(cfg: Any) -> tuple[str, str]:
    """The account a camera write authenticates with.

    `[camera_ops] user/pass` normally; `[camera_snapshot]`'s when the owner has
    explicitly set `use_snapshot_credentials` (2026-09-08). Borrowing it is a
    typed decision rather than a silent fallback, because that section calls its
    credential read-only — on this estate it is the Bosch `service` account,
    which is the privileged level, so the note describes an intention rather
    than an enforced limit.
    """
    ops = cfg.camera_ops
    if ops.use_snapshot_credentials:
        snap = cfg.camera_snapshot
        return snap.user, snap.password
    return ops.user, ops.password


def _rows_for(engine: Engine, device_ids: list[int]) -> dict[int, dict]:
    """Everything pre-flight needs about each camera, in one read."""
    if not device_ids:
        return {}
    marks = ", ".join(f":d{i}" for i in range(len(device_ids)))
    params = {f"d{i}": v for i, v in enumerate(device_ids)}
    rows = db.fetch_all(engine, f"""
        SELECT d.id AS device_id, d.name, d.site, d.enabled, d.device_type,
               c.model, c.firmware, c.vendor, c.ip, c.platform,
               reach.value AS reachability, src.value AS source_status
        FROM devices d
        LEFT JOIN cameras c ON c.device_id = d.id
        LEFT JOIN device_state reach ON reach.device_id = d.id
             AND reach.dimension = 'reachability'
        LEFT JOIN device_state src ON src.device_id = d.id
             AND src.dimension = 'source_status'
        WHERE d.id IN ({marks})""", params)
    return {int(r["device_id"]): dict(r) for r in rows}


def _no_touch_devices(engine: Engine, now: datetime) -> set[int]:
    """Devices inside an active maintenance window.

    Maintenance suppresses *notification* for the alert engine, and NetMon has
    always been careful to say so. Here it means something stronger and
    deliberately so: a window is somebody saying "this equipment is being worked
    on", and pushing firmware into that is how two people end up at one camera.
    """
    rows = db.fetch_all(engine, """
        SELECT scope_type, scope_value FROM maintenance_windows
        WHERE starts_at <= :now AND ends_at >= :now""", {"now": now})
    if not rows:
        return set()
    device_scoped = {int(r["scope_value"]) for r in rows
                     if r["scope_type"] == "device" and str(r["scope_value"]).isdigit()}
    sites = {str(r["scope_value"]) for r in rows if r["scope_type"] == "site"}
    types = {str(r["scope_value"]) for r in rows if r["scope_type"] == "device_type"}
    if sites or types:
        for r in db.fetch_all(engine, "SELECT id, site, device_type FROM devices"):
            if (r["site"] in sites) or (r["device_type"] in types):
                device_scoped.add(int(r["id"]))
    return device_scoped


def preflight_firmware(engine: Engine, cfg: Any, device_ids: list[int],
                       image: dict, *, now: datetime | None = None) -> Preflight:
    """Which of these cameras may receive this firmware image.

    ``image`` is a `firmware_images` row. Every check below refuses; none warns.
    The order is deliberate — cheapest and most decisive first, so a refusal
    reads as the single most useful reason rather than the last one tested.
    """
    now = now or datetime.now(timezone.utc)
    rows = _rows_for(engine, device_ids)
    no_touch = _no_touch_devices(engine, now)
    models = set(json.loads(image.get("models") or "[]"))
    out = Preflight()

    for device_id in device_ids:
        row = rows.get(device_id)
        name = (row or {}).get("name") or f"device {device_id}"

        def refuse(reason: str) -> None:
            out.refused.append(Refusal(device_id=device_id, name=name, reason=reason))

        if row is None or row.get("device_type") != "camera":
            refuse("not a camera in the registry")
            continue
        if not row.get("enabled"):
            refuse("disabled in the registry")
            continue
        if not row.get("ip"):
            refuse("no address registered — nothing to send to")
            continue
        if profile_for(row.get("vendor")) is None:
            refuse(f"no vendor profile for driver {row.get('vendor') or 'unknown'!r}")
            continue
        if not models:
            refuse("the image has no model allow-list, so nothing may receive it")
            continue
        if str(row.get("model") or "") not in models:
            # The check that stops a 5000i image reaching a multi 7000i. 84
            # model×firmware pairs live on this estate.
            refuse(f"model {row.get('model') or 'unknown'!r} is not on this image's allow-list")
            continue

        declared = str(image.get("platform") or "").strip()
        known = str(row.get("platform") or "").strip()
        if declared and known and declared != known:
            # Stored from the last probe. The runner checks again live before
            # every upload — this one is so a preview can say it up front rather
            # than after somebody has approved the batch.
            refuse(f"camera is {known}; this image is built for {declared}")
            continue

        already = fw.same_release(row.get("firmware"), image.get("version"))
        if already is None:
            # Unreadable on either side. 31 cameras report strings with no
            # documented reading; a push decided by a guess is exactly what
            # condition 3 exists to prevent.
            refuse(f"cannot read firmware {row.get('firmware')!r} — refusing rather than guessing")
            continue
        if already:
            refuse(f"already on {image.get('version')}")
            continue

        if row.get("reachability") != "up":
            # Both probes, not one: pushing to a camera the network cannot
            # reach wastes the ring, and pushing to one Milestone cannot see
            # means nothing can verify it afterwards.
            refuse(f"reachability is {row.get('reachability') or 'unknown'}, not up")
            continue
        if row.get("source_status") != "up":
            refuse(f"Milestone says {row.get('source_status') or 'unknown'}, not up")
            continue
        if device_id in no_touch:
            refuse("inside an active maintenance window")
            continue
        user, password = credentials(cfg)
        if not (user and password):
            refuse("no privileged camera account configured ([camera_ops] user/pass, "
                   "or use_snapshot_credentials)")
            continue
        proving = int(getattr(cfg.camera_ops, "proving_device_id", 0) or 0)
        if proving and device_id != proving:
            # The proving ground, enforced rather than remembered. While this is
            # set NetMon can only ever write to the one camera the owner
            # nominated, whatever a batch asks for.
            refuse(f"[camera_ops] proving_device_id = {proving}: while the machinery is "
                   f"being proved, only that camera may be written to")
            continue

        out.allowed.append(row)

    return out


def plan_rings(device_ids: list[int], *, canary_count: int, ring_size: int) -> list[list[int]]:
    """Split an allowed set into the canary and the rings after it.

    Ring 0 is the canary and is never merged into the first real ring, even when
    `ring_size` would swallow it: the whole point is that it runs alone and the
    batch waits for it to verify.
    """
    ids = list(device_ids)
    if not ids:
        return []
    canary = max(1, int(canary_count))
    size = max(1, int(ring_size))
    rings = [ids[:canary]]
    rest = ids[canary:]
    for i in range(0, len(rest), size):
        rings.append(rest[i:i + size])
    return rings


def create_batch(engine: Engine, cfg: Any, *, op: str, device_ids: list[int],
                 image: dict | None, actor: str, dry_run: bool | None = None,
                 not_before: datetime | None = None,
                 now: datetime | None = None) -> dict:
    """Write the batch and its items. Sends nothing, ever.

    `dry_run` defaults to the config, which defaults to true. A batch created in
    dry-run reaches `done` having walked every check and written `would_run` on
    each item — the preview an admin reads before choosing to arm it.

    The ring discipline is **copied onto the row**, not read from config at run
    time: a batch must play by the rules it was created under, or editing the
    config mid-roll silently changes the safety margin of something already
    running.
    """
    now = now or datetime.now(timezone.utc)
    ops = cfg.camera_ops
    if op != "firmware_update":
        # The setting catalogue is deferred (owner, 2026-09-07); the table and
        # runner are op-agnostic so it can arrive without rework, but there is
        # nothing to run yet and pretending otherwise would be a stub with a
        # confirm button.
        raise ValueError(f"unsupported operation {op!r} — only firmware_update exists so far")
    if image is None:
        raise ValueError("firmware_update needs an image")
    if len(device_ids) > ops.max_batch:
        raise ValueError(f"{len(device_ids)} cameras exceeds [camera_ops] max_batch "
                         f"({ops.max_batch}); split the roll")

    dry = ops.dry_run if dry_run is None else bool(dry_run)
    pre = preflight_firmware(engine, cfg, device_ids, image, now=now)
    allowed_ids = [int(r["device_id"]) for r in pre.allowed]
    rings = plan_rings(allowed_ids, canary_count=ops.canary_count, ring_size=ops.ring_size)

    db.execute(engine, """
        INSERT INTO camera_batches
            (op, firmware_id, status, dry_run, canary_count, ring_size, max_concurrent,
             abort_pct, reboot_timeout_s, not_before, created_by, created_at, message)
        VALUES (:op, :fw, :status, :dry, :canary, :ring, :conc, :abort, :reboot,
                :nb, :by, :at, :msg)""",
        {"op": op, "fw": image["id"], "status": "previewed" if allowed_ids else "failed",
         "dry": 1 if dry else 0, "canary": ops.canary_count, "ring": ops.ring_size,
         "conc": ops.max_concurrent, "abort": ops.abort_pct,
         "reboot": ops.reboot_timeout_s, "nb": not_before, "by": actor, "at": now,
         "msg": None if allowed_ids else "every camera was refused at pre-flight"})
    batch_id = int(db.fetch_one(engine, "SELECT MAX(id) AS id FROM camera_batches")["id"])

    item_status = WOULD_RUN if dry else PENDING
    items = []
    for ring_index, ring in enumerate(rings):
        for device_id in ring:
            row = next(r for r in pre.allowed if int(r["device_id"]) == device_id)
            items.append({"b": batch_id, "d": device_id, "ring": ring_index,
                          "st": item_status, "before": row.get("firmware"),
                          "msg": None})
    # Refused cameras are recorded too, as `skipped` with the reason. A batch
    # that silently omitted them would leave an operator wondering whether a
    # camera was fine or forgotten.
    for r in pre.refused:
        items.append({"b": batch_id, "d": r.device_id, "ring": 0, "st": SKIPPED,
                      "before": None, "msg": r.reason})
    if items:
        db.execute(engine, """
            INSERT INTO camera_batch_items
                (batch_id, device_id, ring, status, before_value, message)
            VALUES (:b, :d, :ring, :st, :before, :msg)""", items)

    return {"batch_id": batch_id, "dry_run": dry, "rings": rings,
            "preflight": pre.as_dict()}
