-- 004_site_map.sql — Phase 9 geographic site map (docs/spec/09-site-map.md).
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
--   * sites            curated per-site metadata (lat/lon + tier). sites.name
--                      MUST equal devices.site (the Zabbix Site/<name> value) —
--                      it is the join key for the /api/sites roll-up.
--   * fiber_links      curated inter-site topology. Pair stored in
--                      sorted-by-name order so A↔B can't be registered twice
--                      reversed. Fiber links are deliberately NOT a
--                      device_state dimension — the voice 'trunk' dimension is
--                      untouched (spec 09 decision 5).
--   * fiber_link_state current state ONLY (device_state idiom): status +
--                      live utilization. No history table — the §2 scope
--                      guard (no per-link time-series) stands.
--
-- Populated by `python -m netmon.topology <file>` (see topology.example.json);
-- nothing here alters an existing table.
--
-- rollback: DROP TABLE IF EXISTS in reverse dependency order:
--   fiber_link_state, fiber_links, sites;  then
--   DELETE FROM schema_migrations WHERE version='004';
-- (Data-preserving note: sites/fiber_links hold curated topology that is fully
--  re-importable from the owner's topology JSON; fiber_link_state is
--  current-state only. Export `SELECT * FROM sites/fiber_links` first if the
--  curated rows have drifted from the JSON.)

CREATE TABLE IF NOT EXISTS sites (
    id           BIGINT       NOT NULL AUTO_INCREMENT,
    name         VARCHAR(128) NOT NULL,           -- join key = devices.site
    display_name VARCHAR(255) NULL,
    tier         ENUM('hub','high','middle','elementary','other')
                 NOT NULL DEFAULT 'other',
    lat          DECIMAL(9,6) NOT NULL,
    lon          DECIMAL(9,6) NOT NULL,
    enabled      TINYINT(1)   NOT NULL DEFAULT 1,
    created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sites_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fiber_links (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    site_a_id     BIGINT       NOT NULL,
    site_b_id     BIGINT       NOT NULL,
    capacity_gbps DECIMAL(6,1) NOT NULL DEFAULT 1.0,
    -- Curated street-route polyline as JSON [[lat,lon],...]; NULL renders as a
    -- straight line between the endpoint sites.
    path          TEXT         NULL,
    enabled       TINYINT(1)   NOT NULL DEFAULT 1,
    created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_fiber_links_pair (site_a_id, site_b_id),
    KEY idx_fiber_links_b (site_b_id),
    CONSTRAINT fk_fiber_links_site_a FOREIGN KEY (site_a_id)
        REFERENCES sites (id) ON DELETE CASCADE,
    CONSTRAINT fk_fiber_links_site_b FOREIGN KEY (site_b_id)
        REFERENCES sites (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Written by the future utilization/link collector (read path undecided —
-- spec 09 "Next session"). Absent/'unknown' rows are honest: the API derives
-- link status from endpoint-site state and reports utilization as null.
CREATE TABLE IF NOT EXISTS fiber_link_state (
    link_id         BIGINT       NOT NULL,
    status          VARCHAR(16)  NOT NULL DEFAULT 'unknown',   -- up|degraded|down|unknown
    utilization_pct DECIMAL(5,2) NULL,
    source          VARCHAR(64)  NOT NULL,
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (link_id),
    CONSTRAINT fk_fiber_link_state_link FOREIGN KEY (link_id)
        REFERENCES fiber_links (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
