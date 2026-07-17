"""Bounded 24 h history ring buffer + sampler (spec 10.6).

The ONLY sanctioned metric-series deviation from the no-time-series charter
(CLAUDE.md §2; spec 10 §10 Q3 / spec 11 D3, owner-approved 2026-07-15). A
supervised task snapshots a **curated, low-cardinality** set of series into
``state_samples`` on ``[history] interval_s`` and prunes anything older than
``retention_hours`` (hard-capped at 24 in config) on every run — so the buffer
is a fixed rolling window, never long-term storage.

What it samples (all read from NetMon's own DB — zero source calls, spec §1):
  * ``fleet.{total,up,down,unknown,blind}`` — from ``device_state``,
  * ``alerts.{open,crit}`` — open ``alerts`` ⋈ ``alert_rules``,
  * ``voip.{channels_in_use,channels_total,trunks_registered}`` — ``trunks``,
  * ``wireless.clients`` — ``wireless_clients`` row count,
  * ``poe.watts`` — Σ ``stack_members.poe_measured_w``,
  * per-switch ``sw.<id>.{tput_kbps,ports_up}`` — ``switch_ports`` roll-up.

Deliberately NOT per-port / per-client: that cardinality would defeat the
"doesn't use up resources" intent (spec §9). Per-port sparklines can be a
follow-up if the aggregate volume proves comfortable.

Like every collector it also runs standalone: ``python -m netmon.history
--once|--loop``. The series-building functions are pure over DB rows so they
unit-test without a scheduler.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.engine import Engine

from netmon import db, health
from netmon.config import HistoryConfig

log = logging.getLogger("netmon.history")


# ----------------------------------------------------------------- ring buffer

def record_many(engine: Engine, ts: datetime, values: dict[str, float | None]) -> int:
    """Write one sample per series at ``ts`` in a single transaction.

    Idempotent for a given ``ts`` (a re-run at the same second replaces rather
    than collides on the (series, ts) PK). Returns the number of series written.
    """
    if not values:
        return 0
    keys = list(values.keys())
    ph = ", ".join(f":s{i}" for i in range(len(keys)))
    del_params: dict = {"ts": ts}
    for i, s in enumerate(keys):
        del_params[f"s{i}"] = s
    rows = [{"series": s, "ts": ts, "value": v} for s, v in values.items()]
    with engine.begin() as conn:
        # Replace any rows already at this exact timestamp for these series.
        conn.execute(
            text(f"DELETE FROM state_samples WHERE ts = :ts AND series IN ({ph})"),
            del_params,
        )
        conn.execute(
            text("INSERT INTO state_samples (series, ts, value) VALUES (:series, :ts, :value)"),
            rows,
        )
    return len(rows)


def prune(engine: Engine, retention_hours: int, *, now: datetime | None = None) -> int:
    """Delete samples older than the retention window; return rows removed."""
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(hours=retention_hours)
    return db.execute(engine, "DELETE FROM state_samples WHERE ts < :cutoff", {"cutoff": cutoff})


def read_series(
    engine: Engine, series: list[str], *, hours: int = 24
) -> dict[str, list[dict]]:
    """Return ``{series: [{ts, value}, …]}`` within the trailing window, oldest
    first. Series with no samples come back as empty lists (stable x-axis)."""
    out: dict[str, list[dict]] = {s: [] for s in series}
    if not series:
        return out
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    ph = ", ".join(f":s{i}" for i in range(len(series)))
    params: dict = {"since": since}
    for i, s in enumerate(series):
        params[f"s{i}"] = s
    rows = db.fetch_all(
        engine,
        f"SELECT series, ts, value FROM state_samples "
        f"WHERE ts >= :since AND series IN ({ph}) ORDER BY ts ASC",
        params,
    )
    for r in rows:
        out.setdefault(r["series"], []).append({"ts": r["ts"], "value": r["value"]})
    return out


# ------------------------------------------------------------- series builders
# Each returns {series_key: value}; pure over the DB it's handed.

def _scalar(engine: Engine, sql: str, params: dict | None = None) -> float:
    row = db.fetch_one(engine, sql, params)
    return float(next(iter(row.values())) or 0) if row else 0.0


def build_fleet(engine: Engine) -> dict[str, float]:
    rows = db.fetch_all(
        engine,
        "SELECT d.id AS id, "
        " MAX(CASE WHEN s.dimension='ping' THEN s.value END) AS ping, "
        " MAX(CASE WHEN s.dimension='source_status' THEN s.value END) AS src "
        "FROM devices d LEFT JOIN device_state s ON s.device_id = d.id "
        "WHERE d.enabled = 1 GROUP BY d.id",
    )
    total = up = down = unknown = blind = 0
    for r in rows:
        total += 1
        if r.get("ping") == "up":
            up += 1
        elif r.get("ping") == "down":
            down += 1
        else:
            unknown += 1
        if r.get("src") == "blind":
            blind += 1
    return {"fleet.total": total, "fleet.up": up, "fleet.down": down,
            "fleet.unknown": unknown, "fleet.blind": blind}


def build_alerts(engine: Engine) -> dict[str, float]:
    row = db.fetch_one(
        engine,
        "SELECT COUNT(*) AS open, "
        " SUM(CASE WHEN r.severity='crit' THEN 1 ELSE 0 END) AS crit "
        "FROM alerts a JOIN alert_rules r ON r.id = a.rule_id "
        "WHERE a.closed_at IS NULL",
    ) or {}
    return {"alerts.open": float(row.get("open") or 0), "alerts.crit": float(row.get("crit") or 0)}


def build_voip(engine: Engine) -> dict[str, float]:
    row = db.fetch_one(
        engine,
        "SELECT SUM(ch_in_use) AS in_use, SUM(ch_total) AS total, "
        " SUM(CASE WHEN reg_status='registered' THEN 1 ELSE 0 END) AS reg FROM trunks",
    ) or {}
    return {"voip.channels_in_use": float(row.get("in_use") or 0),
            "voip.channels_total": float(row.get("total") or 0),
            "voip.trunks_registered": float(row.get("reg") or 0)}


def build_misc(engine: Engine) -> dict[str, float]:
    return {
        "wireless.clients": _scalar(engine, "SELECT COUNT(*) FROM wireless_clients"),
        "poe.watts": _scalar(engine, "SELECT SUM(poe_measured_w) FROM stack_members"),
    }


def build_switches(engine: Engine) -> dict[str, float]:
    rows = db.fetch_all(
        engine,
        "SELECT device_id, "
        " SUM(COALESCE(in_kbps,0) + COALESCE(out_kbps,0)) AS tput, "
        " SUM(CASE WHEN oper_state='up' THEN 1 ELSE 0 END) AS up "
        "FROM switch_ports GROUP BY device_id",
    )
    out: dict[str, float] = {}
    for r in rows:
        did = r["device_id"]
        out[f"sw.{did}.tput_kbps"] = float(r.get("tput") or 0)
        out[f"sw.{did}.ports_up"] = float(r.get("up") or 0)
    return out


def build_all(engine: Engine) -> dict[str, float]:
    values: dict[str, float] = {}
    for fn in (build_fleet, build_alerts, build_voip, build_misc, build_switches):
        values.update(fn(engine))
    return values


# ------------------------------------------------------------------- sampler

class HistorySampler:
    """Supervised task (poller sibling): sample → write → prune, on interval.

    Uses the same ``collector_health`` heartbeat/error boundary as the other
    tasks so a failing sampler shows up honestly on the NetMon Status page.
    """

    name = "history"

    def __init__(self, engine: Engine, cfg: HistoryConfig) -> None:
        self.engine = engine
        self.cfg = cfg
        self.interval_s = float(cfg.interval_s)
        self.timeout_s = float(max(cfg.interval_s, 60))

    @classmethod
    def from_config(cls, engine: Engine, cfg) -> "HistorySampler":
        return cls(engine, cfg.history)

    def run_once(self) -> int:
        ts = datetime.now(timezone.utc).replace(microsecond=0)
        written = record_many(self.engine, ts, build_all(self.engine))
        removed = prune(self.engine, self.cfg.retention_hours, now=ts)
        if removed:
            log.debug("pruned %d sample(s) older than %dh", removed, self.cfg.retention_hours)
        return written

    async def run_guarded(self) -> None:
        health.record_start(self.engine, self.name)
        started = time.monotonic()
        try:
            # The builders are quick synchronous DB queries; run them off the
            # event loop so the sampler never blocks the supervisor.
            written = await asyncio.to_thread(self.run_once)
        except Exception as exc:
            health.record_error(self.engine, self.name, message=repr(exc),
                                duration_ms=int((time.monotonic() - started) * 1000))
            log.exception("history sample failed")
            return
        health.record_success(self.engine, self.name, records=written,
                              duration_ms=int((time.monotonic() - started) * 1000))


def main(argv: list[str] | None = None) -> int:
    import argparse

    from netmon.config import load_config

    parser = argparse.ArgumentParser(description="Bounded history ring-buffer sampler.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="sample + prune once")
    mode.add_argument("--loop", action="store_true", help="run forever on the interval")
    parser.add_argument("--config", default=None)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    cfg = load_config(args.config)
    engine = db.make_engine(cfg.db.url)
    from netmon import settings as settings_engine
    cfg = settings_engine.overlay_config(cfg, engine)
    sampler = HistorySampler.from_config(engine, cfg)

    async def _run() -> None:
        if args.once:
            await sampler.run_guarded()
            return
        while True:
            await sampler.run_guarded()
            await asyncio.sleep(sampler.interval_s)

    asyncio.run(_run())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
