-- ---------------------------------------------------------------------
-- ÖKC: the device's own configuration, as the device actually holds it.
--
-- Written from the settings screens of a real Ingenico MOVE 5000F (YNÖKC)
-- installed in a working restaurant. Before this, the till carried none of it
-- and guessed the parts it needed - most dangerously the VAT department, with
-- a hard-coded rate->department table in code. On a fiscal device that is not
-- a cosmetic bug: the department decides the VAT printed on a legal receipt.
--
-- Two facts drive the shape below, and both come from the device:
--
--   * The VAT table and the department (kısım) table live ON the device, and
--     the POS pushes them down - "Cihaz üzerinde bulunan kısım tanımları
--     buradaki tanımlar ile güncellenir". So they are per-device rows here,
--     not constants in code.
--
--   * The device's department index is 0-BASED while the ERP's is 1-based.
--     Both are stored, so nothing has to remember to add or subtract one.
--
-- Safe to re-run.
-- ---------------------------------------------------------------------

ALTER TABLE `fiscal_devices`
  ADD COLUMN IF NOT EXISTS `receipt_limit_minor` int(10) UNSIGNED NOT NULL DEFAULT 1200000
    COMMENT 'Fis limiti - device refuses a receipt above this (12000,00 default)',
  ADD COLUMN IF NOT EXISTS `max_sale_lines` smallint(5) UNSIGNED NOT NULL DEFAULT 40
    COMMENT 'Satis paket limiti - lines the device accepts in one sale packet',
  ADD COLUMN IF NOT EXISTS `cashier_no` smallint(5) UNSIGNED NOT NULL DEFAULT 1
    COMMENT 'Kasiyer ID on the device',
  ADD COLUMN IF NOT EXISTS `open_drawer` tinyint(1) NOT NULL DEFAULT 0
    COMMENT 'Cekmece acma - 0 = Cekmeceyi Acma',
  ADD COLUMN IF NOT EXISTS `serial_port` varchar(16) DEFAULT NULL
    COMMENT 'COM port when connection_type is SERIAL',
  ADD COLUMN IF NOT EXISTS `wire_verified` tinyint(1) NOT NULL DEFAULT 0
    COMMENT 'Set only when the message layer has been proven against the manufacturer document';

-- The VAT code table the device holds. `vat_code` is what travels in a sale
-- line; the rate is what the device prints. Codes 0-7 on the Ingenico.
CREATE TABLE IF NOT EXISTS `fiscal_vat_codes` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `fiscal_device_id` int(10) UNSIGNED NOT NULL,
  `vat_code` tinyint(3) UNSIGNED NOT NULL,
  `rate` decimal(5,2) NOT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vat` (`fiscal_device_id`,`vat_code`),
  KEY `ix_client` (`client_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The department (kısım) table the device holds.
CREATE TABLE IF NOT EXISTS `fiscal_departments` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `fiscal_device_id` int(10) UNSIGNED NOT NULL,
  `erp_index` smallint(5) UNSIGNED NOT NULL COMMENT '1-based, what the till calls it',
  `okc_index` smallint(5) UNSIGNED NOT NULL COMMENT '0-based, what the device calls it',
  `name` varchar(40) NOT NULL,
  `vat_code` tinyint(3) UNSIGNED NOT NULL,
  `unit_price_minor` int(10) UNSIGNED DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dep` (`fiscal_device_id`,`erp_index`),
  KEY `ix_client` (`client_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
