-- 029: bulk camera operations — firmware images and batches (spec 20 S8 / D11).
--
-- These tables exist before anything can write to a camera, on purpose. Every
-- condition that makes a fleet-wide hardware write survivable is a *record*:
-- which image, verified how, against which models, one row per camera with what
-- happened to it. A push whose evidence lives only in a log line is one nobody
-- can audit afterwards, and a batch that cannot be resumed after a restart
-- becomes a half-updated fleet with no list of which half.
--
-- Nothing here grants the ability to write. That is `[camera_ops]`, default off,
-- dry-run by default, admin-only, and every item still goes through the D4 audit
-- chokepoint (`action_audit`, migration 020) so the record of what NetMon sent
-- to a device stays in one place.
--
-- rollback: DROP TABLE camera_batch_items;
--           DROP TABLE camera_batches;
--           DROP TABLE firmware_images;
--           DELETE FROM schema_migrations WHERE version = '029';

-- Vetted firmware, uploaded by an admin through NetMon or dropped on disk and
-- registered. A push refers to an image by id — never a caller-supplied path or
-- URL, which is the same closed-registry rule the snapshot proxy follows.
CREATE TABLE IF NOT EXISTS firmware_images (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  vendor        VARCHAR(32)     NOT NULL,   -- bosch | axis | hanwha (profile key)
  -- Version as the vendor writes it. Compared through netmon.cameras.firmware,
  -- never with `=`: this estate reports the same release as both `7.83.0027`
  -- and `783`, and 11 of 38 models carry both forms.
  version       VARCHAR(64)     NOT NULL,
  filename      VARCHAR(255)    NOT NULL,
  -- Path under [camera_ops] firmware_dir. Stored relative so moving the store
  -- does not invalidate every row.
  rel_path      VARCHAR(512)    NOT NULL,
  size_bytes    BIGINT UNSIGNED NOT NULL,
  -- SHA-256 recorded at upload and re-checked before every push. An image that
  -- changed on disk between upload and roll is not the image that was vetted.
  sha256        CHAR(64)        NOT NULL,
  -- JSON array of model strings this image may be sent to, matched against
  -- cameras.model. A push refuses any camera not on it. There is no "all"
  -- value by design: 84 distinct model×firmware pairs live here, and a wrong
  -- image is a truck roll.
  models        TEXT            NOT NULL,
  notes         TEXT            NULL,
  uploaded_by   VARCHAR(190)    NOT NULL,
  uploaded_at   DATETIME        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_firmware_sha (sha256),
  KEY ix_firmware_vendor (vendor, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One requested operation over a chosen set of cameras.
CREATE TABLE IF NOT EXISTS camera_batches (
  id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  -- firmware_update | config_change. Op-agnostic on purpose: the setting
  -- catalogue is deferred (owner, 2026-09-07) and must be able to arrive
  -- without reworking the runner.
  op              VARCHAR(32)   NOT NULL,
  firmware_id     INT UNSIGNED  NULL,       -- firmware_update
  setting_key     VARCHAR(64)   NULL,       -- config_change, catalogue key
  setting_value   VARCHAR(255)  NULL,
  -- draft → previewed → running → done | aborted | failed. `dry_run` batches
  -- reach `done` having sent nothing; the items say `would_run`.
  status          VARCHAR(16)   NOT NULL DEFAULT 'draft',
  dry_run         TINYINT(1)    NOT NULL DEFAULT 1,
  -- The ring discipline this batch runs under, copied from config at creation
  -- so a later config edit cannot change the rules a running batch plays by.
  canary_count    SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  ring_size       SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  max_concurrent  SMALLINT UNSIGNED NOT NULL DEFAULT 3,
  abort_pct       SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  reboot_timeout_s INT UNSIGNED NOT NULL DEFAULT 300,
  -- Firmware never rolls during the school day unless an admin says so.
  not_before      DATETIME      NULL,
  created_by      VARCHAR(190)  NOT NULL,
  created_at      DATETIME      NOT NULL,
  started_at      DATETIME      NULL,
  finished_at     DATETIME      NULL,
  -- Why it stopped, when it stopped itself: the abort threshold, an operator,
  -- or a pre-flight that emptied it.
  message         TEXT          NULL,
  PRIMARY KEY (id),
  KEY ix_batches_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One camera in one batch. This is the row an operator reads at 7am to find out
-- what happened overnight, so it carries the before-and-after rather than a
-- verdict alone.
CREATE TABLE IF NOT EXISTS camera_batch_items (
  id            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  batch_id      INT UNSIGNED  NOT NULL,
  device_id     INT UNSIGNED  NOT NULL,
  -- Which ring it belongs to. 0 is the canary, which runs alone and gates
  -- everything after it.
  ring          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  -- pending | would_run | running | verified | indeterminate | failed | skipped
  --
  -- `indeterminate` is not a synonym for failure and not a synonym for success:
  -- 888 cameras report firmware as `783`, which cannot prove they are on
  -- `7.90.0123`. The upgrade may well have worked; nobody can show it did, and
  -- a roll that quietly counted those as verified would be claiming evidence it
  -- does not have.
  status        VARCHAR(16)   NOT NULL DEFAULT 'pending',
  -- What the camera reported before the write and after it, as the camera
  -- wrote it — not normalised, so the raw evidence survives.
  before_value  VARCHAR(128)  NULL,
  after_value   VARCHAR(128)  NULL,
  -- Which read answered: vendor | milestone. The owner chose vendor-first with
  -- Milestone as fallback (2026-09-08), and which one spoke changes how much
  -- the answer is worth.
  verified_by   VARCHAR(16)   NULL,
  -- The audit_action row for this item's write, so the batch and the audit log
  -- point at each other.
  audit_id      BIGINT UNSIGNED NULL,
  message       TEXT          NULL,
  started_at    DATETIME      NULL,
  finished_at   DATETIME      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_batch_device (batch_id, device_id),
  KEY ix_items_status (batch_id, status),
  KEY ix_items_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
