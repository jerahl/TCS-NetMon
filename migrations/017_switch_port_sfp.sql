-- 017_switch_port_sfp.sql — flag whether a switch port is an SFP/fiber port.
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- EXOS reports neither media type nor optic presence on the IF-MIB (all
-- front-panel ethernet ports are ifType ethernetCsmacd), so "is this an SFP
-- port?" is derived from the ENTITY-MIB: an inserted optic is a physical
-- entity whose descr matches a transceiver/fiber pattern, mapped back to the
-- port's ifIndex via entAliasMappingTable. The snmp_inventory entity sweep
-- computes it and partial-UPDATEs this column (like the PoE columns).
--
--   * is_sfp = 1  port has a fiber optic / is an SFP(+)/QSFP cage
--   * is_sfp = 0  copper/fixed port (entity mapping seen, no optic)
--   * is_sfp NULL unknown — the entity sweep hasn't classified it yet
--
-- rollback: (re-derived on the next entity sweep; nothing to export)
--   ALTER TABLE switch_ports DROP COLUMN is_sfp;
--   DELETE FROM schema_migrations WHERE version='017';

ALTER TABLE switch_ports ADD COLUMN is_sfp TINYINT(1) NULL;
