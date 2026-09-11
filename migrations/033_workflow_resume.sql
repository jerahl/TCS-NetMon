-- 033_workflow_resume.sql — let a paused workflow run resume
-- (docs/spec/22-automation-workflows.md §7, phase 22.2).
--
-- 22.1 shipped `wait` nodes that end the evaluation and say "resumes on a later
-- cycle" — but nothing resumed them, because the run had no cursor. That made
-- the whole ping-up arm of the camera workflow dead past its first step: the
-- run stopped at `settle` and the `camera_reboot` fallback behind it was
-- unreachable.
--
-- Three columns fix it:
--   * resume_at    when the run becomes eligible again (NULL = not waiting)
--   * resume_node  which node to continue from
--   * status       gains 'waiting', so a paused run is distinguishable from a
--                  finished one. Without it the idempotence check (W9) could
--                  not tell "this device is mid-remediation, leave it alone"
--                  from "this device was remediated and we are done".
--
-- The status column is widened rather than re-typed: adding a value to a
-- MariaDB ENUM is an in-place metadata change, and every existing row keeps its
-- value.
--
-- rollback: ALTER TABLE workflow_runs DROP COLUMN resume_at,
--                                     DROP COLUMN resume_node;
--           (the ENUM keeps 'waiting'; harmless, and dropping it would fail
--            while any paused row still holds it)

ALTER TABLE workflow_runs
    ADD COLUMN resume_at   DATETIME    NULL DEFAULT NULL AFTER finished_at,
    ADD COLUMN resume_node VARCHAR(64) NULL DEFAULT NULL AFTER resume_at,
    MODIFY COLUMN status ENUM('running','waiting','done','refused','failed','awaiting_approval')
        NOT NULL DEFAULT 'running';

-- The resume sweep runs every cycle and must not scan the table.
CREATE INDEX idx_wf_runs_resume ON workflow_runs (status, resume_at);
