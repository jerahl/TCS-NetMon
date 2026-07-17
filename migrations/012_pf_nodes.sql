-- 012_pf_nodes.sql — Phase 10.3 PacketFence node persistence
-- (docs/spec/10-design-port.md §3, the "006" table renumbered).
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- Replaces the in-memory PF snapshot: the packetfence collector merges the
-- paged nodes/search (identity), node_categories (role names — nodes carry
-- only the numeric category_id), and the OPEN locationlog sessions
-- (switch/port/ssid/conn method — the /nodes endpoint doesn't carry them)
-- into one row per MAC, replace-on-refresh.
--
-- Reconciliation vs the spec §3 sketch: `last_ifindex` is stored as
-- `last_port` VARCHAR — PF's locationlog carries the switch's port *name*
-- (plus ifDesc), not a guaranteed ifIndex. `online` marks MACs with an open
-- locationlog session this refresh.
--
-- This is the FDB⋈PF join target: fdb_entries.mac = pf_nodes.mac gives the
-- Switches port-detail pane its identity cards, and wireless_clients.mac =
-- pf_nodes.mac enriches AP Detail (spec §3 marquee feature).
--
-- rollback: (re-swept within minutes; nothing to export)
--   DROP TABLE IF EXISTS pf_nodes;
--   DELETE FROM schema_migrations WHERE version='012';

CREATE TABLE IF NOT EXISTS pf_nodes (
    mac            VARCHAR(17)  NOT NULL,
    computername   VARCHAR(128) NULL,
    ip             VARCHAR(45)  NULL,
    vendor         VARCHAR(128) NULL,
    os             VARCHAR(128) NULL,             -- PF device_class
    device_type    VARCHAR(128) NULL,
    owner          VARCHAR(128) NULL,             -- PF pid
    role           VARCHAR(64)  NULL,             -- category name (id resolved)
    reg_status     VARCHAR(16)  NULL,             -- reg / unreg / pending / ...
    vlan           VARCHAR(16)  NULL,
    last_switch    VARCHAR(128) NULL,
    last_switch_ip VARCHAR(45)  NULL,
    last_port      VARCHAR(64)  NULL,
    last_ssid      VARCHAR(64)  NULL,
    conn_method    VARCHAR(64)  NULL,             -- connection_type
    conn_sub       VARCHAR(64)  NULL,             -- connection_sub_type (auth)
    dot1x_user     VARCHAR(128) NULL,
    dhcp_fp        VARCHAR(255) NULL,
    last_seen      TIMESTAMP    NULL,
    online         TINYINT(1)   NOT NULL DEFAULT 0,
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (mac),
    KEY idx_pf_nodes_status (reg_status),
    KEY idx_pf_nodes_role (role),
    KEY idx_pf_nodes_switch (last_switch),
    KEY idx_pf_nodes_online (online)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
