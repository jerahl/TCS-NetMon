-- 008_app_settings.sql — Settings engine (docs/spec/12-settings-engine.md).
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
--   * app_settings    per-key admin overrides of netmon.conf. `value` is the
--                     canonical string form ("true"/"false", "300", raw
--                     string) or, for secrets, a sealed `nmsb1:` token
--                     (netmon/secretbox.py) — NEVER a plaintext credential.
--                     The editable-key registry lives in netmon/settings.py;
--                     rows with keys outside it are ignored (and flagged).
--   * settings_audit  append-only change trail. For secret keys old_value and
--                     new_value are NULL by design — the audit records THAT a
--                     credential changed, never what it was.
--
-- `key` is a MariaDB reserved word -> backtick-quoted here and in every query
-- (same convention as snapshot_cache in 005).
--
-- rollback: (settings_audit is operator-visible history — export
--  `SELECT * FROM settings_audit` first if the trail matters; app_settings
--  overrides revert to netmon.conf values, so note any you want to re-apply)
--   DROP TABLE IF EXISTS settings_audit;
--   DROP TABLE IF EXISTS app_settings;
--   DELETE FROM schema_migrations WHERE version='008';

CREATE TABLE IF NOT EXISTS app_settings (
    `key`       VARCHAR(128) NOT NULL,
    value       TEXT         NULL,
    is_secret   TINYINT(1)   NOT NULL DEFAULT 0,
    updated_by  VARCHAR(128) NOT NULL,
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings_audit (
    id          BIGINT       NOT NULL AUTO_INCREMENT,
    `key`       VARCHAR(128) NOT NULL,
    action      ENUM('set','clear') NOT NULL,
    old_value   TEXT         NULL,
    new_value   TEXT         NULL,
    changed_by  VARCHAR(128) NOT NULL,
    changed_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_settings_audit_key (`key`),
    KEY idx_settings_audit_at (changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
