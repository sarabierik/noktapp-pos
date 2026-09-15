-- ---------------------------------------------------------------------------
-- KAT PLANI - alanlar, masalar, rezervasyonlar, karekodlar.
--
-- Three holes the old system left, all of them in columns rather than tables:
--
--   * a table had no seat count. The floor plan could not answer "will six
--     people fit on masa 4", and a reservation for six was seated by eye.
--   * a reservation had nowhere to record WHO seated it or when, so a booking
--     that turned into a bill lost the person who made that decision - the one
--     fact you want when a guest says they were never seated.
--   * `restaurant_tables.qr_token` existed but nothing recorded when a card was
--     reprinted. Regenerating a token silently kills every printed card on that
--     table; "when did that happen" was unanswerable.
--
-- Re-running this is harmless: every statement is guarded, and MariaDB's
-- IF NOT EXISTS on ADD COLUMN makes a second run a no-op rather than an error.
-- ---------------------------------------------------------------------------

-- Seat capacity. NULL is honest ("nobody has said"), 0 would be a lie that
-- sorts and sums as if the table seated nobody.
ALTER TABLE `restaurant_tables`
  ADD COLUMN IF NOT EXISTS `seats` smallint(5) unsigned DEFAULT NULL
  COMMENT 'kac kisilik - rezervasyon uyarisi bunun uzerinden calisir';

-- When the QR card was last regenerated, so "the printed cards stopped working
-- last Tuesday" has an answer.
ALTER TABLE `restaurant_tables`
  ADD COLUMN IF NOT EXISTS `qr_token_at` datetime DEFAULT NULL
  COMMENT 'karekod jetonunun uretildigi an';

-- The floor plan is ordered by sort_order; without an index it is a filesort on
-- every load of the busiest screen in the product.
ALTER TABLE `restaurant_tables`
  ADD KEY IF NOT EXISTS `idx_table_zone_order` (`client_id`,`zone_id`,`sort_order`);

-- Rezervasyonlar. Present on every live install, created here so a fresh
-- machine (and the test suite) has it without hunting through the core dump.
CREATE TABLE IF NOT EXISTS `reservations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `table_id` int(10) unsigned DEFAULT NULL,
  `guest_name` varchar(120) NOT NULL,
  `guest_phone` varchar(40) DEFAULT NULL,
  `party_size` int(11) NOT NULL DEFAULT 2,
  `starts_at` datetime NOT NULL,
  `duration_min` int(11) NOT NULL DEFAULT 120,
  `status` enum('booked','seated','done','cancelled','noshow') NOT NULL DEFAULT 'booked',
  `note` varchar(255) DEFAULT NULL,
  `order_id` int(10) unsigned DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_res_client_time` (`client_id`,`starts_at`),
  KEY `idx_res_client_table` (`client_id`,`table_id`,`starts_at`),
  KEY `idx_res_status` (`client_id`,`status`,`starts_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The PHP hard-coded duration_min to 120 and never recorded who seated the
-- guest. Both are needed the moment two people work the same shift.
ALTER TABLE `reservations`
  ADD COLUMN IF NOT EXISTS `seated_at` datetime DEFAULT NULL
  COMMENT 'misafirin masaya oturtuldugu an',
  ADD COLUMN IF NOT EXISTS `seated_by` int(11) DEFAULT NULL
  COMMENT 'oturtan personel (users.id)';
