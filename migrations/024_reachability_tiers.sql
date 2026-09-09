-- 024: reachability tiers — what two independent probes agree on.
--
-- NetMon holds two answers to "is this reachable": the source platform's
-- (source_status) and the network's (ping). They disagree often enough to
-- matter, and the shape of the disagreement decides the action:
--
--   both down            the device is gone; dispatch someone
--   source down, net up  the box is on the network but its platform cannot
--                        talk to it — a service, a credential, or the
--                        recording server. Rebooting the device is the wrong
--                        first move.
--   net down, source up  the platform is content and ICMP is silent, which on
--                        a camera usually means the model does not answer ICMP
--                        rather than that anything is wrong.
--
-- Measured on this estate the day this landed: 91 both-down, 59 source-down-
-- network-up, 18 the reverse. Collapsing those into one "down" throws away the
-- part that decides what to do, which is why this is its own dimension.
--
-- The owner asked for these tiers to key automated workflows off, so the values
-- are a stable vocabulary rather than a rendering detail — a workflow can match
-- on the rule name or the state value and both are meant to hold.
--
-- rollback:
--   DELETE FROM alert_rules WHERE name IN
--     ('unreachable_confirmed','source_unreachable','network_unreachable');
--   DELETE FROM device_state WHERE dimension = 'reachability';
--   ALTER TABLE device_state MODIFY dimension
--     ENUM('ping','snmp','source_status','config_backup','recording','trunk') NOT NULL;
--   ALTER TABLE alert_rules MODIFY dimension
--     ENUM('ping','snmp','source_status','config_backup','recording','trunk') NOT NULL;
--   ALTER TABLE state_events MODIFY dimension
--     ENUM('ping','snmp','source_status','config_backup','recording','trunk') NOT NULL;
--   Safe: the dimension is derived from ping/source_status and is rebuilt on
--   the next pass, so nothing unique is lost.

-- Three tables carry this enum independently — device_state, alert_rules and
-- state_events. Extending fewer than all three fails at a different point each
-- time: alert_rules at the INSERT below, state_events not until a tier first
-- changes, which would have looked like an unrelated bug days later.
ALTER TABLE device_state
  MODIFY dimension ENUM('ping','snmp','source_status','config_backup',
                        'recording','trunk','reachability') NOT NULL;

ALTER TABLE alert_rules
  MODIFY dimension ENUM('ping','snmp','source_status','config_backup',
                        'recording','trunk','reachability') NOT NULL;

-- And state_events, which write_state() appends to on every transition. Missing
-- it means the first *change* of tier fails rather than the first write, so the
-- gap would have surfaced later and looked unrelated.
ALTER TABLE state_events
  MODIFY dimension ENUM('ping','snmp','source_status','config_backup',
                        'recording','trunk','reachability') NOT NULL;

-- Both probes agree. The device is unreachable — highest confidence, and the
-- only one of the three that justifies a dispatch on its own.
INSERT INTO alert_rules (name, dimension, device_types, `condition`, severity,
                         min_duration_s, enabled)
VALUES ('unreachable_confirmed', 'reachability', NULL,
        '{"op":"eq","value":"down_confirmed"}', 'crit', 300, 1);

-- The source platform cannot reach a device the network can. Warn, not crit:
-- the device is demonstrably up, so this is a platform-side problem and the
-- remedy differs.
INSERT INTO alert_rules (name, dimension, device_types, `condition`, severity,
                         min_duration_s, enabled)
VALUES ('source_unreachable', 'reachability', NULL,
        '{"op":"eq","value":"down_source_only"}', 'warn', 300, 1);

-- ICMP is silent while the source is content. Scoped away from cameras
-- deliberately: 195 of them never answer ICMP while Milestone reports them
-- recording (spec 19 §7), so for that class this fires on normal operation.
INSERT INTO alert_rules (name, dimension, device_types, `condition`, severity,
                         min_duration_s, enabled)
VALUES ('network_unreachable', 'reachability',
        'switch,ap,recording_server,trunk,pbx,other',
        '{"op":"eq","value":"down_network_only"}', 'warn', 300, 1);
