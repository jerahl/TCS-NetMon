-- 010_stack_model.sql — per-slot hardware model (Phase 10.1 entity sweep).
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- Fed by the snmp_inventory 'entity' sweep from ENTITY-MIB: the class-9
-- module inside each Slot-N container carries the human model in
-- entPhysicalDescr ("X465-48P"), the EXOS version in entPhysicalSoftwareRev
-- (-> existing fw_version column), and entPhysicalSerialNum (-> existing
-- serial column). Fan/PSU presence lists land in the existing fans/psus
-- JSON columns.
--
-- rollback: (re-swept hourly; nothing to export)
--   ALTER TABLE stack_members DROP COLUMN model;
--   DELETE FROM schema_migrations WHERE version='010';

ALTER TABLE stack_members ADD COLUMN model VARCHAR(64) NULL;
