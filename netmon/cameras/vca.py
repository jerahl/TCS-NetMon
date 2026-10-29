"""VCA configuration read (spec 13 §11) — which cameras run analytics, and how.

A one-shot, read-only pull: every request is an RCP+ `direction=READ` at access
level "minimal", built by the vendor profile, never from a caller's string. It
needs no `[camera_ops]` flag because it sends nothing that changes a device; it
borrows that section's account and timeouts only because that is the account
NetMon already reads cameras with.

**Report by default, store on `--apply`.** The report is what a person asked
for; the `camera_vca` table is what lets the next question ("which ones changed
since last month") be answered without asking 2,500 cameras again.

**A camera that will not answer is recorded as such**, with the reason, rather
than dropped — a silent gap in a fleet report reads as "VCA off", which is the
one conclusion it does not support.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy.engine import Engine

from netmon import db
from netmon.cameras import ops
from netmon.cameras.runner import BatchRefused, _base_url
from netmon.cameras.vendors import profile_for

log = logging.getLogger(__name__)

#: Ceiling on concurrent cameras. Five small GETs each; ten at once is a pace
#: the camera VLANs have already carried for snapshot reads.
DEFAULT_CONCURRENCY = 10
#: A read either answers quickly or the camera is not going to answer. The
#: `[camera_ops]` read timeout is sized for a 988 MiB upload, not for this.
READ_TIMEOUT_S = 15.0


def cameras_to_read(engine: Engine, name: str | None = None) -> list[dict]:
    """Enabled cameras with a registered address and a profile that reads VCA."""
    sql = ("SELECT d.id AS device_id, d.name, c.vendor, c.ip, c.https_enabled, c.https_port "
           "FROM cameras c JOIN devices d ON d.id = c.device_id "
           "WHERE d.enabled = 1 AND c.ip IS NOT NULL AND c.ip <> ''")
    params: dict[str, Any] = {}
    if name:
        sql += " AND d.name = :name"
        params["name"] = name
    rows = db.fetch_all(engine, sql + " ORDER BY d.name", params)
    return [r for r in rows
            if hasattr(profile_for(r.get("vendor")), "vca_read_requests")]


async def read_camera(client: Any, item: dict, auth: Any, lines: int = 1) -> list[dict]:
    """One row per video line: the decoded summary, or the reason there is none."""
    profile = profile_for(item.get("vendor"))
    try:
        base = _base_url(item)
    except BatchRefused as exc:
        return [_row(item, 1, error=str(exc))]
    rows = []
    for line in range(1, lines + 1):
        values: dict[str, Any] = {}
        refused = []
        try:
            for req in profile.vca_read_requests(base, line):
                resp = await client.get(req["url"], auth=auth)
                body = getattr(resp, "text", "") or ""
                if getattr(resp, "status_code", 0) >= 400:
                    raise RuntimeError(f"HTTP {resp.status_code} on {req['field']}")
                if not profile.answered(body):
                    refused.append(req["field"])
                    continue
                values[req["field"]] = req["parse"](body)
        except Exception as exc:                 # noqa: BLE001 — record it, keep going
            rows.append(_row(item, line, error=_short(exc)))
            break
        if line > 1 and not values:
            break                                # no such line on this camera
        error = f"not answered: {', '.join(refused)}" if refused else None
        rows.append(_row(item, line, error=error, **values))
    return rows


async def pull(cameras: list[dict], cfg: Any, *, lines: int = 1,
               concurrency: int = DEFAULT_CONCURRENCY,
               client_factory: Callable[[], Any] | None = None) -> list[dict]:
    """Read every camera, `concurrency` at a time. Never raises per camera."""
    user, password = ops.credentials(cfg)
    ops_cfg = cfg.camera_ops
    timeout = httpx.Timeout(READ_TIMEOUT_S, connect=ops_cfg.connect_timeout_s)
    factory = client_factory or (
        lambda: httpx.AsyncClient(timeout=timeout, verify=ops_cfg.verify_ssl))
    gate = asyncio.Semaphore(max(1, concurrency))

    async def one(item: dict) -> list[dict]:
        async with gate:
            # One client per camera: Digest's nonce is per host, and a shared
            # pool would let one dead camera hold connections the rest need.
            async with factory() as client:
                return await read_camera(client, item, httpx.DigestAuth(user, password),
                                         lines)

    results = await asyncio.gather(*(one(c) for c in cameras))
    return [row for rows in results for row in rows]


def store(engine: Engine, rows: list[dict]) -> int:
    """Upsert each row into `camera_vca`. A failed read keeps the last good
    values and records the error beside them — stale, visibly, not erased."""
    now = datetime.now(timezone.utc)
    for r in rows:
        keys = {"device_id": r["device_id"], "line": r["line"]}
        if r["error"] and not _has_values(r):
            values = {"error": r["error"], "checked_at": now}
        else:
            values = {k: r[k] for k in ("viproc_id", "mode", "mode_label",
                                        "profile_name", "engine", "running", "error")}
            values.update(checked_at=now, updated_at=now)
        db.upsert(engine, "camera_vca", keys, values)
    return len(rows)


def format_report(rows: list[dict]) -> str:
    out = [f"{'camera':<36} {'ln':>2}  {'mode':<12} {'profile':<16} {'engine':<14} run  note"]
    for r in rows:
        running = {1: "yes", 0: "CPU"}.get(r.get("running"), "-")
        out.append(f"{r['name'][:36]:<36} {r['line']:>2}  {r.get('mode_label') or '-':<12} "
                   f"{(r.get('profile_name') or '-')[:16]:<16} {(r.get('engine') or '-')[:14]:<14} "
                   f"{running:<4} {r.get('error') or ''}")
    by_mode: dict[str, int] = {}
    for r in rows:
        key = "unreadable" if r["error"] and not _has_values(r) else (r.get("mode_label") or "?")
        by_mode[key] = by_mode.get(key, 0) + 1
    out.append("")
    out.append("lines by mode: " + ", ".join(f"{k} {v}" for k, v in sorted(by_mode.items())))
    return "\n".join(out)


def cli(engine: Engine, cfg: Any, *, camera: str | None, lines: int,
        concurrency: int, apply: bool) -> int:
    """``--pull-vca`` — print the fleet's VCA summary; ``--apply`` also stores it."""
    cameras = cameras_to_read(engine, camera)
    if not cameras:
        print(f"no camera named {camera!r} with an address and a VCA-capable profile"
              if camera else "no cameras with an address and a VCA-capable profile")
        return 1
    print(f"reading VCA config from {len(cameras)} camera(s), {concurrency} at a time ...")
    rows = asyncio.run(pull(cameras, cfg, lines=lines, concurrency=concurrency))
    print(format_report(rows))
    if apply:
        print(f"\nstored {store(engine, rows)} row(s) in camera_vca")
    else:
        print("\nre-run with --apply to store these in camera_vca")
    failed = sum(1 for r in rows if r["error"] and not _has_values(r))
    return 0 if failed < len(rows) else 1


def _row(item: dict, line: int, *, error: str | None = None, **values: Any) -> dict:
    mode = values.get("mode")
    return {
        "device_id": item["device_id"], "name": item.get("name") or "", "line": line,
        "viproc_id": values.get("viproc_id"), "mode": mode,
        "mode_label": profile_for(item.get("vendor")).vca_mode_label(mode),
        "profile_name": values.get("profile_name"), "engine": values.get("engine"),
        "running": values.get("running"), "error": error,
    }


def _has_values(row: dict) -> bool:
    return any(row.get(k) is not None for k in ("viproc_id", "mode", "profile_name",
                                                "engine", "running"))


def _short(exc: Exception) -> str:
    text = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
    return text[:250]
