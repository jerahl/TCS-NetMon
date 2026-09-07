-- 027: the facts the Surveillance header, overview and recorder table need
-- (spec 20 S2), plus the two camera fields the snapshot proxy will need (D7).
--
-- All read from Config-API responses the collector already fetches, or from the
-- Events/State subscription it already opens. Confirmed live 2026-09-07.
--
-- CAMERAS
--
--   channel        /cameras carries it on every record. Milestone models a
--                  multi-imager device as several cameras on one hardware, and
--                  the channel is which imager. D7's snapshot path needs it:
--                  for the ~241 cameras that are channels on a shared encoder a
--                  bare /snap.jpg returns the WRONG imager (spec 11 D7).
--   https_enabled  hardwareDriverSettings.httpSEnabled — and it is the STRING
--   https_port     'Yes'/'No', not a boolean, so a truthiness test on the raw
--                  value would call every camera TLS-enabled. httpSPort is a
--                  real int (443 on the record probed). Milestone stores every
--                  hardware address as http://, so the scheme has to come from
--                  these two rather than from the address — the correction spec
--                  11 D7 recorded and the reason a hand-built fixture would
--                  not have caught it.
--
-- RECORDING SERVERS — four state verdicts from the Events/State interface.
--
-- The subscription asked for `resourceTypes: ["cameras"]`, so recording-server
-- states were never delivered and RS status came from the Config API's
-- `running` flag. Adding recordingServers to the same filter (still the three
-- approved read-only verbs — D5) yields 152 states across all 22 recorders:
--
--   Communication Started      22   -> comm_state      (drives source_status)
--   CPU Usage Normal           22   -> cpu_state
--   Retention time Normal      21   -> retention_state
--   Retention time Warning      1        (one recorder is warning, unseen until now)
--   Service Available Critical 11   -> service_state
--   Service Available Normal   11
--
-- These are stored as the resolved state NAME, not a severity, because the
-- names are the vocabulary the VMS uses and collapsing them into ok/warn/crit
-- would decide something this migration should not. Only Communication drives
-- `device_state`; the other three are descriptive columns for the recorder
-- table. Deliberate: half the estate reads "Service Available Critical" with a
-- timestamp four months old, which looks far more like a state group that was
-- never cleared than like eleven simultaneous outages — and turning that into
-- eleven alerts would repeat the storm spec 19 §12 spent a day undoing.
--
-- `states_at` is the newest state timestamp for that recorder, so the UI can
-- age the whole set honestly instead of implying it is current.
--
-- rollback: ALTER TABLE cameras DROP COLUMN channel, DROP COLUMN https_enabled,
--             DROP COLUMN https_port;
--           ALTER TABLE recording_servers DROP COLUMN comm_state,
--             DROP COLUMN cpu_state, DROP COLUMN retention_state,
--             DROP COLUMN service_state, DROP COLUMN states_at;
--   Safe at any time. Every column is a descriptive fact re-derived on the next
--   collector cycle; nothing computes device state from them except
--   `comm_state`, whose absence returns RS status to the Config API flag it
--   used before.

ALTER TABLE cameras
  ADD COLUMN channel SMALLINT UNSIGNED NULL AFTER hardware_id,
  ADD COLUMN https_enabled TINYINT(1) NULL AFTER http_port,
  ADD COLUMN https_port SMALLINT UNSIGNED NULL AFTER https_enabled;

ALTER TABLE recording_servers
  ADD COLUMN comm_state VARCHAR(64) NULL AFTER version,
  ADD COLUMN cpu_state VARCHAR(64) NULL AFTER comm_state,
  ADD COLUMN retention_state VARCHAR(64) NULL AFTER cpu_state,
  ADD COLUMN service_state VARCHAR(64) NULL AFTER retention_state,
  ADD COLUMN states_at TIMESTAMP NULL AFTER service_state;
