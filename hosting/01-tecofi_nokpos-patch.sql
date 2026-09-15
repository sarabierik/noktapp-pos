-- =====================================================================
--  PATCH FOR THE LIVE DATABASE:  tecofi_nokpos
--  phpMyAdmin -> select tecofi_nokpos in the left sidebar -> SQL -> paste
--  -> Go.  (Your phpMyAdmin ignores a "USE ..." line, so the database has
--  to be selected in the sidebar, not named in the query.)
--
--  ONE new table. Nothing dropped, nothing renamed, no column changed, no
--  row touched. Safe to run twice.
--
--  I checked your dump: every index this needed already exists on your
--  live tables, so there is nothing else to add. This is the whole patch.
--
--  WHY IT MATTERS TODAY, with no desktop app involved.
--  Your own pos/loyalty/lib.php says it:
--
--      "recalcTotals() ... reads SELECT SUM(discount_value) FROM
--       order_discounts inside a try/catch. That table has never existed,
--       so the catch fired, $discount became 0, and the very next line
--       wrote discount_total = 0 - erasing any discount held directly on
--       the order. That is why a redeemed reward left the bill unchanged."
--
--  On the live web POS right now, a guest is told "bir kahve bizden" and
--  then pays for the coffee. Creating this table is the fix.
-- =====================================================================

CREATE TABLE IF NOT EXISTS `order_discounts` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `order_id` int(11) NOT NULL,
  `discount_value` decimal(10,2) NOT NULL DEFAULT 0.00,
  `reason` varchar(190) DEFAULT NULL,
  `source` varchar(20) NOT NULL DEFAULT 'manual',
  `ref_id` int(11) DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_od_order` (`client_id`,`order_id`),
  KEY `idx_od_source` (`client_id`,`source`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Should return one row containing 0. That is the whole check.
SELECT COUNT(*) AS satir_sayisi FROM `order_discounts`;
