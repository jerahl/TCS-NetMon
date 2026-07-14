-- 005_design_port_foundations.sql — Phase 10.0 foundations (docs/spec/10-design-port.md §3).
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- Adds the snapshot-cache layer's page-level singleton store, the rConfig
-- backup-metadata table, and the events "Assign…" column. The row-shaped
-- inventory tables (switch_ports, pf_nodes, cameras, …) are deferred to their
-- own per-domain migrations (10.1+); this migration is the ungated part of the
-- §3 data model — no charter change, no new dimensions.
--
--   * snapshot_cache   one row per page-level singleton/aggregate blob
--                      (PBX system status, Milestone environment totals, PF
--                      cluster health, auth-method splits, RADIUS reject
--                      tails…). Collectors are the only writers; `ok` +
--                      `updated_at` let the API render staleness honestly
--                      (§4.5 fail-loud). `key` is a MariaDB reserved word ->
--                      stays backtick-quoted here and in every query.
--   * config_backups   rConfig backup list (metadata only; the diff pane does a
--                      user-initiated read-through — §10 Q5). Feeds the
--                      config_backup device_state dimension already in 001.
--   * alerts.assigned_to  events/problems "Assign…" action (spec §2/§6).
--
-- The device_state / state_events dimension enums are UNCHANGED — the port
-- needs no new dimensions (spec §3).
--
-- rollback: (data-preserving order; snapshot_cache/config_backups are
--  re-derivable from their source collectors, assigned_to is operator input —
--  export `SELECT id, assigned_to FROM alerts WHERE assigned_to IS NOT NULL`
--  first if that assignment history matters)
--   DROP TABLE IF EXISTS config_backups;
--   DROP TABLE IF EXISTS snapshot_cache;
--   ALTER TABLE alerts DROP COLUMN assigned_to;
--   DELETE FROM schema_migrations WHERE version='005';

-- Page-level singleton/aggregate cache. Avoids dozens of micro-tables for
-- widgets that are just a handful of numbers (spec §3).
CREATE TABLE IF NOT EXISTS snapshot_cache (
    `key`      VARCHAR(128) NOT NULL,             -- e.g. 'pf.cluster', 'threecx.system'
    payload    JSON         NULL,                 -- collector-shaped blob
    source     VARCHAR(64)  NOT NULL,             -- which collector wrote it
    ok         TINYINT(1)   NOT NULL DEFAULT 1,   -- false = last refresh failed, render stale
    updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- rConfig backup metadata (no config bodies stored — the diff pane reads
-- through to rConfig on click). Append-on-refresh keyed by (device, taken_at).
CREATE TABLE IF NOT EXISTS config_backups (
    device_id  BIGINT       NOT NULL,
    taken_at   TIMESTAMP    NOT NULL,
    size_bytes BIGINT       NULL,
    hash       VARCHAR(128) NULL,
    note       VARCHAR(512) NULL,
    updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, taken_at),
    KEY idx_config_backups_device (device_id, taken_at),
    CONSTRAINT fk_config_backups_device FOREIGN KEY (device_id)
        REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Events/problems "Assign…" action. Nullable; unassigned is the default.
ALTER TABLE alerts ADD COLUMN assigned_to VARCHAR(128) NULL;
