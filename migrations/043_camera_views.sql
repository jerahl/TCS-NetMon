-- 043: Milestone Smart Client views — which cameras someone is actually watching.
--
-- Camera groups (026) are where a camera is *filed*. Views are the layouts
-- operators open in Smart Client. A camera in a group but in no view is a
-- camera nobody is looking at — usually a new install that was added to the
-- VMS but never placed on a layout. The owner asked for the Cameras page to
-- sort/filter on exactly that (2026-11-18).
--
-- Confirmed against the live gateway 2026-11-18 (read-only GET):
--
--     GET /api/rest/v1/viewGroups                     → 55 top-level groups
--     GET /api/rest/v1/viewGroups/{id}/viewGroups     → subgroups (max depth 3)
--     GET /api/rest/v1/viewGroups/{id}/views          → views, items inline
--
--   * 149 subgroups, 395 views, ~409 GETs in ~6 s per full walk.
--   * Each view row carries viewItem[] whose viewItemDefinitionXml names the
--     camera GUID (`cameraid="…"`), so no per-view request is needed.
--   * Only SHARED views (role view groups) and the service account's own
--     Private group are visible. Other users' private views are not, so "in
--     no view" means "in no shared view".
--
-- Both tables are replace-on-refresh, written only by the Milestone collector
-- on a successful, non-empty walk, with `updated_at` so the UI can badge
-- staleness (§4.5). The walk runs every `[milestone] views_interval_s`
-- (default 900 s), and `views_enabled = false` turns it off.
--
-- rollback: DROP TABLE camera_view_members; DROP TABLE camera_views;
--   Safe at any time. Descriptive caches only; nothing computes device state
--   from them, and the API reports `view_count = null` (unknown) when
--   `camera_views` is empty rather than claiming every camera is unwatched.

CREATE TABLE IF NOT EXISTS camera_views (
    id           VARCHAR(64)  NOT NULL,           -- Milestone view GUID
    name         VARCHAR(128) NOT NULL,           -- displayName, e.g. 'Gym'
    top_group    VARCHAR(128) NULL,               -- top-level view group (role), e.g. 'NHS TV'
    path         VARCHAR(512) NULL,               -- 'NHS/Athletics/Gym'
    camera_count INT          NOT NULL DEFAULT 0, -- cameras the view shows, imported or not
    updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_camera_views_top (top_group)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS camera_view_members (
    view_id    VARCHAR(64) NOT NULL,
    device_id  BIGINT      NOT NULL,
    updated_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (view_id, device_id),
    KEY idx_cvm_device (device_id),
    CONSTRAINT fk_cvm_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
