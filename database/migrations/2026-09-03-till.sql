-- ---------------------------------------------------------------------------
-- KASA / VARDIYA - the two things the drawer could never answer.
--
-- `pos_shifts` and `pos_shift_movements` already carry the shift ledger and are
-- not touched here. What was missing was everything AROUND the ledger:
--
--   * "who opened the drawer and why" had no answer at all. The till fires the
--     kick pulse straight at the printer (print/index.js openDrawer), which
--     leaves no trace anywhere. An open drawer with no sale behind it is the
--     oldest theft signal in hospitality and the one number the owner asks for
--     first; without a row it cannot be counted, let alone compared between
--     cashiers.
--   * a shift was closed by TYPING a number. `counted_cash_minor` recorded the
--     claim but not the count, so "the drawer was 340 short" could never be
--     re-checked - nobody knew whether the cashier miscounted the 200s or the
--     money was gone. Storing the denomination breakdown makes a count
--     auditable after the fact, and makes the arithmetic the server's job
--     rather than the cashier's.
--
-- Re-running this file is harmless: both statements are IF NOT EXISTS, which is
-- what the desktop shell relies on when it replays every migration on boot.
-- ---------------------------------------------------------------------------

-- Every kick of the cash drawer, sale or no sale.
--
-- `order_id` is the whole point of the table: a row with an order behind it is
-- a cashier taking change, a row with NULL is somebody opening the drawer for
-- a reason only they know. Keeping both in one table means the ratio is a
-- single GROUP BY rather than a comparison between two places.
CREATE TABLE IF NOT EXISTS `pos_drawer_events` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `shift_id` bigint(20) unsigned DEFAULT NULL COMMENT 'acik vardiya - kapali kasada da acilabilir, o yuzden NULL serbest',
  `order_id` int(11) DEFAULT NULL COMMENT 'NULL = satissiz acilis, incelenmesi gereken satir',
  `source` varchar(16) NOT NULL DEFAULT 'manual' COMMENT 'manual|sale',
  `reason` varchar(190) DEFAULT NULL,
  `user_id` int(11) DEFAULT NULL,
  `user_name` varchar(120) DEFAULT NULL COMMENT 'o andaki ad - kullanici sonradan silinse de kayit okunur kalsin',
  `ip` varchar(64) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_drawer_client` (`client_id`,`created_at`),
  KEY `idx_drawer_shift` (`client_id`,`shift_id`),
  KEY `idx_drawer_user` (`client_id`,`user_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

-- A physical count of the drawer, note by note.
--
-- `total_minor` is stored as well as the breakdown even though one is derived
-- from the other: the breakdown is evidence, the total is the figure the close
-- used, and a later change to the denomination list must not silently restate
-- an old count.
CREATE TABLE IF NOT EXISTS `pos_cash_counts` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `shift_id` bigint(20) unsigned NOT NULL,
  `count_uid` char(36) NOT NULL COMMENT 'client-minted, ayni sayim iki kez islenmesin',
  `kind` varchar(12) NOT NULL DEFAULT 'close' COMMENT 'close|ara',
  `total_minor` bigint(20) NOT NULL DEFAULT 0,
  `expected_minor` bigint(20) DEFAULT NULL COMMENT 'sayim anindaki beklenen tutar',
  `variance_minor` bigint(20) DEFAULT NULL COMMENT 'sayilan - beklenen',
  `breakdown_json` longtext DEFAULT NULL COMMENT '[{minor,count}] - kupur dokumu',
  `counted_by` int(11) DEFAULT NULL,
  `counted_by_name` varchar(120) DEFAULT NULL,
  `note` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cash_count_uid` (`client_id`,`count_uid`),
  KEY `idx_cash_count_shift` (`client_id`,`shift_id`,`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;
