-- 036: issue tracker — human-authored problem records
-- (docs/spec/24-issue-tracker.md). Target: MariaDB 10.x, InnoDB, utf8mb4.
--
-- NetMon already records what the network did. `state_events` is machine truth
-- about transitions and `alerts` is the engine's open-fault list — neither has
-- an author, a narrative, or anywhere to put a packet capture. An alert also
-- closes the moment the symptom stops, which is exactly when the finding
-- becomes worth keeping. These four tables are the human half of the record.
--
-- Nothing here is written by a collector. Every row has a person's name on it,
-- and no row is ever rewritten by a background task — which is why `issues`
-- can carry a mutable `status` without breaking the §6 invariant that keeps
-- `state_events` append-only.
--
--   * issues              one problem somebody is working on
--   * issue_devices       which registered devices it concerns
--   * issue_comments      the thread, including status changes as entries
--   * issue_attachments   evidence on disk, indexed here
--
-- rollback: DROP TABLE issue_attachments;
--           DROP TABLE issue_comments;
--           DROP TABLE issue_devices;
--           DROP TABLE issues;
--           DELETE FROM schema_migrations WHERE version = '036';
--           (files under [issues] attachment_dir are NOT removed by the
--            rollback — they are evidence, and a dropped table is not a
--            decision to destroy them. Remove the directory by hand.)

CREATE TABLE IF NOT EXISTS issues (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  title         VARCHAR(200)    NOT NULL,
  -- The narrative: findings, reproduction, plan. Markdown-ish plain text,
  -- rendered as text — NetMon ships no markdown parser and will not take one
  -- as a dependency for this.
  body          MEDIUMTEXT      NOT NULL,
  -- open | investigating | waiting | planned | resolved | closed
  --
  -- `waiting` means waiting on somebody else (a vendor, a school, an approval)
  -- and exists because the wireless work spent real days there — without it
  -- those issues read as untouched. `planned` means the fix is agreed and
  -- scheduled but not applied, which is a different thing from resolved and
  -- the state most of the wireless plan sits in.
  status        VARCHAR(16)     NOT NULL DEFAULT 'open',
  -- crit | warn | info. Deliberately the project's severity vocabulary minus
  -- `ok` (an issue is never "ok") so the existing Dot/SevText primitives
  -- render it without a second colour scheme.
  severity      VARCHAR(8)      NOT NULL DEFAULT 'warn',
  -- wireless | switching | surveillance | voip | nac | facilities | other.
  -- Free text with a suggested set rather than an enum: the set will be wrong
  -- within a year and a migration to add `power` would be silly.
  category      VARCHAR(32)     NOT NULL DEFAULT 'other',
  -- Joined to sites.name / devices.site the same loose way the rest of the app
  -- joins it. No FK on purpose: a report names a school before anyone checks
  -- whether the registry spells it the same way, and refusing the report over
  -- that would lose the report.
  site          VARCHAR(190)    NULL,
  -- Usernames as the session carries them, not user ids — NetMon has no user
  -- table (sessions come from ClassLink SAML claims).
  reported_by   VARCHAR(190)    NOT NULL,
  assigned_to   VARCHAR(190)    NULL,
  created_at    DATETIME        NOT NULL,
  updated_at    DATETIME        NOT NULL,
  -- Set when status first becomes resolved/closed, cleared if it is reopened.
  -- Kept as its own column rather than derived from the comment thread so
  -- "closed this month" is one index scan.
  resolved_at   DATETIME        NULL,
  PRIMARY KEY (id),
  KEY ix_issues_status (status, severity, updated_at),
  KEY ix_issues_site (site, status),
  KEY ix_issues_assigned (assigned_to, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which registered devices an issue is about. Many-to-many: the NMS finding
-- named two APs, and both matter.
CREATE TABLE IF NOT EXISTS issue_devices (
  issue_id      INT UNSIGNED    NOT NULL,
  device_id     INT UNSIGNED    NOT NULL,
  -- Free note for what this device contributed — "conntrack table at 15,890",
  -- "baseline AP". Optional; the link alone is usually enough.
  note          VARCHAR(255)    NULL,
  PRIMARY KEY (issue_id, device_id),
  KEY ix_issue_devices_device (device_id),
  CONSTRAINT fk_issue_devices_issue FOREIGN KEY (issue_id)
    REFERENCES issues (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- Note the asymmetry: CASCADE from the issue, nothing from `devices`. A device
-- decommissioned after the investigation must not quietly erase the record that
-- it was the one that filled its connection table. The API renders an id that
-- no longer resolves as "device N, no longer registered".

CREATE TABLE IF NOT EXISTS issue_comments (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  issue_id      INT UNSIGNED    NOT NULL,
  -- comment | status_change. Status changes live in the same table so the
  -- timeline is one ordered query rather than a merge of two, and so the
  -- reason for a change sits in the same row as the change.
  kind          VARCHAR(16)     NOT NULL DEFAULT 'comment',
  body          MEDIUMTEXT      NOT NULL,
  author        VARCHAR(190)    NOT NULL,
  created_at    DATETIME        NOT NULL,
  -- NULL until the author edits it. Present means "this text is not what was
  -- originally written", which a reader of an incident thread needs to know.
  edited_at     DATETIME        NULL,
  PRIMARY KEY (id),
  KEY ix_issue_comments_issue (issue_id, created_at),
  CONSTRAINT fk_issue_comments_issue FOREIGN KEY (issue_id)
    REFERENCES issues (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Evidence. The bytes live under [issues] attachment_dir; this is the index.
CREATE TABLE IF NOT EXISTS issue_attachments (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  issue_id      INT UNSIGNED    NOT NULL,
  -- Set when the file arrived with a comment, so the timeline can show it in
  -- place. NULL means it hangs off the issue itself.
  comment_id    INT UNSIGNED    NULL,
  -- As the uploader's browser called it, for display. The name on disk is
  -- `<id>-<sanitised>`; this column is never used to build a path.
  filename      VARCHAR(255)    NOT NULL,
  -- The type NetMon DECIDED, after sniffing the leading bytes and checking
  -- them against the extension — never the type the client claimed. This
  -- column is what the download route puts in the Content-Type header, so a
  -- client-supplied value here would be stored XSS with extra steps.
  content_type  VARCHAR(100)    NOT NULL,
  size_bytes    BIGINT UNSIGNED NOT NULL,
  -- Recorded at upload. Not a dedupe key — the same screenshot attached to
  -- three issues keeps three files, because deleting one issue must not blank
  -- an image in another. It is how the storage report says "these are the
  -- same bytes" and how a restore is verified.
  sha256        CHAR(64)        NOT NULL,
  -- Relative to attachment_dir, so moving the store does not invalidate every
  -- row (same reasoning as firmware_images.rel_path, migration 029).
  rel_path      VARCHAR(512)    NOT NULL,
  uploaded_by   VARCHAR(190)    NOT NULL,
  uploaded_at   DATETIME        NOT NULL,
  PRIMARY KEY (id),
  KEY ix_issue_attachments_issue (issue_id, uploaded_at),
  KEY ix_issue_attachments_comment (comment_id),
  CONSTRAINT fk_issue_attachments_issue FOREIGN KEY (issue_id)
    REFERENCES issues (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
