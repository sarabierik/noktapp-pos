-- ---------------------------------------------------------------------------
-- FİŞTE DÖVİZ KARŞILIĞI VE KAREKOD
--
-- Two things the owner of a tourist-area restaurant said were missing from the
-- printed and e-mailed bill: "no doviz in fis" and "no qr code".
--
-- NEITHER OF THEM NEEDS A NEW TABLE, and that is the point of this file.
--
--   * the rates already have one. doviz_kurlari holds the rate, its age and
--     who set it, doviz_kur_gecmisi holds every change, and the Ayarlar →
--     Döviz screen already refuses a suspicious jump. A second rate store for
--     the receipt would mean the bill and that screen could print different
--     euros for the same lira, which is the exact class of bug print/
--     document.js exists to prevent. So the bill reads those tables.
--   * the choices are np_settings rows with typed definitions in
--     modules/receipt.js: which currencies, how old a rate may be before its
--     date is printed beside it, and what the karekod carries.
--
-- What IS here is data, not structure:
--
--   1. the three currencies are seeded for every client that has none, so the
--      Fiş ekranı offers a list instead of an empty box on first open. This is
--      the same seed modules/settings.currencies() does lazily; doing it here
--      means the list is there before anybody visits the Döviz screen.
--   2. receipt_qr_mode is back-filled for a till that was ALREADY printing a
--      karekod through the old receipt_qr + receipt_qr_text pair. Without this
--      row the code derives the same answer at runtime and the paper does not
--      change either way - but a stored choice can be seen, and an install
--      that prints a QR should say so in its settings rather than in an
--      inference.
--
-- Nothing here turns anything ON. A till whose owner wants neither gets a
-- receipt byte for byte identical to the one it printed yesterday: both
-- features default to off, and test/receipt.js asserts exactly that against
-- bytes captured before the change.
--
-- Safe to re-run: the desktop shell replays every migration on each start.
-- ---------------------------------------------------------------------------
SET NAMES utf8mb4;

-- 1. EUR / USD / GBP for every client that has no currency row at all.
--    rate 0 and rate_updated_at NULL mean "no rate has been entered", and the
--    bill prints nothing for a currency in that state - a zero is not a rate.
INSERT IGNORE INTO `doviz_kurlari`
  (`client_id`, `code`, `name`, `symbol`, `rate`, `is_active`, `sort_order`, `rate_updated_at`, `created_at`)
SELECT c.`id`, s.`code`, s.`name`, s.`symbol`, 0, 1, s.`sort_order`, NULL, NOW()
  FROM `clients` c
  JOIN (SELECT 'EUR' AS `code`, 'Euro'              AS `name`, '€' AS `symbol`, 1 AS `sort_order`
        UNION ALL SELECT 'USD', 'Amerikan Doları', '$', 2
        UNION ALL SELECT 'GBP', 'İngiliz Sterlini', '£', 3) s
 WHERE NOT EXISTS (SELECT 1 FROM `doviz_kurlari` d WHERE d.`client_id` = c.`id`);

-- 2. A till already printing a karekod off the old pair says so out loud.
--    "serbest" is what that pair meant: a free-text content the owner typed.
INSERT IGNORE INTO `np_settings` (`k`, `v`)
SELECT 'receipt_qr_mode', 'serbest'
  FROM DUAL
 WHERE (SELECT `v` FROM `np_settings` WHERE `k`='receipt_qr') IN ('1','true','on')
   AND COALESCE((SELECT TRIM(`v`) FROM `np_settings` WHERE `k`='receipt_qr_text'), '') <> '';
