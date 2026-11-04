-- 041_inventory_updated_at_no_auto_bump.sql — stop MariaDB stamping inventory rows itself.
-- Target: MariaDB 10.x.
--
-- `updated_at` on these tables was created `ON UPDATE current_timestamp()`, so
-- MariaDB re-stamps a row whenever *any* column changes. Two things go wrong:
--
-- 1. The partial writers are meant to leave freshness alone. `_write_poe`,
--    `_write_sfp` and `_write_entity` (netmon/poller/snmp_inventory.py) and the
--    camera identity/platform writes (collectors/milestone.py,
--    cameras/runner.py) update a few columns of a row another sweep owns, and
--    say so: "no updated_at bump — the owning sweep owns freshness" (§4.5).
--    The column default overrode that silently.
--
-- 2. The auto-stamp is in the wrong time zone. NetMon writes `updated_at` as a
--    UTC wall-clock value, but the connection runs in the server's zone
--    (America/Chicago), so MariaDB's own stamp lands six hours "earlier". A
--    port whose PoE draw changed three minutes after the ports sweep read as
--    six hours stale — found 2026-11-04 on ALB-NewGym, where 15 of 57 ports
--    looked like they were missing the sweep and were not.
--
-- Dropping ON UPDATE (keeping NOT NULL and the insert default) makes
-- `updated_at` change only when NetMon sets it. Every full write on these
-- tables already sets it explicitly (_upsert_many / _replace, the Milestone
-- camera upsert). Rows mis-stamped before this migration correct themselves on
-- the next owning sweep — ports/stack every few minutes, cameras on the next
-- Milestone poll — so no data fix-up is needed.
--
-- Deliberately NOT included: devices, sites, fiber_links, workflows. Their
-- partial UPDATEs are operator edits, where an automatic "last changed" stamp
-- is arguably the point; they have the same time-zone skew and want their own
-- decision. The other 22 tables with ON UPDATE have no partial writer today.
--
-- rollback:
--   ALTER TABLE switch_ports  MODIFY updated_at TIMESTAMP NOT NULL
--     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
--   ALTER TABLE stack_members MODIFY updated_at TIMESTAMP NOT NULL
--     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
--   ALTER TABLE cameras       MODIFY updated_at TIMESTAMP NOT NULL
--     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

ALTER TABLE switch_ports
  MODIFY updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE stack_members
  MODIFY updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE cameras
  MODIFY updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
