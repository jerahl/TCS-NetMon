-- 026: Milestone camera groups — the VMS's own organisational tree.
--
-- XProtect's hierarchy is built on cameraGroups: every site/campus/zone an
-- operator sees in the Smart Client tree is a camera group. NetMon has grouped
-- cameras by `devices.site` (the spec 17 resolver) since 10.4, which is right
-- for the network view but is *not* how the surveillance team navigates — they
-- think in the Milestone tree, and the owner asked for that tree specifically.
--
-- Confirmed against the live gateway 2026-09-07 (read-only GET):
--
--     GET /api/rest/v1/cameraGroups?includeChildren=cameras,cameraGroups
--
--   * 26 groups, named by school code: BHS, CHS, NHS, VES, MLK, ARC, CO, BUS…
--   * completely FLAT on this deployment — zero subgroups, so the tree is one
--     level deep today. `parent_id`/`path` are stored anyway because the API
--     models nesting and a future reorganisation must not need a migration.
--   * 2,687 memberships over 2,662 distinct cameras: 25 cameras belong to TWO
--     groups. That is why membership is its own table rather than a column on
--     `cameras` — a single group_id would silently drop one membership, and a
--     camera appearing under both its groups is correct Smart Client behaviour.
--   * three groups are empty (SHEC, OLD TCT, NES). They are kept and rendered,
--     because "this school has no cameras in Milestone" is a real answer and
--     hiding it would look like the group does not exist.
--
-- The group name joins the existing site vocabulary with no new mapping:
-- `sites.name` already IS the school code (BHS), `sites.display_name` the human
-- name ("Paul W. Bryant High") and `sites.group_key` the value carried in
-- `devices.site` ("Bryant High"). So `camera_groups.name = sites.name` gives
-- the tree its labels from data that already exists — nothing hard-coded.
--
-- Both tables are replace-on-refresh, written only by the Milestone collector,
-- with `updated_at` so the UI can badge staleness (§4.5). No state, no history.
--
-- rollback: DROP TABLE camera_group_members; DROP TABLE camera_groups;
--   Safe at any time. Both are descriptive caches re-derived on the next
--   collector cycle; nothing computes device state from them, and the Cameras
--   page falls back to grouping by `devices.site` when the tables are empty.

CREATE TABLE IF NOT EXISTS camera_groups (
    id          VARCHAR(64)  NOT NULL,           -- Milestone group GUID
    name        VARCHAR(128) NOT NULL,           -- displayName, e.g. 'BHS' (= sites.name)
    description VARCHAR(255) NULL,
    parent_id   VARCHAR(64)  NULL,               -- NULL at the root, flat today
    path        VARCHAR(512) NULL,               -- slash-separated lineage
    camera_count INT         NOT NULL DEFAULT 0, -- direct members, as Milestone reports
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_camera_groups_name (name),
    KEY idx_camera_groups_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS camera_group_members (
    group_id   VARCHAR(64) NOT NULL,
    device_id  BIGINT      NOT NULL,
    updated_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, device_id),
    KEY idx_cgm_device (device_id),
    -- Cameras leaving the registry take their memberships with them. No FK to
    -- camera_groups: the collector writes groups then members, and a partial
    -- refresh must not be rejected outright.
    CONSTRAINT fk_cgm_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
