-- 018_fiber_links_redundant.sql — allow multiple fiber links between one pair.
-- Target: MariaDB 10.x.
--
-- Some sites have more than one physical fiber path to a neighbour for
-- redundancy, which the original uq_fiber_links_pair (site_a_id, site_b_id)
-- unique key forbade. Drop it. The pair is still worth an index for lookups,
-- and fk_fiber_links_site_a needs a leading index on site_a_id once the
-- (site_a_id, site_b_id) unique key is gone — so add a plain index FIRST,
-- then drop the unique key.
--
-- rollback: (only safe if no duplicate pairs have been created since)
--   ALTER TABLE fiber_links ADD UNIQUE KEY uq_fiber_links_pair (site_a_id, site_b_id);
--   ALTER TABLE fiber_links DROP INDEX idx_fiber_links_pair;
--   DELETE FROM schema_migrations WHERE version='018';

ALTER TABLE fiber_links ADD KEY idx_fiber_links_pair (site_a_id, site_b_id);
ALTER TABLE fiber_links DROP INDEX uq_fiber_links_pair;
