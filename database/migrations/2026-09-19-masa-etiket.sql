-- ---------------------------------------------------------------------------
-- Masa etiketi  (2026-09-19)
--
-- Masanin adi sabittir: "MS101", "Teras 3". Salonda konusulan sey ise bu
-- degildir - "Ahmet Bey'in masasi", "dogum gunu olan masa", "rezerve 20:30".
-- Garson bunu telefonundan yazabilsin, diger butun telefonlarda ve kasada
-- ayni anda gorunsun diye masanin kendisinde duruyor.
--
-- etiket_kalici:
--   0 (varsayilan) - masa bosalinca etiket silinir. Musteri adi boyledir;
--                    ertesi gun baska biri oturur ve eski ad orada kalmamali.
--   1              - kalici. "VIP", "Sigara icilir", "Deniz manzarali" gibi
--                    masanin kendi ozelligi olan etiketler icin.
--
-- Safe to re-run: the migration runner replays every file on every boot.
-- ---------------------------------------------------------------------------

ALTER TABLE `restaurant_tables`
  ADD COLUMN IF NOT EXISTS `etiket` varchar(60) DEFAULT NULL
    COMMENT 'Masanin uzerinde gorunen serbest etiket - musteri adi, not' AFTER `name`,
  ADD COLUMN IF NOT EXISTS `etiket_kalici` tinyint(1) NOT NULL DEFAULT 0
    COMMENT '1 ise masa bosalinca silinmez (VIP, Rezerve gibi)' AFTER `etiket`,
  ADD COLUMN IF NOT EXISTS `etiket_at` datetime DEFAULT NULL AFTER `etiket_kalici`,
  ADD COLUMN IF NOT EXISTS `etiket_by` int(11) DEFAULT NULL AFTER `etiket_at`;
