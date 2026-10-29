-- 039: each camera's VCA configuration, per video line (spec 13 §11).
--
-- Written only by `python -m netmon.cameras.runner --pull-vca --apply`, from
-- RCP+ reads (CONF_VIPROC_ID / _MODE / _CONFIG_NAME / _DLL_NAME,
-- CONF_VCA_TASK_RUNNING_STATE). Nothing here is sent back to a camera.
--
-- `updated_at` moves only when the camera answered; `checked_at` moves on every
-- attempt. A camera that stops answering keeps its last values with `error`
-- set, so the gap shows as stale rather than as "VCA off".
--
-- Numbered 039 to stay clear of 036-038 on the helpdesk/issues branches.
--
-- rollback: DROP TABLE camera_vca;
--           DELETE FROM schema_migrations WHERE version = '039';

CREATE TABLE IF NOT EXISTS camera_vca (
  device_id     BIGINT           NOT NULL,
  line          TINYINT UNSIGNED NOT NULL,
  viproc_id     INT UNSIGNED     NULL,       -- 0 = the line has no VCA
  mode          SMALLINT         NULL,       -- raw CONF_VIPROC_MODE
  mode_label    VARCHAR(32)      NULL,       -- profile N | off | scheduler | script | vca
  profile_name  VARCHAR(64)      NULL,
  engine        VARCHAR(64)      NULL,
  running       TINYINT(1)       NULL,       -- 0 = engine short of CPU
  error         VARCHAR(255)     NULL,
  checked_at    TIMESTAMP        NULL,
  updated_at    TIMESTAMP        NULL,
  PRIMARY KEY (device_id, line)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
