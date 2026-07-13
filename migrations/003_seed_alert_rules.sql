-- 003_seed_alert_rules.sql — seed the remaining built-in alert rules (§5/§6).
-- Consumed by the Phase 6 engine. `condition` stays backtick-quoted (reserved).
--
-- rollback:
--   DELETE FROM alert_rules WHERE name IN
--     ('device_down','config_backup_stale','camera_not_recording','trunk_unregistered');
--   DELETE FROM schema_migrations WHERE version='003';

INSERT INTO alert_rules (name, dimension, `condition`, severity, min_duration_s, target, enabled)
VALUES
  ('device_down',          'ping',          '{"op":"eq","value":"down"}',  'crit', 180, NULL, 1),
  ('config_backup_stale',  'config_backup', '{"op":"eq","value":"stale"}', 'warn', 604800, NULL, 1),
  ('camera_not_recording', 'recording',     '{"op":"eq","value":"down"}',  'crit', 300, NULL, 1),
  ('trunk_unregistered',   'trunk',         '{"op":"eq","value":"down"}',  'crit', 120, NULL, 1);
