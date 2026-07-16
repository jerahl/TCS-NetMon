-- 009_stack_poe.sql — per-slot PoE budget columns (Phase 10.1 deferred slice).
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- Fed by the snmp_inventory 'poe' sweep from EXTREME-POE-MIB
-- extremePethPseSlotTable (OIDs supplied by the owner's "Extreme EXOS by
-- SNMP" Zabbix template, 2026-07-16; all values in watts):
--   .2  extremePethSlotPowerLimit       -> poe_budget_w   (configured budget)
--   .3  extremePethSlotConsumptionPower -> poe_alloc_w    (allocated, by class)
--   .8  extremePethSlotPoeStatus        -> poe_status     (text enum)
--   .10 extremePethSlotMaxAvailPower    -> poe_avail_w    (effective budget)
--   .11 extremePethSlotMaxCapacity      -> poe_capacity_w (hardware limit)
--   .14 extremePethSlotMeasuredPower    -> poe_measured_w (actual draw)
--
-- The per-port PoE state lands in the switch_ports poe_* columns that have
-- existed since 006 — no schema change needed there.
--
-- rollback: (values are re-swept within minutes; nothing to export)
--   ALTER TABLE stack_members DROP COLUMN poe_status;
--   ALTER TABLE stack_members DROP COLUMN poe_budget_w;
--   ALTER TABLE stack_members DROP COLUMN poe_alloc_w;
--   ALTER TABLE stack_members DROP COLUMN poe_avail_w;
--   ALTER TABLE stack_members DROP COLUMN poe_capacity_w;
--   ALTER TABLE stack_members DROP COLUMN poe_measured_w;
--   DELETE FROM schema_migrations WHERE version='009';

ALTER TABLE stack_members ADD COLUMN poe_status VARCHAR(24) NULL;
ALTER TABLE stack_members ADD COLUMN poe_budget_w INT NULL;
ALTER TABLE stack_members ADD COLUMN poe_alloc_w INT NULL;
ALTER TABLE stack_members ADD COLUMN poe_avail_w INT NULL;
ALTER TABLE stack_members ADD COLUMN poe_capacity_w INT NULL;
ALTER TABLE stack_members ADD COLUMN poe_measured_w INT NULL;
