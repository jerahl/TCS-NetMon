-- 001_init.sql — NetMon initial schema (CLAUDE.md §6).
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- Design invariants:
--   * device_state answers "what is true now" (one row per device+dimension).
--   * state_events answers "what changed when" — APPEND ONLY. Never UPDATE or
--     DELETE a row in state_events.
--   * A source being unreachable is itself a state (source_status='blind');
--     blind must never render as healthy.
--
-- rollback: DROP TABLE IF EXISTS in reverse dependency order:
--   collector_health, maintenance_windows, notifications, alerts, alert_rules,
--   state_events, device_state, devices;  then
--   DELETE FROM schema_migrations WHERE version='001';
-- (No production data exists at 001; a clean drop is safe. Later migrations
--  that touch populated tables must document a data-preserving rollback.)

-- Unified device registry. The reconciliation table — the heart of the app.
CREATE TABLE IF NOT EXISTS devices (
    id                    BIGINT       NOT NULL AUTO_INCREMENT,
    name                  VARCHAR(255) NOT NULL,
    site                  VARCHAR(128) NULL,
    device_type           ENUM('switch','ap','camera','recording_server','trunk','pbx','other')
                          NOT NULL DEFAULT 'other',
    mgmt_ip               VARCHAR(45)  NULL,           -- IPv4 or IPv6 literal
    snmp_capable          TINYINT(1)   NOT NULL DEFAULT 0,
    enabled               TINYINT(1)   NOT NULL DEFAULT 1,
    -- Nullable per-source foreign keys. Indexed individually so a collector
    -- can find "its" rows without scanning the table.
    xiq_device_id         VARCHAR(64)  NULL,
    pf_node_mac           VARCHAR(17)  NULL,           -- aa:bb:cc:dd:ee:ff
    milestone_hardware_id VARCHAR(64)  NULL,
    rconfig_device_id     VARCHAR(64)  NULL,
    threecx_ref           VARCHAR(64)  NULL,
    created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_devices_name (name),
    KEY idx_devices_xiq (xiq_device_id),
    KEY idx_devices_pf (pf_node_mac),
    KEY idx_devices_milestone (milestone_hardware_id),
    KEY idx_devices_rconfig (rconfig_device_id),
    KEY idx_devices_threecx (threecx_ref),
    KEY idx_devices_site (site),
    KEY idx_devices_type (device_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Current state only. Small and hot. One row per device per dimension.
CREATE TABLE IF NOT EXISTS device_state (
    device_id   BIGINT       NOT NULL,
    dimension   ENUM('ping','snmp','source_status','config_backup','recording','trunk')
                NOT NULL,
    value       VARCHAR(255) NULL,
    severity    ENUM('ok','warn','crit','unknown') NOT NULL DEFAULT 'unknown',
    source      VARCHAR(64)  NOT NULL,               -- which collector/poller wrote it
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, dimension),
    CONSTRAINT fk_device_state_device FOREIGN KEY (device_id)
        REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only transition log. THE ONLY history table. Never UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS state_events (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    device_id   BIGINT       NOT NULL,
    dimension   ENUM('ping','snmp','source_status','config_backup','recording','trunk')
                NOT NULL,
    old_value   VARCHAR(255) NULL,
    new_value   VARCHAR(255) NULL,
    severity    ENUM('ok','warn','crit','unknown') NOT NULL DEFAULT 'unknown',
    source      VARCHAR(64)  NOT NULL,
    occurred_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_state_events_device (device_id, occurred_at),
    KEY idx_state_events_dim (dimension, occurred_at),
    CONSTRAINT fk_state_events_device FOREIGN KEY (device_id)
        REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Alert rules are rows, not code: dimension + condition + severity + duration.
CREATE TABLE IF NOT EXISTS alert_rules (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    name          VARCHAR(128) NOT NULL,
    dimension     ENUM('ping','snmp','source_status','config_backup','recording','trunk')
                  NOT NULL,
    -- condition stored as data (operator + comparison value), evaluated by the
    -- engine. e.g. {"op":"eq","value":"down"} — kept as JSON text.
    condition     TEXT         NOT NULL,
    severity      ENUM('ok','warn','crit','unknown') NOT NULL DEFAULT 'warn',
    min_duration_s INT         NOT NULL DEFAULT 0,
    target        VARCHAR(255) NULL,                  -- notification email
    enabled       TINYINT(1)   NOT NULL DEFAULT 1,
    created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_alert_rules_name (name),
    KEY idx_alert_rules_dim (dimension)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One open row per (device, rule). Re-fires update last_seen_at, never dup.
CREATE TABLE IF NOT EXISTS alerts (
    id           BIGINT     NOT NULL AUTO_INCREMENT,
    device_id    BIGINT     NOT NULL,
    rule_id      BIGINT     NOT NULL,
    opened_at    TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at    TIMESTAMP  NULL,
    acked_by     VARCHAR(128) NULL,
    acked_at     TIMESTAMP  NULL,
    PRIMARY KEY (id),
    -- One OPEN alert per (device, rule): closed_at IS NULL rows must be unique.
    -- Enforced in the engine; a generated column keeps the DB honest too.
    open_key     VARCHAR(64) AS (IF(closed_at IS NULL, CONCAT(device_id,'-',rule_id), NULL)) STORED,
    UNIQUE KEY uq_alerts_open (open_key),
    KEY idx_alerts_device (device_id),
    KEY idx_alerts_rule (rule_id),
    CONSTRAINT fk_alerts_device FOREIGN KEY (device_id)
        REFERENCES devices (id) ON DELETE CASCADE,
    CONSTRAINT fk_alerts_rule FOREIGN KEY (rule_id)
        REFERENCES alert_rules (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- What was (or, in shadow mode, would have been) sent.
CREATE TABLE IF NOT EXISTS notifications (
    id              BIGINT       NOT NULL AUTO_INCREMENT,
    alert_id        BIGINT       NOT NULL,
    channel         VARCHAR(32)  NOT NULL DEFAULT 'email',
    target          VARCHAR(255) NOT NULL,
    sent_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    shadow          TINYINT(1)   NOT NULL DEFAULT 1,   -- true = logged, not sent
    payload_summary VARCHAR(512) NULL,
    PRIMARY KEY (id),
    KEY idx_notifications_alert (alert_id),
    KEY idx_notifications_shadow (shadow, sent_at),
    CONSTRAINT fk_notifications_alert FOREIGN KEY (alert_id)
        REFERENCES alerts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Maintenance windows suppress NOTIFICATION, not state recording.
CREATE TABLE IF NOT EXISTS maintenance_windows (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    scope_type  ENUM('device','site','device_type') NOT NULL,
    scope_value VARCHAR(255) NOT NULL,   -- device id / site name / device_type
    starts_at   TIMESTAMP    NOT NULL,
    ends_at     TIMESTAMP    NOT NULL,
    created_by  VARCHAR(128) NOT NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_maint_window (starts_at, ends_at),
    KEY idx_maint_scope (scope_type, scope_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per collector. Staleness here feeds the built-in 'source blind'
-- alert rule. Fail loud, never stale (CLAUDE.md §4.5).
CREATE TABLE IF NOT EXISTS collector_health (
    name                 VARCHAR(64) NOT NULL,
    last_start           TIMESTAMP   NULL,
    last_success         TIMESTAMP   NULL,
    last_error           TEXT        NULL,
    duration_ms          INT         NULL,
    records_written      INT         NULL,
    consecutive_failures INT         NOT NULL DEFAULT 0,
    updated_at           TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
