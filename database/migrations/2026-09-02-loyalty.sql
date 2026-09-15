-- =====================================================================
--  NOKTApp POS - LOYALTY (SADAKAT) SUPPORT
--
--  The loyalty_* tables already come from the production dump. What was
--  missing is the discount ledger the reward redemption writes into.
--
--  Why it matters: the order engine recomputes discount_total from this
--  ledger. Without the table the recompute silently wrote 0, so a redeemed
--  reward came off the bill and the next item change put it straight back.
--  The customer was told "free coffee" and still paid for the coffee.
--
--  Safe to re-run.
-- =====================================================================
SET NAMES utf8mb4;

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

-- Indexes that make the counter lookups instant once a restaurant has a few
-- thousand guests. Added only when missing, because the installer re-runs this
-- file on every start and a plain ALTER would fail the second time.
DROP PROCEDURE IF EXISTS np_add_index;
DELIMITER $$
CREATE PROCEDURE np_add_index(IN p_table VARCHAR(64), IN p_name VARCHAR(64), IN p_cols VARCHAR(255), IN p_unique TINYINT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics
                  WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_name) THEN
    SET @s = CONCAT('ALTER TABLE `', p_table, '` ADD ', IF(p_unique, 'UNIQUE ', ''),
                    'KEY `', p_name, '` (', p_cols, ')');
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END$$
DELIMITER ;

CALL np_add_index('customers',      'ix_phone',      '`phone`', 0);
CALL np_add_index('customers',      'ix_qr_uid',     '`qr_uid`', 0);
CALL np_add_index('loyalty_events', 'ix_order_kind', '`client_id`,`order_id`,`kind`', 0);
CALL np_add_index('loyalty_cards',  'uq_card',       '`client_id`,`customer_id`,`program_id`', 1);
CALL np_add_index('loyalty_qr_tokens', 'ix_customer', '`customer_id`,`used_at`', 0);

DROP PROCEDURE IF EXISTS np_add_index;
