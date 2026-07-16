-- 013_surveillance_voip.sql — Phase 10.4 surveillance + VoIP inventory
-- (docs/spec/10-design-port.md §3, the "007" set renumbered).
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- Fed by the milestone + threecx collectors, replace-on-refresh, updated_at
-- on every row, no history. The Milestone Config API lacks live fps/bitrate/
-- host metrics (spec §7) — those columns stay NULL and the UI renders "—",
-- never fabricated. The camera's "Linked Switch Port" is the FDB payoff:
-- cameras.mac -> fdb_entries -> switch + port, pure SQL at query time.
--
--   * cameras            one row per Milestone camera
--   * recording_servers  one row per RS (+ storage rollup)
--   * trunks             one row per 3CX trunk
--   * extensions         one row per 3CX extension
--
-- Page-level singletons live in snapshot_cache: milestone.overview
-- (license/retention/storage/alarm totals) and threecx.system (SystemStatus).
--
-- rollback: (all re-swept within minutes; nothing to export)
--   DROP TABLE IF EXISTS cameras;
--   DROP TABLE IF EXISTS recording_servers;
--   DROP TABLE IF EXISTS trunks;
--   DROP TABLE IF EXISTS extensions;
--   DELETE FROM schema_migrations WHERE version='013';

CREATE TABLE IF NOT EXISTS recording_servers (
    device_id       BIGINT       NOT NULL,
    hostname        VARCHAR(128) NULL,
    role            VARCHAR(24)  NULL,            -- recording|management|failover|mobile
    version         VARCHAR(64)  NULL,
    chans_total     INT          NULL,
    chans_recording INT          NULL,
    storage_used_gb DOUBLE       NULL,
    storage_total_gb DOUBLE      NULL,
    retention_days  INT          NULL,
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id),
    CONSTRAINT fk_rs_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cameras (
    device_id                 BIGINT       NOT NULL,
    model                     VARCHAR(128) NULL,
    resolution                VARCHAR(32)  NULL,
    fps_target                INT          NULL,
    codec                     VARCHAR(32)  NULL,
    bitrate_mode              VARCHAR(32)  NULL,
    recording_mode            VARCHAR(32)  NULL,
    state_msg                 VARCHAR(255) NULL,
    ip                        VARCHAR(45)  NULL,
    mac                       VARCHAR(17)  NULL,            -- FDB join key
    recording_server_device_id BIGINT      NULL,
    enabled                   TINYINT(1)   NULL,
    updated_at                TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id),
    KEY idx_cameras_mac (mac),
    CONSTRAINT fk_cam_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trunks (
    device_id     BIGINT       NOT NULL,
    name          VARCHAR(128) NULL,
    provider_host VARCHAR(128) NULL,
    did           VARCHAR(64)  NULL,
    reg_status    VARCHAR(16)  NULL,             -- registered|unregistered|unknown
    ch_total      INT          NULL,
    ch_in_use     INT          NULL,
    updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id),
    CONSTRAINT fk_trunk_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- extensions are keyed by 3CX extension number, not a NetMon device.
CREATE TABLE IF NOT EXISTS extensions (
    ext        VARCHAR(16)  NOT NULL,
    name       VARCHAR(128) NULL,
    site       VARCHAR(64)  NULL,
    registered TINYINT(1)   NULL,
    dnd        TINYINT(1)   NULL,
    updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (ext)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
