-- ---------------------------------------------------------------------
-- HUGIN PC Link — the columns the real protocol needs.
--
-- Written against developer.hugin.com.tr (PC Link, API v1), read 2026-09-21:
-- Genel Bakış, Ortam Bilgisi, Kimlik Doğrulama, and the Cloud Link overview.
-- This replaces a GUESSED socket protocol (port 7500, invented command names)
-- with the manufacturer's documented one: HTTPS REST on port 4443.
--
-- Authentication is three headers on every request, and all three have to be
-- stored per device because the device rejects the request if any one of them
-- differs from what it paired with:
--
--   X-SoftwareId   the integrator's VKN, from the Hugin integration contract
--   X-HardwareId   a value unique to THIS PC (Hugin recommends its MAC)
--   X-SerialNo     the device's mali sicil no, learned at pairing
--
-- Safe to re-run.
-- ---------------------------------------------------------------------

ALTER TABLE `fiscal_devices`
  ADD COLUMN IF NOT EXISTS `pclink_software_id` varchar(32) DEFAULT NULL
    COMMENT 'X-SoftwareId - entegrasyon sozlesmesindeki VKN. Cihaza da bu girilir',
  ADD COLUMN IF NOT EXISTS `pclink_hardware_id` varchar(64) DEFAULT NULL
    COMMENT 'X-HardwareId - bu PC icin tekil deger (MAC). Degisirse eslesme duser',
  ADD COLUMN IF NOT EXISTS `pclink_paired_at` datetime DEFAULT NULL
    COMMENT 'GET /v1/settings ile eslesmenin tamamlandigi an',
  ADD COLUMN IF NOT EXISTS `pclink_sfa_version` varchar(32) DEFAULT NULL
    COMMENT 'Cihazin metadata.sfaVersion degeri - yetenek kanitinin baglami',

  -- The pinned certificate. This is the security control, not a nicety.
  --
  -- The device presents an ÖKC certificate whose Subject carries the MALI
  -- SICIL NO instead of an FQDN, so ordinary TLS hostname verification cannot
  -- succeed - Hugin's own examples use `curl -k`. Copying `-k` into the till
  -- would mean accepting ANY certificate on the restaurant's wifi, which is
  -- exactly the network where somebody else's laptop is sitting.
  --
  -- So: the first pairing records the certificate's SHA-256 fingerprint, and
  -- every later request checks the device still presents that same
  -- certificate. Verification by pinning rather than by hostname - the same
  -- guarantee, obtained the only way this certificate allows.
  ADD COLUMN IF NOT EXISTS `pclink_cert_sha256` char(95) DEFAULT NULL
    COMMENT 'Eslesme aninda goturulen sertifikanin SHA-256 parmak izi (AA:BB:.. formatinda)',
  ADD COLUMN IF NOT EXISTS `pclink_cert_subject` varchar(255) DEFAULT NULL
    COMMENT 'Sertifikanin Subject alani - icinde mali sicil no gecer';

-- The default port for a Hugin device is 4443, not 7500. Only rows that still
-- carry the old guessed port are touched, and only when nobody has overridden
-- it with something else.
UPDATE `fiscal_devices`
   SET `device_port` = 4443
 WHERE `provider` IN ('hugin', 'profilo')
   AND (`device_port` IS NULL OR `device_port` = 7500);
