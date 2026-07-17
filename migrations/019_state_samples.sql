-- 019_state_samples.sql — Phase 10.6 bounded history ring buffer.
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- The ONE sanctioned metric-series deviation from the no-time-series charter
-- (CLAUDE.md §2; spec 10 §10 Q3 / spec 11 D3, owner-approved 2026-07-15): a
-- fixed-window, auto-pruned ≤24 h ring buffer that powers the design's
-- sparklines / short-horizon charts. Nothing beyond the window is ever kept —
-- the history sampler prunes rows older than the retention window on every run
-- ([history] retention_hours, hard-capped at 24 in config).
--
-- Shape is a generic (series, ts) → value point store: `series` is a curated
-- key (e.g. 'fleet.up', 'voip.channels_in_use', 'sw.7.tput_kbps'). Collectors /
-- the sampler are the only writers. Low cardinality by design (aggregates +
-- a couple of per-switch series) — NOT per-port/per-client, which would defeat
-- the "doesn't use up resources" intent (spec §9).
--
-- rollback: (pure derived data; nothing to export — re-samples within minutes)
--   DROP TABLE IF EXISTS state_samples;
--   DELETE FROM schema_migrations WHERE version='019';

CREATE TABLE IF NOT EXISTS state_samples (
    series     VARCHAR(96) NOT NULL,
    ts         TIMESTAMP   NOT NULL,
    value      DOUBLE      NULL,
    PRIMARY KEY (series, ts),
    KEY idx_state_samples_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
