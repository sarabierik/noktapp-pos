-- ---------------------------------------------------------------------------
-- QR eslestirme  (2026-09-18)
--
-- Telefonu baglamak icin alti haneli kodu yazmak yerine kasadaki karekodu
-- okutmak. Iki ayri sir tutuluyor:
--
--   pair_code  - alti hane, EKRANDA gorunur, elle yazilir. Kisa oldugu icin
--                eskisi gibi kullanici adi + sifre ile birlikte calisir.
--   qr_token   - 32 hane, YALNIZCA karekodun icinde. Okutuldugunda sifre
--                sorulmaz; cunku kodu ureten zaten "hangi personel" secmistir
--                ve bu token tahmin edilemez.
--
-- for_user_id  - kod hangi personel icin uretildi. NULL ise telefon eskisi
--                gibi kullanici adi ve sifre soracak.
-- ---------------------------------------------------------------------------

-- Safe to re-run: a fresh install already has these from 02_schema_local.sql,
-- and the migration runner replays every file on every boot.

ALTER TABLE `np_mobile_pairings`
  ADD COLUMN IF NOT EXISTS `qr_token` char(32) DEFAULT NULL
    COMMENT 'Yalnizca karekodun icinde bulunur - sifresiz eslestirme jetonu' AFTER `pair_code`,
  ADD COLUMN IF NOT EXISTS `for_user_id` int(11) DEFAULT NULL
    COMMENT 'Kod hangi personel icin uretildi. NULL = telefon kullanici adi ve sifre soracak' AFTER `user_id`,
  ADD COLUMN IF NOT EXISTS `redeemed_by` varchar(8) DEFAULT NULL
    COMMENT 'kod | qr - hangi kapidan girildi' AFTER `used_at`,
  ADD UNIQUE KEY IF NOT EXISTS `uq_qr_token` (`qr_token`);
