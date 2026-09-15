-- ---------------------------------------------------------------------
-- Settings / administration module
--
-- One table only. Every switch the owner can flip already has a home in
-- np_settings (k/v), and the company block lives on `clients` /
-- `business_settings` where the receipt printer already reads it - moving
-- either would have been a schema change for a cosmetic tidy-up.
--
-- What was genuinely missing is the answer to "who turned that off?".
-- The old PHP kept a history for exchange rates (doviz_kur_gecmisi) and for
-- nothing else, so when the kitchen printer stopped auto-sending, or the
-- backup hour moved, nobody could say when or by whom. This is that history,
-- and it is the same shape as doviz_kur_gecmisi on purpose.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `np_settings_log` (
  `id`         int(10) unsigned NOT NULL AUTO_INCREMENT,
  `client_id`  int(11)      NOT NULL DEFAULT 0,
  `k`          varchar(64)  NOT NULL,
  `old_value`  varchar(500) DEFAULT NULL COMMENT 'NULL = anahtar ilk kez yazildi',
  `new_value`  varchar(500) DEFAULT NULL COMMENT 'gizli anahtarlarda *** yazilir',
  `changed_by` int(11)      DEFAULT NULL COMMENT 'users.id',
  `created_at` datetime     NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `ix_setlog_key` (`k`,`id`),
  KEY `ix_setlog_client` (`client_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
