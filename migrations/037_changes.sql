-- 037: change tracking — what was changed, why, what was expected, what happened
-- (docs/spec/24-issue-tracker.md §10). Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- The other half of the issue tracker. An issue records a problem; this records
-- a deliberate act taken against one, and — the part that makes it worth having
-- — whether that act did what the person expected.
--
-- Everything else in this database records what the network did. `changes`
-- records what WE did to it, and holds the prediction alongside the outcome so
-- the two can be compared later by somebody who was not there.
--
-- Three things in here are not in a generic change log, and each comes from how
-- this estate is actually worked:
--
--   * `expected` is written BEFORE the change and `actual` after, in separate
--     columns. A single "notes" field lets the prediction be quietly rewritten
--     once the result is known, which is exactly the failure this table exists
--     to prevent.
--   * `verdict` forces the comparison to be stated rather than left to a
--     reader's inference, and `no_effect` / `worse` are first-class answers. A
--     change log where every entry reads as a success is a change log nobody
--     learns from.
--   * `change_devices.role` distinguishes the device a change was APPLIED to
--     from the device held as a BASELINE. The standing method here is to change
--     one AP and compare it against a neighbouring one across the same school
--     day; without the distinction, the record cannot say which AP was which.
--
-- An applied change that was never verified is the thing this table is really
-- for. `status = 'applied'` with `verdict = 'pending'` is the outstanding-work
-- query, and the API surfaces it rather than waiting to be asked (§5, fail loud).
--
-- rollback: DROP TABLE change_devices;
--           DROP TABLE changes;
--           DELETE FROM schema_migrations WHERE version = '037';

CREATE TABLE IF NOT EXISTS changes (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  -- The issue this change was made against. NULL is allowed: routine work
  -- happens that nobody opened an issue for, and refusing to record it would
  -- mean it goes unrecorded rather than that an issue gets opened.
  --
  -- ON DELETE SET NULL, not CASCADE. Deleting an issue must not destroy the
  -- record that a device was reconfigured — that record outlives the problem
  -- that prompted it, and is what somebody reads a year later asking why a
  -- timeout is set the way it is.
  issue_id      INT UNSIGNED    NULL,
  title         VARCHAR(200)    NOT NULL,

  -- WHAT: the change itself, concretely enough to repeat or reverse — the
  -- setting, the old and new values, the scope it was applied to.
  what          MEDIUMTEXT      NOT NULL,
  -- WHY: the reasoning. Separate from `what` on purpose. The reason is what
  -- decays first and what a later reader most needs; kept in the same field it
  -- gets edited away as the description is tidied.
  why           MEDIUMTEXT      NOT NULL,
  -- EXPECTED: written before the change, ideally with a number somebody can
  -- check ("DNS entries 4,620 → ~1,087, about −76%").
  expected      MEDIUMTEXT      NOT NULL,
  -- ACTUAL: written after. NULL until somebody goes back and looks, which is
  -- precisely the state worth reporting on.
  actual        MEDIUMTEXT      NULL,

  -- proposed | approved | applied | verified | reverted | abandoned
  --
  -- `approved` is its own state because some changes here need a human
  -- decision before they are made, and "waiting on approval" must not look the
  -- same as "nobody has started".
  status        VARCHAR(16)     NOT NULL DEFAULT 'proposed',
  -- pending | as_expected | partial | no_effect | worse
  --
  -- The honest comparison of `expected` against `actual`. Stays `pending`
  -- while the change is unverified, whatever its status.
  verdict       VARCHAR(16)     NOT NULL DEFAULT 'pending',
  -- low | medium | high — the risk as judged BEFORE applying, kept afterwards
  -- so a pattern of "low risk" changes going wrong is visible.
  risk          VARCHAR(8)      NOT NULL DEFAULT 'low',

  site          VARCHAR(190)    NULL,
  -- How to undo it. Required in practice by the project's per-step
  -- reversibility rule (CLAUDE.md §4.3); a change nobody wrote a way back from
  -- is one somebody will be reconstructing under pressure.
  rollback      MEDIUMTEXT      NULL,

  proposed_by   VARCHAR(190)    NOT NULL,
  proposed_at   DATETIME        NOT NULL,
  -- When it actually went in. NULL while proposed or approved; this, not
  -- `status`, is what a timeline is drawn from.
  applied_by    VARCHAR(190)    NULL,
  applied_at    DATETIME        NULL,
  verified_by   VARCHAR(190)    NULL,
  verified_at   DATETIME        NULL,
  reverted_at   DATETIME        NULL,
  updated_at    DATETIME        NOT NULL,

  PRIMARY KEY (id),
  KEY ix_changes_status (status, verdict, applied_at),
  KEY ix_changes_issue (issue_id),
  KEY ix_changes_site (site, status),
  CONSTRAINT fk_changes_issue FOREIGN KEY (issue_id)
    REFERENCES issues (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which devices a change touched, and which were held back as controls.
CREATE TABLE IF NOT EXISTS change_devices (
  change_id     INT UNSIGNED    NOT NULL,
  device_id     INT UNSIGNED    NOT NULL,
  -- target | baseline
  --
  -- The distinction the standing test method depends on: change one AP, leave
  -- a neighbour alone, compare the two over the same school day. A record that
  -- lists both without saying which was which cannot be read afterwards.
  role          VARCHAR(16)     NOT NULL DEFAULT 'target',
  note          VARCHAR(255)    NULL,
  PRIMARY KEY (change_id, device_id),
  KEY ix_change_devices_device (device_id),
  CONSTRAINT fk_change_devices_change FOREIGN KEY (change_id)
    REFERENCES changes (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- Same asymmetry as issue_devices (036): CASCADE from the change, no FK to
-- `devices`. A device leaving the registry must not erase the record that it
-- was reconfigured.
