-- =====================================================================
--  NOKTApp POS - BAYI (reseller) schema
--
--  WHAT: who sold a customer, and the credentials that let them in
--  through their own door at /bayi/.
--
--  WHY a reseller is not an admin with a filter:
--  np_resellers.password_hash exists because the reseller signs in at a
--  SEPARATE door. The panel's own admin table is not reused and no
--  "role" column is added to it, because a role column means one code
--  path serves both audiences and one forgotten WHERE leaks a rival
--  reseller's customer list. Two doors, two tables, two session
--  cookies: the boundary is structural rather than conditional.
--
--  np_tenants.reseller_id is nullable and has no foreign key. A customer
--  sold directly by the vendor has no reseller, and deleting a reseller
--  must never take their customers with them - the customers are the
--  vendor's, the reseller is only who introduced them. Clearing the
--  column is the correct consequence and is done in code.
--
--  commission_pct is a percentage of the NET (KDV haric) figure of an
--  invoice the customer has actually PAID. KDV is the state's money and
--  was never the vendor's to share; an uncollected invoice is not
--  income and cannot be commission. Both rules are printed on the
--  reseller screens so the number is never a mystery.
--
--  Guarded throughout, so admin/guncelle.php can apply it to a live
--  panel and applying it twice is harmless.
-- =====================================================================
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `np_resellers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(32) NOT NULL,
  `name` varchar(255) NOT NULL,
  `contact` varchar(255) DEFAULT NULL,
  `email` varchar(190) NOT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `city` varchar(80) DEFAULT NULL,
  -- Percentage, 0.00-100.00. DECIMAL and not FLOAT: it multiplies money.
  `commission_pct` decimal(5,2) NOT NULL DEFAULT 0.00,
  `password_hash` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `notes` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `last_login_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reseller_code` (`code`),
  UNIQUE KEY `uq_reseller_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE `np_tenants` ADD COLUMN IF NOT EXISTS `reseller_id` int(11) DEFAULT NULL;
ALTER TABLE `np_tenants` ADD KEY IF NOT EXISTS `ix_reseller` (`reseller_id`);
