-- 040_automation_escalation_rule.sql — let a workflow "Escalate" node open a real alert.
-- Target: MariaDB 10.x. See docs/spec/22-automation-workflows.md §6b.
--
-- Until now an `alert` node in an automation workflow only wrote a line in
-- `workflow_run_steps`. Nobody was told. The escalations it exists for ("still
-- down 5 minutes after its PoE port was cycled", "no confirmed port", "its
-- switch is down") are exactly the ones that need a human.
--
-- Every alert needs a rule (alerts.rule_id is NOT NULL, FK). But the alert
-- engine evaluates every enabled rule each cycle *and closes every open alert
-- of that rule whose device it did not match* — so a rule the engine also
-- evaluated would either open its own alerts for every down camera, or close
-- the workflow's alert 30 seconds after it opened. Hence `managed_by`:
--
--   * 'engine'      (default — every existing rule) evaluated by the alert engine;
--   * 'automation'  never evaluated by the engine. The workflow runner opens its
--                   alerts and closes them when the device's state no longer
--                   matches the rule's condition (the camera came back).
--
-- Notifications go through the same notifier as every other alert, so
-- [engine] shadow, the SMTP settings and maintenance windows all apply
-- unchanged. Disabling this rule stops new escalation alerts and lets the
-- engine's orphan sweep close any open ones.
--
-- rollback: DELETE FROM alerts WHERE rule_id IN
--             (SELECT id FROM alert_rules WHERE name = 'automation_escalation');
--           DELETE FROM alert_rules WHERE name = 'automation_escalation';
--           ALTER TABLE alert_rules DROP COLUMN managed_by;

ALTER TABLE alert_rules
  ADD COLUMN managed_by ENUM('engine','automation') NOT NULL DEFAULT 'engine'
  AFTER enabled;

INSERT INTO alert_rules (name, dimension, device_types, `condition`, severity,
                         min_duration_s, enabled, managed_by)
VALUES ('automation_escalation', 'source_status', NULL,
        '{"op":"eq","value":"down"}', 'crit', 0, 1, 'automation');
