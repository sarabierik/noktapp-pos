-- ---------------------------------------------------------------------------
-- Adisyon notu ve mutfak notu  (2026-09-20)
--
-- `orders.notes` zaten vardi ve kimse yazmiyordu. Iki ayri not gerekiyor,
-- cunku ikisi ayri yerlere basilir:
--
--   notes         - adisyonun notu. "Pasta 21:30", "fatura istiyor".
--                   HEM hesap fisinde HEM mutfak fisinde gorunur; misafirin
--                   kendi notudur.
--   kitchen_note  - YALNIZCA mutfak fisinde. "acele", "cocuk icin once
--                   ciksin", "sef bilsin". Misafirin hesabinda asla gorunmez.
--
-- Safe to re-run: the migration runner replays every file on every boot.
-- ---------------------------------------------------------------------------

ALTER TABLE `orders`
  ADD COLUMN IF NOT EXISTS `kitchen_note` varchar(255) DEFAULT NULL
    COMMENT 'Yalnizca mutfak fisine basilir - hesap fisinde gorunmez' AFTER `notes`,
  ADD COLUMN IF NOT EXISTS `notes_at` datetime DEFAULT NULL AFTER `kitchen_note`,
  ADD COLUMN IF NOT EXISTS `notes_by` int(11) DEFAULT NULL AFTER `notes_at`;
