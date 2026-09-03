-- 022: record the physical device a camera belongs to, and its HTTP port.
--
-- Milestone models a camera as a channel of a *hardware* record, and on this
-- estate 61 hardware records carry more than one camera: 3 with two, 6 with
-- three, 51 with four, and one AXIS M3007 panoramic with eleven (channels
-- 0-10). One physical device, one IP, several cameras — not encoders.
--
-- NetMon could not see that. `devices.milestone_hardware_id` is the registry
-- *linkage* key and holds the camera GUID (0 of 2,659 are hardware ids), which
-- is correct for linking a camera row but means nothing records which physical
-- device a camera sits in. Without it:
--
--   * the poller's contested-address guard counts 11 camera rows sharing one
--     AXIS as 11 rival claimants and refuses every verdict, when they are one
--     device that is up or down as a unit;
--   * D10's SNMP unit cannot be the physical host, so the sweep would issue 11
--     identical walks against that one camera and store 11 copies of its CPU.
--
-- `hardware_id` is added to `cameras` rather than replacing the registry key,
-- because that key works and repurposing it would break entity linkage.
--
-- `http_port` carries the non-default port from the hardware address. Six of
-- 2,489 have one — five are `http://<ip>:443/` and one `:8080` — and the host
-- reduction that fills `cameras.ip` drops it. D7's snapshot proxy needs it, and
-- the :443-on-http case is exactly what a hand-built fixture would not contain.
-- NULL means the address carried no explicit port.
--
-- rollback: ALTER TABLE cameras DROP COLUMN hardware_id, DROP COLUMN http_port;
--   Safe at any time. Both are descriptive facts re-derived on the next
--   Milestone cycle; nothing reads them yet that cannot fall back.

ALTER TABLE cameras
  ADD COLUMN hardware_id VARCHAR(64) NULL AFTER device_id,
  ADD COLUMN http_port SMALLINT UNSIGNED NULL AFTER ip;

CREATE INDEX idx_cameras_hardware ON cameras (hardware_id);
