"""3CX collector — trunk registration + VoIP inventory.

State (device_state `trunk` dimension, unchanged): trunk up/down for devices
matched by `threecx_ref`; blind on unreachable.

Inventory (Phase 10.4): trunk rows → ``trunks``, extensions → ``extensions``,
and the previously-dead ``system_status()`` → ``snapshot_cache['threecx.system']``.
Read-only (v20 REST). Extensions field coverage is v20-build-dependent
(spec 10 §10 Q4 — verify on the live PBX); parsers are defensive.

    python -m netmon.collectors.threecx --once|--loop
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.engine import Engine

from netmon import db
from netmon.collectors.base import Collector, run_standalone
from netmon.collectors.threecx_client import ThreeCxClient, ThreeCxError
from netmon.config import Config
from netmon.snapshots import write_snapshot
from netmon.state import write_state

log = logging.getLogger("netmon.collectors.threecx")


def _registered(trunk: dict) -> bool:
    for key in ("Registered", "IsRegistered", "registered"):
        v = trunk.get(key)
        if isinstance(v, bool):
            return v
    status = str(trunk.get("RegistrationStatus") or trunk.get("Status") or "").strip().lower()
    return status in ("registered", "online", "ok", "up")


def _f(d: dict, *keys: str):
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return None


def _int(v: Any):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def build_trunk_rows(trunks: list[dict], reg_by_ref: dict[str, int], now: datetime) -> list[dict]:
    """One row per registry trunk device (matched by threecx_ref)."""
    rows: list[dict] = []
    for t in trunks:
        dev_id = None
        for key in ("Id", "id", "Number", "number", "Name", "name"):
            if t.get(key) is not None and str(t[key]) in reg_by_ref:
                dev_id = reg_by_ref[str(t[key])]
                break
        if dev_id is None:
            continue
        rows.append({
            "device_id": dev_id,
            "name": _f(t, "Name", "name"),
            "provider_host": _f(t, "Host", "host", "OutboundProxy", "Server"),
            "did": _f(t, "MainNumber", "Number", "number"),
            "reg_status": "registered" if _registered(t) else "unregistered",
            "ch_total": _int(_f(t, "SimultaneousCalls", "MaxSimCalls", "Channels")),
            "ch_in_use": _int(_f(t, "ActiveCalls", "CallsInProgress")),
            "updated_at": now,
        })
    return rows


def build_extension_rows(users: list[dict], now: datetime) -> list[dict]:
    rows: dict[str, dict] = {}
    for u in users:
        ext = _f(u, "Number", "number", "Extension", "extension")
        if ext is None:
            continue
        ext = str(ext)
        first, last = _f(u, "FirstName", "firstName") or "", _f(u, "LastName", "lastName") or ""
        name = (f"{first} {last}").strip() or _f(u, "DisplayName", "Name", "name") or None
        reg = _f(u, "IsRegistered", "Registered", "registered")
        rows[ext] = {
            "ext": ext,
            "name": name,
            "site": _f(u, "Office", "Site", "Department"),
            "registered": (1 if reg else 0) if reg is not None else None,
            "dnd": 1 if _f(u, "Dnd", "DND", "dnd") else 0,
            "updated_at": now,
        }
    return list(rows.values())


class ThreeCxCollector(Collector):
    name = "threecx"

    def __init__(self, engine: Engine, client: ThreeCxClient, interval_s: float = 120.0) -> None:
        super().__init__(engine)
        self.client = client
        self.interval_s = interval_s
        self.timeout_s = max(60.0, interval_s)

    @classmethod
    def from_config(cls, engine: Engine, cfg: Config) -> "ThreeCxCollector":
        s = (cfg.sources.get("threecx").settings if cfg.sources.get("threecx") else {})
        client = ThreeCxClient(
            url=(s.get("url") or "").strip(),
            client_id=(s.get("client_id") or "").strip(),
            client_secret=s.get("client_secret") or "",
            verify_ssl=str(s.get("verify_ssl", "true")).strip().lower() in ("1", "true", "yes", "on"),
        )
        return cls(engine, client, interval_s=int(s.get("interval_s") or 120))

    def _registry(self) -> list[dict[str, Any]]:
        return db.fetch_all(
            self.engine,
            "SELECT id, threecx_ref FROM devices "
            "WHERE enabled = 1 AND threecx_ref IS NOT NULL AND threecx_ref <> ''",
        )

    async def run_once(self) -> int:
        registry = self._registry()
        try:
            trunks = await self.client.trunks()
        except ThreeCxError:
            for r in registry:
                write_state(self.engine, int(r["id"]), "trunk", "blind", "warn", "threecx")
            raise

        by_ref: dict[str, dict] = {}
        for t in trunks:
            for key in ("Id", "id", "Number", "number", "Name", "name"):
                val = t.get(key)
                if val is not None:
                    by_ref.setdefault(str(val), t)

        written = 0
        reg_by_ref: dict[str, int] = {}
        for r in registry:
            reg_by_ref[str(r["threecx_ref"])] = int(r["id"])
            t = by_ref.get(str(r["threecx_ref"]))
            if t is None:
                continue
            up = _registered(t)
            write_state(self.engine, int(r["id"]), "trunk",
                        "up" if up else "down", "ok" if up else "crit", "threecx")
            written += 1

        # Inventory persistence + the previously-dead SystemStatus snapshot.
        now = datetime.now(timezone.utc)
        written += db.replace_rows(
            self.engine, "trunks", ["device_id"], build_trunk_rows(trunks, reg_by_ref, now))

        try:
            written += db.replace_rows(
                self.engine, "extensions", ["ext"],
                build_extension_rows(await self.client.extensions(), now))
        except ThreeCxError as exc:
            log.info("3CX extensions endpoint unavailable: %s", exc)

        try:
            write_snapshot(self.engine, "threecx.system", await self.client.system_status(), self.name)
        except ThreeCxError as exc:
            log.info("3CX SystemStatus unavailable: %s", exc)
            write_snapshot(self.engine, "threecx.system", None, self.name, ok=False)
        return written


def main(argv: list[str] | None = None) -> int:
    try:
        return run_standalone(lambda engine, cfg: ThreeCxCollector.from_config(engine, cfg), argv)
    except ThreeCxError as exc:
        print(f"error: {exc} — set [threecx] url/client_id/client_secret.", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
