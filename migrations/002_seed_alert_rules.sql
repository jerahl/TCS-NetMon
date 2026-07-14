-- 002_seed_alert_rules.sql — seed built-in source-status alert rules.
-- Target: MariaDB 10.x. These rows sit inert until the Phase 6 alert engine
-- evaluates them; seeding here satisfies the Phase 3 "built-in source-blind
-- rule" DoD. `condition` is a reserved word → backtick-quoted (see 001).
--
-- rollback:
--   DELETE FROM alert_rules WHERE name IN ('source_blind','device_source_down');
--   DELETE FROM schema_migrations WHERE version='002';
-- (Safe: removes only these seed rows. If an operator has since edited them,
--  review before deleting.)

INSERT INTO alert_rules (name, dimension, `condition`, severity, min_duration_s, target, enabled)
VALUES
  ('source_blind', 'source_status', '{"op":"eq","value":"blind"}', 'warn', 300, NULL, 1),
  ('device_source_down', 'source_status', '{"op":"eq","value":"down"}', 'crit', 180, NULL, 1);
