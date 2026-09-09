-- 030: the platform a camera runs on, and the platform an image is built for.
--
-- Found the hard way on 2026-09-08, before any firmware was pushed. The image
-- the owner supplied is `CPP14_FW_9.80.0106.fw`; the nominated test camera,
-- alb-cam-44, answers RCP+ like this:
--
--   CONF_BLUR_ENABLED     0x0d26  CPP14/15/16 only   -> <err>0x40</err>
--   CONF_LICENSE_LOCK     0x0d1b  CPP13 and newer    -> <err>0x40</err>
--   CONF_CPU_LOAD_VCA     0x0a08  CPP6/CPP7/CPP7.3   -> 4
--
-- It is a CPP7.3-generation device on 7.83.0027. A CPP14 image would have met
-- "flash type incompatible" (upload error 112) at best. The model allow-list
-- would not have caught it: allow-lists are typed by people, and this is the
-- kind of mistake a person makes.
--
-- So the platform becomes a stored fact on both sides, and the runner probes it
-- live immediately before the upload as well. The model allow-list stays: it
-- answers "is this image for this product", while the platform answers "is this
-- image even for this silicon".
--
-- rollback: ALTER TABLE cameras DROP COLUMN platform;
--           ALTER TABLE firmware_images DROP COLUMN platform;
--           DELETE FROM schema_migrations WHERE version = '030';

-- Probed from the device (CPP6/7/7.3 | CPP13 | CPP14/15/16), NULL until asked.
ALTER TABLE cameras
  ADD COLUMN platform VARCHAR(16) NULL AFTER firmware;

-- Declared when the image is registered, from the vendor's own filename or
-- release notes. NULL means "not stated", which the runner treats as a refusal
-- for firmware rather than as permission.
ALTER TABLE firmware_images
  ADD COLUMN platform VARCHAR(16) NULL AFTER version;
