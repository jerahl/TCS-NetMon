-- 025: the camera's own device identity — firmware, serial, vendor.
--
-- `cameras.mac` has existed since 013 and has been NULL for the entire estate,
-- because the collector looked for the MAC on the camera and hardware objects
-- and neither carries one. The claim that "Milestone exposes no camera MAC"
-- was wrong: it lives one resource deeper, at
--
--     GET /api/rest/v1/hardware/{id}/hardwareDriverSettings
--
-- which returns macAddress, serialNumber, firmwareVersion, productID and
-- detectedModelName per hardware record. The Management Client shows the MAC
-- because it reads that resource; NetMon simply never asked for it.
--
-- The MAC matters well beyond inventory. Camera detail resolves a switch port
-- by joining a MAC against the FDB, and with no MAC of its own that join had to
-- be bridged through PacketFence's IP->MAC record — which covers 1,532 of 2,651
-- cameras and leaves the rest with no port at all. A first-party MAC removes
-- the bridge and the dependency on PacketFence having seen the endpoint.
--
-- The other three fields arrive in the same response. Storing them costs
-- nothing now and saves a second 2,489-request sweep later: D10's camera SNMP
-- work (spec 13) needs firmware to tell which profile applies, and serial is
-- the only stable identity for a camera that has been re-addressed.
--
-- These are per-*hardware* facts written onto every camera row that shares the
-- hardware, which is correct — the 61 multi-camera devices have one NIC, one
-- MAC and one firmware between them (migration 022).
--
-- `cameras.mac` is already indexed — 013 created idx_cameras_mac inline with the
-- table — so this migration adds no index. Adding one here failed with
-- "Duplicate key name" *after* the ALTER had committed, leaving the columns
-- present but the migration unrecorded.
--
-- rollback: ALTER TABLE cameras DROP COLUMN firmware, DROP COLUMN serial,
--             DROP COLUMN vendor;
--   Safe at any time. All three are descriptive facts re-derived by the
--   Milestone collector's backfill; nothing computes state from them.

ALTER TABLE cameras
  ADD COLUMN firmware VARCHAR(64) NULL AFTER model,
  ADD COLUMN serial VARCHAR(64) NULL AFTER firmware,
  ADD COLUMN vendor VARCHAR(64) NULL AFTER serial;
