-- 016_map_link_ports.sql — richer site map: label placement, link ownership,
-- and physical port attachments. Target: MariaDB 10.x, InnoDB, utf8mb4.
--
--   * sites.label_pos     where the site's name tooltip sits on the map
--                         (top | bottom | left | right); NULL = top (default).
--   * fiber_links.link_kind   'owned' (district fiber) vs 'leased' (a carrier
--                         circuit, e.g. C-Spire) — rendered distinctly so the
--                         NOC can tell owned plant from a leased path at a
--                         glance. NOT NULL DEFAULT 'owned' (existing rows).
--   * fiber_links.provider    the carrier name when leased (e.g. 'C-Spire').
--   * fiber_links.{a,b}_device_id / {a,b}_ifindex  the switch port each end of
--                         the link is patched into. When set, the link's
--                         up/down + utilization + speed are derived from those
--                         switch_ports rows (the real circuit state) instead of
--                         the coarse endpoint-site roll-up. Nullable — a link
--                         with no ports attached keeps the site-derived status.
--
-- No FK on the device columns (a device delete just leaves a dangling ref the
-- API treats as "no port data"); the sweep never writes here.
--
-- rollback:
--   ALTER TABLE fiber_links DROP COLUMN b_ifindex, DROP COLUMN b_device_id,
--     DROP COLUMN a_ifindex, DROP COLUMN a_device_id,
--     DROP COLUMN provider, DROP COLUMN link_kind;
--   ALTER TABLE sites DROP COLUMN label_pos;
--   DELETE FROM schema_migrations WHERE version='016';

ALTER TABLE sites ADD COLUMN label_pos VARCHAR(8) NULL AFTER tier;
ALTER TABLE fiber_links ADD COLUMN link_kind VARCHAR(16) NOT NULL DEFAULT 'owned';
ALTER TABLE fiber_links ADD COLUMN provider VARCHAR(64) NULL;
ALTER TABLE fiber_links ADD COLUMN a_device_id BIGINT NULL;
ALTER TABLE fiber_links ADD COLUMN a_ifindex INT NULL;
ALTER TABLE fiber_links ADD COLUMN b_device_id BIGINT NULL;
ALTER TABLE fiber_links ADD COLUMN b_ifindex INT NULL;
