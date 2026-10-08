-- 038: Helpdesk links — NetMon-owned relationships between Frontline Help Desk
-- tickets and local Problems / Issues / Changes (docs/spec/25-helpdesk.md).
-- Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- Ownership is split on purpose. A ticket, its fields, comments and
-- attachments belong to Frontline; NetMon never stores a second copy of them
-- and never writes to them. What NetMon owns is the *relationship*: "this
-- ticket is about that issue", who said so, when, and why. That fact lives
-- nowhere else, so it lives here.
--
-- Three tables, kept separate so that each can fail without taking another
-- with it:
--
--   helpdesk_links        the relationship itself (authoritative, NetMon's)
--   helpdesk_link_events  link / unlink audit trail, attributed to a user
--   helpdesk_ticket_cache a small, refreshable summary of LINKED tickets only,
--                         so a link still renders "#4821 · Projector in 204"
--                         while the help desk is down. Never authoritative,
--                         never joined into the link's identity: a refresh
--                         failure can mark a row stale but cannot erase a link.

CREATE TABLE IF NOT EXISTS helpdesk_links (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Which help desk integration the ticket number belongs to. One today
  -- ('frontline'); a column rather than an assumption because a ticket number
  -- is only unique within its own system.
  instance      VARCHAR(64)     NOT NULL,
  -- The external ticket identifier, as the help desk spells it. VARCHAR, never
  -- an integer column: an identifier is a label, and a numeric conversion can
  -- drop leading zeros or overflow without anybody noticing.
  ticket_ref    VARCHAR(64)     NOT NULL,
  -- problem = alerts.id, issue = issues.id, change = changes.id. Polymorphic,
  -- so no foreign key: existence is validated by the API at link time, and a
  -- link whose record is later deleted stays visible as "no longer exists"
  -- rather than silently vanishing.
  record_type   VARCHAR(16)     NOT NULL,
  record_id     BIGINT UNSIGNED NOT NULL,
  note          VARCHAR(500)    NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by    VARCHAR(128)    NOT NULL,
  PRIMARY KEY (id),
  -- One link per (ticket, record). Many-to-many either way, never duplicated.
  UNIQUE KEY uq_helpdesk_link (instance, ticket_ref, record_type, record_id),
  KEY idx_helpdesk_link_record (record_type, record_id),
  KEY idx_helpdesk_link_ticket (instance, ticket_ref),
  CONSTRAINT ck_helpdesk_link_type CHECK (record_type IN ('problem', 'issue', 'change'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only. Unlinking deletes the helpdesk_links row; this is where the fact
-- that it once existed, and who removed it, survives.
CREATE TABLE IF NOT EXISTS helpdesk_link_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  instance      VARCHAR(64)     NOT NULL,
  ticket_ref    VARCHAR(64)     NOT NULL,
  record_type   VARCHAR(16)     NOT NULL,
  record_id     BIGINT UNSIGNED NOT NULL,
  action        VARCHAR(16)     NOT NULL,   -- link | unlink
  actor         VARCHAR(128)    NOT NULL,
  note          VARCHAR(500)    NULL,
  occurred_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_helpdesk_event_record (record_type, record_id),
  KEY idx_helpdesk_event_ticket (instance, ticket_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Summary of a linked ticket, as last seen. Deliberately thin: the workbook's
-- privacy rule (ticket#, subject, category, status, dates) — no description,
-- no requester, no comments. Rows exist only for tickets somebody linked.
--
-- `state` separates three things an operator must not confuse:
--   ok           the help desk returned this ticket on the last attempt
--   inaccessible the help desk refused it (401/403) — it may well still exist
--   not_found    the help desk answered 404 — gone, or outside the scope the
--                integration identity can see; NetMon cannot tell which
-- A help desk outage changes none of these; it only ages `fetched_at`.
CREATE TABLE IF NOT EXISTS helpdesk_ticket_cache (
  instance      VARCHAR(64)     NOT NULL,
  ticket_ref    VARCHAR(64)     NOT NULL,
  subject       VARCHAR(300)    NULL,
  status        VARCHAR(100)    NULL,
  priority      VARCHAR(100)    NULL,
  site          VARCHAR(200)    NULL,
  category      VARCHAR(300)    NULL,
  assigned_to   VARCHAR(200)    NULL,
  created_date  VARCHAR(40)     NULL,   -- as the help desk reports it (UTC ISO)
  updated_date  VARCHAR(40)     NULL,
  is_active     TINYINT         NULL,
  state         VARCHAR(16)     NOT NULL DEFAULT 'ok',
  fetched_at    TIMESTAMP       NULL,   -- last time the help desk answered for it
  checked_at    TIMESTAMP       NULL,   -- last time NetMon asked
  PRIMARY KEY (instance, ticket_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- rollback:
--   DROP TABLE helpdesk_ticket_cache;
--   DROP TABLE helpdesk_link_events;
--   DROP TABLE helpdesk_links;
-- Nothing else references these tables. Dropping them loses NetMon's record of
-- which tickets relate to which problems/issues/changes — export first
-- (SELECT * FROM helpdesk_links) if that history matters. No ticket data in
-- Frontline is affected either way.
