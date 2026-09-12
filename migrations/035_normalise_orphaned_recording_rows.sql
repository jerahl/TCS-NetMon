-- 035_normalise_orphaned_recording_rows.sql — retire the last 8 `recording = up` claims.
-- Target: MariaDB 10.x. See docs/spec/23-camera-recording-truth.md §3 R1.
--
-- The collector now writes `recording = unknown` for every camera Milestone
-- returns, because nothing NetMon can reach measures whether a camera is
-- actually recording. But it only writes rows for cameras it can still link —
-- so a camera Milestone has *dropped* keeps whatever its last `recording` row
-- said, forever.
--
-- On this estate that left 8 rows frozen at `up` / `ok`, the oldest since
-- 2026-08-07. Their `source_status` had correctly gone `blind` and their
-- `reachability` `unknown`; only `recording` still asserted health, for cameras
-- the VMS no longer even lists.
--
-- One statement, because the value is now a constant by design: no row in this
-- dimension can honestly say anything but `unknown` until something measures
-- it. `updated_at` is left to the column's ON UPDATE so the row dates from this
-- correction rather than pretending to a fresh observation.
--
-- rollback: none meaningful — the previous values were the fabricated claim
--           this migration exists to remove. Re-deriving them is not desirable.
--           (To undo mechanically: there is no stored prior value; restore from
--           a dump.)

UPDATE device_state
   SET value = 'unknown', severity = 'unknown'
 WHERE dimension = 'recording'
   AND (value <> 'unknown' OR severity <> 'unknown');
