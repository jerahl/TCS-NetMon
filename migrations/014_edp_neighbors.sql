-- 014_edp_neighbors.sql — topology neighbors switch from LLDP to EDP.
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- The fleet is all-Extreme EXOS, which runs EDP (Extreme Discovery Protocol,
-- Extreme's predecessor to LLDP) on by default — the owner's authoritative
-- neighbor source. The snmp_inventory topology sweep now walks
-- EXTREME-EDP-MIB::extremeEdpTable (1.3.6.1.4.1.1916.1.13.2.1) instead of
-- LLDP-MIB. The table is renamed lldp_neighbors -> neighbors (it was always
-- the generic per-port neighbor store; keeping the LLDP name while it holds
-- EDP data would mislead), plus:
--   * protocol  which discovery protocol produced the row ('edp' | 'lldp')
--   * age_s     extremeEdpEntryAge — seconds since the neighbor last refreshed
--               (the UI flags stale entries, e.g. > 90s = neighbor likely gone)
-- Existing columns keep their meaning; remote_sysdesc holds the neighbor's
-- EXOS version for EDP, remote_chassis stays NULL (EDP carries no chassis MAC).
--
-- rollback: (re-swept within the topology interval; nothing to export)
--   ALTER TABLE neighbors DROP COLUMN age_s;
--   ALTER TABLE neighbors DROP COLUMN protocol;
--   ALTER TABLE neighbors RENAME TO lldp_neighbors;
--   DELETE FROM schema_migrations WHERE version='014';

ALTER TABLE lldp_neighbors RENAME TO neighbors;
ALTER TABLE neighbors ADD COLUMN protocol VARCHAR(8) NULL;
ALTER TABLE neighbors ADD COLUMN age_s INT NULL;
