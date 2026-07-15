-- 006_switch_inventory.sql — Phase 10.1 SNMP switch inventory (spec 10 §3/§4).
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- Row-shaped inventory the Switches dashboard reads at render time WITHOUT
-- touching a switch (spec 10 §1 snapshot-cache decision). Written only by the
-- read-only SNMP sweep collector (netmon/poller/snmp_inventory.py); replace-on-
-- refresh, `updated_at` on every row, no history/time-series (§2). OIDs are
-- sourced from the owner's "Extreme EXOS by SNMP" Zabbix template (see spec 10
-- §4 appendix). device_state / state_events are untouched — these are
-- descriptive facts, not the severity state machine.
--
--   * switch_ports    IF-MIB ifTable/ifXTable + EtherLike duplex + POWER-
--                     ETHERNET/Extreme PoE, per (device, ifindex). prev_counters
--                     holds the previous raw octet/error counters + ts so the
--                     collector computes kbps/err-delta at write time (§1 "rates
--                     without history").
--   * fdb_entries     BRIDGE-MIB dot1dTpFdbTable (MAC->bridge port) joined to
--                     dot1dBasePortIfIndex (bridge port->ifindex). NOTE: this
--                     table is NOT VLAN-scoped (the EXOS template walks the
--                     plain dot1dTpFdb, not Q-BRIDGE dot1qTpFdb), so PK is
--                     (device_id, mac) and vlan_id is nullable — populated later
--                     if a Q-BRIDGE per-VLAN walk is added. The fdb<->PF
--                     identity join (spec §3) keys on mac regardless.
--   * lldp_neighbors  LLDP-MIB lldpRemTable, per (device, local ifindex).
--   * switch_vlans    Extreme extremeVlanIfTable, per (device, vlan_id).
--   * stack_members   Extreme stacking + system sensors, per (device, slot).
--
-- rollback: (all rows are re-derivable from a live SNMP sweep — safe to drop)
--   DROP TABLE IF EXISTS stack_members;
--   DROP TABLE IF EXISTS switch_vlans;
--   DROP TABLE IF EXISTS lldp_neighbors;
--   DROP TABLE IF EXISTS fdb_entries;
--   DROP TABLE IF EXISTS switch_ports;
--   DELETE FROM schema_migrations WHERE version='006';

CREATE TABLE IF NOT EXISTS switch_ports (
    device_id      BIGINT       NOT NULL,
    ifindex        BIGINT       NOT NULL,
    name           VARCHAR(128) NULL,                 -- ifName, e.g. "1:18"
    member         INT          NULL,                 -- stack slot parsed from name
    oper_state     ENUM('up','down','disabled','absent','unknown') NOT NULL DEFAULT 'unknown',
    admin_up       TINYINT(1)   NULL,
    speed_mbps     BIGINT       NULL,                 -- ifHighSpeed
    duplex         VARCHAR(16)  NULL,                 -- dot3StatsDuplexStatus
    poe_admin      TINYINT(1)   NULL,
    poe_delivering TINYINT(1)   NULL,
    poe_class      VARCHAR(16)  NULL,
    poe_watts      DECIMAL(7,2) NULL,
    in_kbps        BIGINT       NULL,
    out_kbps       BIGINT       NULL,
    util_pct       DECIMAL(5,2) NULL,
    err_in_delta   BIGINT       NULL,
    err_out_delta  BIGINT       NULL,
    disc_in_delta  BIGINT       NULL,
    disc_out_delta BIGINT       NULL,
    last_change    TIMESTAMP    NULL,
    prev_counters  JSON         NULL,                 -- {in_octets,out_octets,err_in,err_out,disc_in,disc_out,ts}
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, ifindex),
    KEY idx_switch_ports_dev (device_id),
    CONSTRAINT fk_switch_ports_device FOREIGN KEY (device_id)
        REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS fdb_entries (
    device_id  BIGINT      NOT NULL,
    mac        VARCHAR(17) NOT NULL,                  -- aa:bb:cc:dd:ee:ff
    vlan_id    INT         NULL,                       -- NULL: dot1dTpFdb has no VLAN
    ifindex    BIGINT      NULL,
    first_seen TIMESTAMP   NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, mac),
    KEY idx_fdb_mac (mac),
    KEY idx_fdb_dev_if (device_id, ifindex),
    CONSTRAINT fk_fdb_entries_device FOREIGN KEY (device_id)
        REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lldp_neighbors (
    device_id      BIGINT       NOT NULL,
    local_ifindex  BIGINT       NOT NULL,
    remote_sysname VARCHAR(255) NULL,
    remote_port    VARCHAR(255) NULL,
    remote_sysdesc VARCHAR(512) NULL,
    remote_chassis VARCHAR(128) NULL,
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, local_ifindex),
    CONSTRAINT fk_lldp_device FOREIGN KEY (device_id)
        REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS switch_vlans (
    device_id      BIGINT       NOT NULL,
    vlan_id        INT          NOT NULL,
    name           VARCHAR(128) NULL,
    admin_up       TINYINT(1)   NULL,
    untagged_count INT          NULL,
    tagged_count   INT          NULL,
    port_map       JSON         NULL,
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, vlan_id),
    CONSTRAINT fk_switch_vlans_device FOREIGN KEY (device_id)
        REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stack_members (
    device_id  BIGINT       NOT NULL,
    slot       INT          NOT NULL,
    role       VARCHAR(32)  NULL,                     -- master|backup|standby|…
    status     VARCHAR(32)  NULL,
    serial     VARCHAR(64)  NULL,
    fw_version VARCHAR(64)  NULL,
    uptime_s   BIGINT       NULL,
    cpu_pct    DECIMAL(5,2) NULL,
    mem_pct    DECIMAL(5,2) NULL,
    temp_c     DECIMAL(6,2) NULL,
    fans       JSON         NULL,
    psus       JSON         NULL,
    warn_msg   VARCHAR(255) NULL,
    updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, slot),
    CONSTRAINT fk_stack_members_device FOREIGN KEY (device_id)
        REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
