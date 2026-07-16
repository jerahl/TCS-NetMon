-- 011_wireless_inventory.sql — Phase 10.2 wireless snapshot tables
-- (docs/spec/10-design-port.md §3, the "005" set renumbered).
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- Fed by the XIQ collector's detail/clients/SSID cycles (spec §5), replace-
-- on-refresh, updated_at on every row, no history:
--   * ap_details        one row per AP — GET /devices?views=FULL fleet sweep
--   * ap_radios         one row per AP radio (wifi0/wifi1/wifi2 — band comes
--                       from the radio's own field, never the index: dual-5G
--                       APs exist, spec 00 G10)
--   * wireless_clients  one row per associated client — /clients/active
--                       views=FULL. Carries usernames/MACs (PII — spec 10 Q8;
--                       the clients cycle is independently disableable)
--   * ssids             one row per SSID — /network-policies/{id}/ssids;
--                       client counts are rolled up from wireless_clients at
--                       read time, not stored
--
-- rollback: (all re-swept within minutes; nothing to export)
--   DROP TABLE IF EXISTS wireless_clients;
--   DROP TABLE IF EXISTS ap_radios;
--   DROP TABLE IF EXISTS ap_details;
--   DROP TABLE IF EXISTS ssids;
--   DELETE FROM schema_migrations WHERE version='011';

CREATE TABLE IF NOT EXISTS ap_details (
    device_id      BIGINT       NOT NULL,
    model          VARCHAR(64)  NULL,
    serial         VARCHAR(64)  NULL,
    mgmt_mac       VARCHAR(17)  NULL,            -- XIQ base MAC (spec 00 G3)
    fw_version     VARCHAR(64)  NULL,
    ip             VARCHAR(45)  NULL,
    network_policy VARCHAR(128) NULL,
    uptime_s       BIGINT       NULL,
    clients_total  INT          NULL,
    cpu_pct        DOUBLE       NULL,             -- d360 telemetry (NULL until sourced)
    mem_pct        DOUBLE       NULL,
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id),
    CONSTRAINT fk_ap_details_device FOREIGN KEY (device_id)
        REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ap_radios (
    device_id    BIGINT      NOT NULL,
    radio        VARCHAR(16) NOT NULL,            -- wifi0 / wifi1 / wifi2
    band         VARCHAR(8)  NULL,                -- 2.4 / 5 / 6 (from the radio's field)
    channel      INT         NULL,
    width_mhz    INT         NULL,
    tx_power_dbm INT         NULL,
    util_pct     DOUBLE      NULL,
    noise_dbm    INT         NULL,
    clients      INT         NULL,
    updated_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, radio),
    CONSTRAINT fk_ap_radios_device FOREIGN KEY (device_id)
        REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wireless_clients (
    mac             VARCHAR(17)  NOT NULL,
    device_id       BIGINT       NULL,            -- the AP (NULL if not in the registry)
    ssid            VARCHAR(64)  NULL,
    band            VARCHAR(8)   NULL,
    rssi_dbm        INT          NULL,
    snr_db          INT          NULL,
    os              VARCHAR(64)  NULL,
    hostname        VARCHAR(128) NULL,
    username        VARCHAR(128) NULL,
    ip              VARCHAR(45)  NULL,
    connected_since TIMESTAMP    NULL,
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (mac),
    KEY idx_wclients_device (device_id),
    KEY idx_wclients_ssid (ssid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ssids (
    name           VARCHAR(64)  NOT NULL,          -- broadcast name
    auth           VARCHAR(32)  NULL,
    enabled        TINYINT(1)   NULL,
    network_policy VARCHAR(128) NULL,
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
