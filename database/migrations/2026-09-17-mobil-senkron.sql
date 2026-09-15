-- ---------------------------------------------------------------------------
-- MOBİL SENKRON — the handheld keeps its own copy, and pulls only what changed.
--
-- `app_change_log` already existed and was already being written by triggers on
-- orders, order_items, products and payments. It is a monotonic id per change,
-- which is exactly the cursor a delta sync needs - so the phone does not need a
-- new mechanism, it needs the log to be COMPLETE.
--
-- Missing were the three things a waiter's screen is made of: the categories,
-- the floor, and a product that is deleted rather than deactivated. Without
-- them a phone that had pulled once would never learn that a category was
-- renamed or a table was taken out of service, and would go on showing a floor
-- plan the restaurant no longer has.
-- ---------------------------------------------------------------------------

ALTER TABLE `app_change_log`
  ADD INDEX IF NOT EXISTS `ix_change_client_id` (`client_id`, `id`);

DELIMITER $$

-- ------------------------------------------------------------- categories
DROP TRIGGER IF EXISTS `trg_categories_ai`$$
CREATE TRIGGER `trg_categories_ai` AFTER INSERT ON `categories` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (NEW.client_id, 'category', NEW.id, NULL, 'ins');
END$$

DROP TRIGGER IF EXISTS `trg_categories_au`$$
CREATE TRIGGER `trg_categories_au` AFTER UPDATE ON `categories` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (NEW.client_id, 'category', NEW.id, NULL, 'upd');
END$$

DROP TRIGGER IF EXISTS `trg_categories_ad`$$
CREATE TRIGGER `trg_categories_ad` AFTER DELETE ON `categories` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (OLD.client_id, 'category', OLD.id, NULL, 'del');
END$$

-- ----------------------------------------------------------------- floor
DROP TRIGGER IF EXISTS `trg_tables_ai`$$
CREATE TRIGGER `trg_tables_ai` AFTER INSERT ON `restaurant_tables` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (NEW.client_id, 'table', NEW.id, NULL, 'ins');
END$$

DROP TRIGGER IF EXISTS `trg_tables_au`$$
CREATE TRIGGER `trg_tables_au` AFTER UPDATE ON `restaurant_tables` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (NEW.client_id, 'table', NEW.id, NULL, 'upd');
END$$

DROP TRIGGER IF EXISTS `trg_tables_ad`$$
CREATE TRIGGER `trg_tables_ad` AFTER DELETE ON `restaurant_tables` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (OLD.client_id, 'table', OLD.id, NULL, 'del');
END$$

DROP TRIGGER IF EXISTS `trg_zones_ai`$$
CREATE TRIGGER `trg_zones_ai` AFTER INSERT ON `table_zones` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (NEW.client_id, 'zone', NEW.id, NULL, 'ins');
END$$

DROP TRIGGER IF EXISTS `trg_zones_au`$$
CREATE TRIGGER `trg_zones_au` AFTER UPDATE ON `table_zones` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (NEW.client_id, 'zone', NEW.id, NULL, 'upd');
END$$

DROP TRIGGER IF EXISTS `trg_zones_ad`$$
CREATE TRIGGER `trg_zones_ad` AFTER DELETE ON `table_zones` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (OLD.client_id, 'zone', OLD.id, NULL, 'del');
END$$

-- A product that is really deleted, not just deactivated. The insert and
-- update triggers were already here; without this one a handheld kept selling
-- something the menu no longer has.
DROP TRIGGER IF EXISTS `trg_products_ad`$$
CREATE TRIGGER `trg_products_ad` AFTER DELETE ON `products` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (OLD.client_id, 'product', OLD.id, NULL, 'del');
END$$

DELIMITER ;

-- Where each device has got to. Kept on the till rather than only on the
-- phone, so "this handset is three hours behind" is answerable from the
-- Telefonlar screen instead of from the waiter's memory.
CREATE TABLE IF NOT EXISTS `app_sync_cursors` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `device_id` varchar(64) NOT NULL,
  `cursor_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `full_at` datetime DEFAULT NULL,
  `pulled_at` datetime DEFAULT NULL,
  `rows_sent` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sync_cursor` (`client_id`, `device_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
