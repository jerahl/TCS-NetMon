-- 021: record which radio a wireless client is associated to.
--
-- ap_radios.clients has been NULL on all 1,574 rows since radios started
-- arriving, and deliberately so: XiqRadio.clients is an array of SSID
-- descriptors, not clients, so len() would have stamped a plausible-looking
-- fabrication onto every radio in the fleet (see build_radio_rows).
--
-- The real association is on the client side. GET /clients/active returns
-- interface_name ("wifi0.1"), whose interface half names the radio the client
-- is actually on. Storing the parsed radio name here lets the per-radio count
-- be derived at read time — the same rule ssids already follows, where counts
-- are computed from wireless_clients rather than stored and left to rot.
--
-- Nullable because it is genuinely absent for wired clients (radio_type = 3,
-- ~65% of rows) and for any payload that omits interface_name. NULL means "not
-- on a radio", which is a fact, not a gap.
--
-- rollback: ALTER TABLE wireless_clients DROP COLUMN radio;
--   Safe at any time. Nothing writes ap_radios.clients, and the AP Detail
--   radio table falls back to "—" exactly as it did before this migration.

ALTER TABLE wireless_clients
  ADD COLUMN radio VARCHAR(32) NULL AFTER device_id;

CREATE INDEX idx_wireless_clients_radio ON wireless_clients (device_id, radio);
