-- 023: let an alert rule apply to only some device types.
--
-- Rules are keyed on a state dimension alone, so `device_down` (ping = down,
-- crit) fires for anything that carries a ping row. That was fine while only
-- switches, APs and recorders had addresses. It stops being fine the moment
-- cameras do: 193 of 2,649 never answer ICMP while Milestone reports every one
-- of them actively recording, spread across every site rather than one subnet.
-- A non-answer there means the model does not speak ICMP, not that the camera
-- is down, so the rule would raise 193 criticals that are provably wrong.
--
-- The alternative was to keep cameras out of the ICMP sweep entirely, which is
-- what NetMon did as a stopgap. But M1 (OpenProject #92) is explicit that the
-- disagreement is the point:
--
--   "ICMP is ground truth and tiebreaker. Milestone reporting a camera online
--    while the network says otherwise is the disagreement worth surfacing, not
--    hiding — and it is why state carries which probe produced it."
--
-- Not sweeping cameras hides it. Sweeping them and scoping the rule records the
-- fact and declines to misread it, which is what that paragraph asks for.
--
-- NULL means "every device type", so every existing rule keeps its behaviour.
-- The value is a comma-separated device_type list.
--
-- rollback: ALTER TABLE alert_rules DROP COLUMN device_types;
--   Safe. Every rule reverts to applying fleet-wide, which is what it did
--   before this column existed — but re-check that cameras are excluded from
--   the ICMP sweep first, or device_down will match them again.

ALTER TABLE alert_rules
  ADD COLUMN device_types VARCHAR(255) NULL AFTER dimension;

-- device_down: reachability rule for devices where ICMP silence means "down".
-- Cameras are deliberately absent — see above.
UPDATE alert_rules
   SET device_types = 'switch,ap,recording_server,trunk,pbx,other'
 WHERE name = 'device_down';
