-- 031_micetro_ddi.sql — Micetro DDI federation (docs/spec/21-micetro-ddi.md).
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- Two snapshot tables, replace-on-refresh, written only by the `micetro`
-- collector (spec 10 §1: collectors are the only writers, no history, every
-- row carries updated_at so the UI badges staleness honestly).
--
--   * ddi_addresses  Micetro IPAM records, filtered to addresses that actually
--                    carry something (a MAC, a DNS name, a lease, a
--                    reservation, or a non-Free state). This is the table that
--                    closes the fdb_entries gap: fdb learns every MAC that
--                    forwards a frame, PacketFence only knows the ones that
--                    authenticated, and Micetro knows the IP<->MAC<->DNS join
--                    for the rest (printers, AV gear, static servers).
--                    `ip` is the PK — unique in Micetro's space, and what
--                    every lookup starts from. `mac` is NOT unique: one MAC
--                    legitimately holds several addresses (dual-stack,
--                    multi-homed, a re-lease before the old lease expired).
--   * ddi_scopes     DHCP scopes with utilization, classified to a severity at
--                    write time against [micetro] scope_warn_pct /
--                    scope_crit_pct. Severity is stored, not computed at
--                    render, for the same reason port counters store rates.
--                    NOTE: `utilizationPercentage` is a field of Micetro's
--                    *Range*, not of DHCPScope (which carries `available`, a
--                    count). The collector joins the two on DHCPScope.rangeRef
--                    — free, because the IPAM sweep already drains /ranges.
--
-- No devices.micetro_ref column: Micetro is keyed by IP and devices already
-- carry mgmt_ip, so the device join is ddi_addresses.ip = devices.mgmt_ip.
--
-- No device_state dimension for scope utilization — device_state.dimension is
-- an ENUM and device_id is an FK into devices; a DHCP scope is neither a
-- device nor enum-able without widening an invariant. Spec 21 §6 / Q3.
--
-- rollback: (every row is re-derivable from one sweep — safe to drop)
--   DROP TABLE IF EXISTS ddi_scopes;
--   DROP TABLE IF EXISTS ddi_addresses;
--   DELETE FROM schema_migrations WHERE version='031';

CREATE TABLE IF NOT EXISTS ddi_addresses (
    ip             VARCHAR(45)  NOT NULL,             -- IPAMRecord.address
    mac            VARCHAR(17)  NULL,                 -- aa:bb:cc:dd:ee:ff, canon
    -- How the MAC was established, strongest first: a lease means the DHCP
    -- server handed that address to that MAC; a reservation is configured
    -- intent; ARP/ping discovery can be a scan interval stale. Stored rather
    -- than collapsed so the UI can say which.
    mac_origin     ENUM('lease','reservation','discovery') NULL,
    dns_name       VARCHAR(255) NULL,                 -- primary dnsHosts[] name
    dns_extra      SMALLINT     NOT NULL DEFAULT 0,   -- count of further names
    state          ENUM('free','assigned','claimed','pending','held','unknown')
                   NOT NULL DEFAULT 'unknown',        -- IPAMRecordState
    discovery_type VARCHAR(16)  NULL,                 -- None|Ping|ARP|Lease|API|Custom
    last_seen      TIMESTAMP    NULL,                 -- lastSeenDate
    lease_state    VARCHAR(32)  NULL,                 -- DHCPLease.state
    lease_expires  TIMESTAMP    NULL,                 -- DHCPLease.lease
    reservation    VARCHAR(255) NULL,                 -- DHCPReservation.name
    device_name    VARCHAR(255) NULL,                 -- IPAMRecord.device
    interface_name VARCHAR(255) NULL,                 -- IPAMRecord.interface
    range_cidr     VARCHAR(64)  NULL,                 -- owning Range.name
    addr_ref       VARCHAR(64)  NULL,                 -- Micetro ObjRef
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (ip),
    KEY idx_ddi_addr_mac (mac),                       -- fdb/pf_nodes join key
    KEY idx_ddi_addr_dns (dns_name),                  -- /api/search
    KEY idx_ddi_addr_range (range_cidr)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ddi_scopes (
    scope_ref       VARCHAR(64)  NOT NULL,            -- DHCPScope ObjRef
    name            VARCHAR(255) NULL,
    range_cidr      VARCHAR(64)  NULL,
    from_addr       VARCHAR(45)  NULL,
    to_addr         VARCHAR(45)  NULL,
    server          VARCHAR(255) NULL,                -- owning DHCP server
    superscope      VARCHAR(255) NULL,
    enabled         TINYINT(1)   NULL,
    available       BIGINT       NULL,               -- DHCPScope.available
    utilization_pct DECIMAL(5,2) NULL,               -- Range.utilizationPercentage
    -- Classified at write time from utilization_pct; 'unknown' when Micetro
    -- reports no utilization figure, never a fabricated 'ok'.
    severity        ENUM('ok','warn','crit','unknown') NOT NULL DEFAULT 'unknown',
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (scope_ref),
    KEY idx_ddi_scopes_sev (severity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
