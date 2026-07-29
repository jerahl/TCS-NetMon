-- 020_action_audit.sql — audit log for operator write actions (spec 11 D4).
--
-- These are the FIRST non-GET calls NetMon makes to any source platform, so
-- every attempt is recorded whether or not it succeeds. The row is written
-- BEFORE the call goes out and updated after: a crash, timeout or hung source
-- must still leave evidence that somebody bounced a port. An audit log that
-- only records successes is not an audit log.
--
-- Append-only by convention, like state_events: never UPDATE except to attach
-- the outcome of the row's own in-flight call, never DELETE.
--
-- rollback: DROP TABLE action_audit;
--           DELETE FROM schema_migrations WHERE version = '020';

CREATE TABLE IF NOT EXISTS action_audit (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  requested_at  DATETIME        NOT NULL,
  completed_at  DATETIME        NULL,
  -- Who. Captured from the session at request time; never trusted from the body.
  actor         VARCHAR(190)    NOT NULL,
  actor_role    VARCHAR(16)     NOT NULL,
  -- What. `action` is one of a closed set enforced in code (netmon.api.actions).
  action        VARCHAR(32)     NOT NULL,
  source        VARCHAR(16)     NOT NULL,   -- xiq | packetfence | rconfig
  device_id     INT UNSIGNED    NULL,       -- registry device, when the action targets one
  target        VARCHAR(190)    NULL,       -- human-readable target: port name, MAC, AP name
  params        TEXT            NULL,       -- JSON, sanitised (never a credential)
  -- Outcome. `pending` until the call returns; a row left pending is itself a
  -- finding (the call never came back).
  outcome       VARCHAR(16)     NOT NULL DEFAULT 'pending',  -- pending|ok|failed|refused
  http_status   SMALLINT        NULL,
  message       VARCHAR(500)    NULL,
  duration_ms   INT             NULL,
  PRIMARY KEY (id),
  KEY idx_audit_time (requested_at),
  KEY idx_audit_device (device_id, requested_at),
  KEY idx_audit_actor (actor, requested_at),
  KEY idx_audit_action (action, requested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
