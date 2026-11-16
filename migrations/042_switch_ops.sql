-- 042_switch_ops.sql — direct SNMP switch writes: the "never leave a port down" ledger.
-- Target: MariaDB 10.x, InnoDB, utf8mb4. Spec: docs/spec/26-switch-ops.md.
--
-- NetMon's [switch_ops] actions (PoE cycle, port bounce) SET objects on a
-- switch over SNMPv3. Two of the SETs take something away — ifAdminStatus
-- down(2) and pethPsePortAdminEnable false(2) — and must be undone a few
-- seconds later. If netmon.service crashes, is restarted, or loses the switch
-- between the two halves, the port would stay down with nobody watching.
--
-- So the restore is written down BEFORE the taking-away SET is sent:
--
--   * switch_port_restores  one row per outstanding restore. Inserted before
--                           the "off/down" SET, deleted once the "on/up" SET
--                           has been accepted. A row whose `deadline` has
--                           passed is re-applied by the restore sweep in
--                           netmon-poller.service (a different process from
--                           the one that took the port down), which also opens
--                           a `switch_port_restore` alert so a person hears
--                           about it.
--
-- The PoE *reset* path (extremePethPortResetPower = set(1)) is a single
-- self-completing SET and writes no row here.
--
-- `restore_oid` / `restore_value` are the exact object and INTEGER value the
-- sweep will SET. They are computed from the switch's own index when the row
-- is written, so the sweep never re-derives a port from names that may have
-- changed in between.
--
-- The rule's dimension is 'reachability' (alert_rules.dimension is an ENUM; a
-- port left down makes whatever is on it unreachable). It is never evaluated
-- against device_state: alert_rules.managed_by gains 'switch_ops', and the alert engine evaluates only
-- 'engine' rules (engine.py `_rules`), so this rule is opened and closed by the
-- restore sweep alone, exactly as 'automation' rules are by the workflow runner.
--
-- rollback:
--   DELETE FROM alert_rules WHERE name = 'switch_port_restore';
--   ALTER TABLE alert_rules MODIFY managed_by ENUM('engine','automation')
--     NOT NULL DEFAULT 'engine';
--   DROP TABLE switch_port_restores;
--   DELETE FROM schema_migrations WHERE version = '042';
-- (Check switch_port_restores is empty first: a row there is a port that
-- may still be down.)

CREATE TABLE IF NOT EXISTS switch_port_restores (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id      BIGINT          NOT NULL,
  ifindex        BIGINT          NOT NULL,
  port           VARCHAR(64)     NOT NULL,      -- "slot:port", for people
  action         VARCHAR(32)     NOT NULL,      -- snmp_port_bounce | snmp_poe_cycle
  restore_oid    VARCHAR(128)    NOT NULL,      -- numeric OID the sweep SETs
  restore_value  INT             NOT NULL,      -- INTEGER value it SETs (1 = up / true)
  deadline       DATETIME        NOT NULL,      -- UTC, after this the sweep restores
  actor          VARCHAR(190)    NOT NULL,
  audit_id       BIGINT UNSIGNED NULL,          -- action_audit row that took the port down
  created_at     DATETIME        NOT NULL,
  attempts       INT             NOT NULL DEFAULT 0,
  last_attempt_at DATETIME       NULL,
  last_error     VARCHAR(500)    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_restore_port (device_id, ifindex, action),
  KEY idx_restore_deadline (deadline)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE alert_rules
  MODIFY managed_by ENUM('engine','automation','switch_ops') NOT NULL DEFAULT 'engine';

INSERT INTO alert_rules (name, dimension, device_types, `condition`, severity,
                         min_duration_s, enabled, managed_by)
VALUES ('switch_port_restore', 'reachability', 'switch',
        '{"op":"eq","value":"overdue"}', 'crit', 0, 1, 'switch_ops');
