-- 034_retire_camera_not_recording_rule.sql — disable an alert rule that cannot fire.
-- Target: MariaDB 10.x. See docs/spec/23-camera-recording-truth.md.
--
-- `camera_not_recording` (seeded in 002) watches `device_state.recording` for
-- the value `down`. That dimension was derived from Milestone's
-- `recordingEnabled`/`enabled` — *configuration*, not observation — so it read
-- `up` for all 2,659 cameras and never moved. The rule has opened **zero**
-- alerts in its entire life, which is the tell.
--
-- It went on reading `up` through 2026-09-11 19:49:14, when all 234 cameras
-- behind NHS-BCD-DVR stopped recording because the recorder filled up.
--
-- The collector now writes `recording = unknown` (§4.5: do not assert health
-- that was never measured), so this rule's condition can never match. An
-- enabled rule named `camera_not_recording` that structurally cannot fire is
-- worse than no rule: it tells an operator reading the rules list that
-- cameras-not-recording is monitored. It is not.
--
-- Disabled rather than deleted, so the row still documents the intent for
-- whoever wires a real recording signal (that needs WinRM for consumed disk
-- space — OpenProject #111 — or a non-motion-triggered ESS signal).
--
-- The alert engine closes alerts orphaned by a disabled rule on its next cycle,
-- so nothing is left hanging. There are none to close here.
--
-- rollback: UPDATE alert_rules SET enabled = 1 WHERE name = 'camera_not_recording';
--           (only meaningful once `recording` carries a measured value again)

UPDATE alert_rules
   SET enabled = 0
 WHERE name = 'camera_not_recording'
   AND dimension = 'recording';
