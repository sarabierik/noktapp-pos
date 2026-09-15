-- =====================================================================
--  NOKTApp POS - LOCAL DATABASE SCHEMA  (runs on the restaurant's own PC)
--  Generated from tecofi_nokpos.sql (pos.noktapp.com production dump)
--  Engine: bundled MariaDB 10.11 - database name: noktapp_pos
-- =====================================================================
SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `agent_pair_attempts`;
CREATE TABLE `agent_pair_attempts` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `ip` varchar(45) NOT NULL,
  `ok` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `app_change_log`;
CREATE TABLE `app_change_log` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `entity` varchar(32) NOT NULL,
  `entity_id` bigint(20) NOT NULL,
  `order_id` bigint(20) DEFAULT NULL,
  `op` varchar(8) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `app_device_numbers`;
CREATE TABLE `app_device_numbers` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `device_id` varchar(64) NOT NULL,
  `prefix` tinyint(3) UNSIGNED NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `app_device_tokens`;
CREATE TABLE `app_device_tokens` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `user_ref` varchar(32) NOT NULL,
  `is_client` tinyint(1) NOT NULL DEFAULT 0,
  `role` varchar(32) NOT NULL DEFAULT 'waiter',
  `device_id` varchar(64) NOT NULL,
  `device_name` varchar(120) DEFAULT NULL,
  `platform` varchar(24) DEFAULT NULL,
  `app_version` varchar(24) DEFAULT NULL,
  `token_hash` char(64) NOT NULL,
  `refresh_hash` char(64) NOT NULL,
  `expires_at` datetime NOT NULL,
  `refresh_expires_at` datetime NOT NULL,
  `last_seen_at` datetime DEFAULT NULL,
  `last_ip` varchar(45) DEFAULT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `app_login_attempts`;
CREATE TABLE `app_login_attempts` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `ip` varchar(45) NOT NULL,
  `identifier` varchar(190) DEFAULT NULL,
  `ok` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `app_order_counters`;
CREATE TABLE `app_order_counters` (
  `client_id` int(11) NOT NULL,
  `business_date` date NOT NULL,
  `prefix` tinyint(3) UNSIGNED NOT NULL DEFAULT 0,
  `next_no` int(10) UNSIGNED NOT NULL DEFAULT 1,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `app_passkeys`;
CREATE TABLE `app_passkeys` (
  `id` int(10) UNSIGNED NOT NULL,
  `credential_id` varchar(255) NOT NULL,
  `public_key` text NOT NULL,
  `sign_count` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `client_id` int(11) NOT NULL,
  `user_ref` varchar(32) NOT NULL DEFAULT '',
  `is_client` tinyint(1) NOT NULL DEFAULT 0,
  `label` varchar(60) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `last_used_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `app_remember_tokens`;
CREATE TABLE `app_remember_tokens` (
  `selector` char(18) NOT NULL,
  `validator_hash` char(64) NOT NULL,
  `client_id` int(11) NOT NULL,
  `user_ref` varchar(32) NOT NULL DEFAULT '',
  `is_client` tinyint(1) NOT NULL DEFAULT 0,
  `expires_at` datetime NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `app_sync_ops`;
CREATE TABLE `app_sync_ops` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `op_id` char(36) NOT NULL,
  `device_id` varchar(64) NOT NULL,
  `op_type` varchar(48) NOT NULL,
  `status` enum('applied','rejected') NOT NULL DEFAULT 'applied',
  `response` mediumtext DEFAULT NULL,
  `error_code` varchar(48) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `audit_logs`;
CREATE TABLE `audit_logs` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `actor_client_id` int(11) DEFAULT NULL,
  `role` varchar(50) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `action` varchar(100) NOT NULL,
  `entity_type` varchar(50) DEFAULT NULL,
  `entity_id` varchar(64) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `before_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`before_json`)),
  `after_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`after_json`)),
  `meta_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`meta_json`)),
  `ip` varchar(50) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `user_agent` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `created_at` datetime NOT NULL,
  `details` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `business_settings`;
CREATE TABLE `business_settings` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `business_name` varchar(150) NOT NULL,
  `legal_name` varchar(150) DEFAULT NULL,
  `tax_number` varchar(50) DEFAULT NULL,
  `tax_office` varchar(100) DEFAULT NULL,
  `address_line1` varchar(255) DEFAULT NULL,
  `address_line2` varchar(255) DEFAULT NULL,
  `city` varchar(100) DEFAULT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `email` varchar(150) DEFAULT NULL,
  `website` varchar(150) DEFAULT NULL,
  `instagram` varchar(150) DEFAULT NULL,
  `facebook` varchar(150) DEFAULT NULL,
  `tiktok` varchar(150) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `cash_registers`;
CREATE TABLE `cash_registers` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `branch_id` int(11) DEFAULT NULL,
  `name` varchar(80) NOT NULL,
  `code` varchar(32) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `categories`;
CREATE TABLE `categories` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `station_id` int(11) DEFAULT NULL,
  `name` varchar(100) NOT NULL,
  `sort_order` int(11) DEFAULT 0,
  `is_active` tinyint(1) DEFAULT 1,
  `use_in_pos` tinyint(1) NOT NULL DEFAULT 1,
  `use_in_qr` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `clients`;
CREATE TABLE `clients` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `slug` varchar(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `owner_name` varchar(255) NOT NULL,
  `company_name` varchar(255) NOT NULL,
  `partner_id` varchar(32) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `full_address` text NOT NULL,
  `permanent_email` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `username` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `email` varchar(190) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `display_name` varchar(255) DEFAULT NULL,
  `password_hash` char(60) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `pin_hash` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `role` enum('admin') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL DEFAULT 'admin',
  `tax_number` varchar(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `tax_office` varchar(255) NOT NULL,
  `phone` varchar(50) NOT NULL,
  `logo_path` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `contact_name` varchar(255) NOT NULL,
  `contact_email` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `contact_phone` varchar(50) NOT NULL,
  `email_verified_at` datetime DEFAULT NULL,
  `email_verify_token` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `email_verify_expires_at` datetime DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `reset_token_hash` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `reset_token_expires_at` datetime DEFAULT NULL,
  `receipt_header` text DEFAULT NULL,
  `receipt_footer` text DEFAULT NULL,
  `admin_pin_hash` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `is_logged_in` tinyint(1) NOT NULL DEFAULT 0,
  `setup_done` tinyint(1) NOT NULL DEFAULT 0,
  `receipt_station_id` int(11) NOT NULL DEFAULT 0,
  `pin_changed_at` datetime DEFAULT NULL,
  `pin_set_by` int(11) DEFAULT NULL,
  `pin_set_by_label` varchar(120) DEFAULT NULL,
  `pin_fail_count` smallint(6) NOT NULL DEFAULT 0,
  `pin_locked_until` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `costs`;
CREATE TABLE `costs` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `title` varchar(255) NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `created_at` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `crm_messages`;
CREATE TABLE `crm_messages` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `kind` varchar(30) NOT NULL,
  `to_email` varchar(190) NOT NULL,
  `subject` varchar(190) NOT NULL,
  `body_text` text DEFAULT NULL,
  `ok` tinyint(1) NOT NULL DEFAULT 0,
  `error` varchar(255) DEFAULT NULL,
  `admin_id` int(11) DEFAULT NULL,
  `admin_name` varchar(100) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `crm_tasks`;
CREATE TABLE `crm_tasks` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `title` varchar(190) NOT NULL,
  `detail` text DEFAULT NULL,
  `due_on` date NOT NULL,
  `assigned_to` varchar(100) DEFAULT NULL,
  `kind` varchar(30) NOT NULL DEFAULT 'followup',
  `done_at` datetime DEFAULT NULL,
  `done_by` varchar(100) DEFAULT NULL,
  `created_by` varchar(100) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `customers`;
CREATE TABLE `customers` (
  `id` int(10) UNSIGNED NOT NULL,
  `first_name` varchar(100) DEFAULT NULL,
  `last_name` varchar(100) DEFAULT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `email` varchar(190) DEFAULT NULL,
  `birth_date` date DEFAULT NULL,
  `password_hash` varchar(255) DEFAULT NULL,
  `qr_uid` char(36) DEFAULT NULL,
  `is_verified` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_by_client_id` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `daily_closings`;
CREATE TABLE `daily_closings` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `date` date NOT NULL,
  `close_seq` int(11) NOT NULL DEFAULT 1,
  `expected_cash` decimal(10,2) NOT NULL DEFAULT 0.00,
  `declared_cash` decimal(10,2) NOT NULL DEFAULT 0.00,
  `declared_card` decimal(10,2) NOT NULL DEFAULT 0.00,
  `cash_difference` decimal(10,2) NOT NULL DEFAULT 0.00,
  `card_difference` decimal(10,2) NOT NULL DEFAULT 0.00,
  `expected_card` decimal(10,2) NOT NULL DEFAULT 0.00,
  `expected_sales` decimal(10,2) NOT NULL DEFAULT 0.00,
  `order_count` int(11) NOT NULL DEFAULT 0,
  `expected_cost` decimal(10,2) NOT NULL DEFAULT 0.00,
  `expected_net` decimal(10,2) NOT NULL DEFAULT 0.00,
  `closed_by` int(11) DEFAULT NULL,
  `closed_at` datetime NOT NULL,
  `reopened_at` datetime DEFAULT NULL,
  `reopened_by` int(11) DEFAULT NULL,
  `is_reopened` tinyint(1) NOT NULL DEFAULT 0,
  /* The day's date while the closing stands, NULL once it is reopened. The
     unique key below then says the only thing that is actually true: a day has
     at most ONE closing that still counts. See 2026-09-12-gunsonu-tek.sql. */
  `active_date` date GENERATED ALWAYS AS (if(coalesce(`is_reopened`,0) = 0,`date`,NULL)) STORED
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `daily_costs`;
CREATE TABLE `daily_costs` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `date` date NOT NULL,
  `category` varchar(50) NOT NULL,
  `description` text DEFAULT NULL,
  `amount` decimal(16,2) NOT NULL,
  `created_by` int(11) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `daily_finance_snapshots`;
CREATE TABLE `daily_finance_snapshots` (
  `id` int(11) NOT NULL,
  `client_id` int(10) UNSIGNED DEFAULT NULL,
  `date` date DEFAULT NULL,
  `sales` decimal(10,2) DEFAULT NULL,
  `discounts` decimal(10,2) DEFAULT NULL,
  `costs` decimal(11,2) DEFAULT NULL,
  `profit` decimal(10,2) DEFAULT NULL,
  `margin` decimal(5,2) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `deleted_activity_log`;
CREATE TABLE `deleted_activity_log` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `entity_type` enum('payment','order','item','table') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `entity_id` int(11) NOT NULL,
  `json_data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`json_data`)),
  `reason` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `doviz_kurlari`;
CREATE TABLE `doviz_kurlari` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `code` char(3) NOT NULL COMMENT 'ISO 4217: EUR, USD, GBP',
  `name` varchar(40) NOT NULL,
  `symbol` varchar(8) NOT NULL DEFAULT '',
  `rate` decimal(12,4) NOT NULL DEFAULT 0.0000 COMMENT '1 birim kaç TL eder — 0 ise ekranda gösterilmez',
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `rate_updated_at` datetime DEFAULT NULL COMMENT 'NULL = kur hiç girilmedi',
  `updated_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `doviz_kur_gecmisi`;
CREATE TABLE `doviz_kur_gecmisi` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `doviz_id` int(10) UNSIGNED NOT NULL,
  `old_rate` decimal(12,4) DEFAULT NULL,
  `new_rate` decimal(12,4) NOT NULL,
  `changed_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `finance_daily_snapshots`;
CREATE TABLE `finance_daily_snapshots` (
  `id` int(11) NOT NULL,
  `client_id` int(10) UNSIGNED NOT NULL,
  `date` date NOT NULL,
  `gross_sales` decimal(10,2) NOT NULL DEFAULT 0.00,
  `discounts` decimal(10,2) NOT NULL DEFAULT 0.00,
  `net_sales` decimal(10,2) NOT NULL DEFAULT 0.00,
  `cost_of_goods` decimal(10,2) NOT NULL DEFAULT 0.00,
  `extra_costs` decimal(10,2) NOT NULL DEFAULT 0.00,
  `cash_sales` decimal(10,2) NOT NULL DEFAULT 0.00,
  `card_sales` decimal(10,2) NOT NULL DEFAULT 0.00,
  `order_count` int(11) NOT NULL DEFAULT 0,
  `canceled_order_count` int(11) NOT NULL DEFAULT 0,
  `profit` decimal(10,2) NOT NULL DEFAULT 0.00,
  `margin` decimal(5,2) NOT NULL DEFAULT 0.00,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `fiscal_agents`;
CREATE TABLE `fiscal_agents` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `cash_register_id` int(10) UNSIGNED DEFAULT NULL,
  `agent_id` char(36) NOT NULL,
  `name` varchar(80) DEFAULT NULL,
  `secret_hash` char(64) NOT NULL,
  `machine_hint` varchar(120) DEFAULT NULL,
  `paired_at` datetime NOT NULL DEFAULT current_timestamp(),
  `last_seen_at` datetime DEFAULT NULL,
  `last_ip` varchar(45) DEFAULT NULL,
  `revoked_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `fiscal_agent_pairings`;
CREATE TABLE `fiscal_agent_pairings` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `cash_register_id` int(10) UNSIGNED DEFAULT NULL,
  `code` varchar(12) NOT NULL,
  `created_by` int(11) DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `used_agent_id` char(36) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `fiscal_devices`;
CREATE TABLE `fiscal_devices` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `branch_id` int(11) DEFAULT NULL,
  `cash_register_id` int(10) UNSIGNED DEFAULT NULL,
  `provider` varchar(32) NOT NULL,
  `device_model` varchar(64) DEFAULT NULL,
  `serial_number` varchar(64) NOT NULL,
  `connection_type` varchar(24) NOT NULL DEFAULT 'LOCAL_AGENT',
  `device_ip` varchar(45) DEFAULT NULL,
  `device_port` smallint(5) UNSIGNED DEFAULT NULL,
  `local_agent_id` char(36) DEFAULT NULL,
  `merchant_id` varchar(64) DEFAULT NULL,
  `terminal_id` varchar(64) DEFAULT NULL,
  `environment` varchar(16) NOT NULL DEFAULT 'SIMULATOR',
  `status` varchar(16) NOT NULL DEFAULT 'UNKNOWN',
  `status_detail` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `last_seen_at` datetime DEFAULT NULL,
  `last_transaction_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `fiscal_device_commands`;
CREATE TABLE `fiscal_device_commands` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `fiscal_device_id` int(10) UNSIGNED NOT NULL,
  `fiscal_transaction_id` bigint(20) UNSIGNED DEFAULT NULL,
  `order_no` int(11) DEFAULT NULL,
  `agent_id` char(36) DEFAULT NULL,
  `command` varchar(32) NOT NULL,
  `payload` longtext DEFAULT NULL,
  `status` varchar(12) NOT NULL DEFAULT 'pending',
  `claimed_at` datetime DEFAULT NULL,
  `result` longtext DEFAULT NULL,
  `error_code` varchar(48) DEFAULT NULL,
  `attempt_count` smallint(5) UNSIGNED NOT NULL DEFAULT 0,
  `expires_at` datetime NOT NULL,
  `completed_at` datetime DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `fiscal_device_reports`;
CREATE TABLE `fiscal_device_reports` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `fiscal_device_id` int(10) UNSIGNED DEFAULT NULL,
  `agent_id` char(36) DEFAULT NULL,
  `report_type` varchar(24) NOT NULL DEFAULT 'PAYMENT',
  `order_no` int(11) DEFAULT NULL,
  `order_id` int(10) UNSIGNED DEFAULT NULL,
  `amount_minor` bigint(20) NOT NULL DEFAULT 0,
  `payment_method` varchar(16) NOT NULL DEFAULT 'CARD',
  `provider_transaction_id` varchar(96) DEFAULT NULL,
  `authorization_code` varchar(32) DEFAULT NULL,
  `card_masked` varchar(24) DEFAULT NULL,
  `card_brand` varchar(32) DEFAULT NULL,
  `bank` varchar(64) DEFAULT NULL,
  `batch_no` varchar(16) DEFAULT NULL,
  `stan` varchar(16) DEFAULT NULL,
  `fiscal_receipt_no` varchar(48) DEFAULT NULL,
  `z_number` varchar(24) DEFAULT NULL,
  `device_time` datetime DEFAULT NULL,
  `report_key` varchar(96) NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'pending',
  `fiscal_transaction_id` bigint(20) UNSIGNED DEFAULT NULL,
  `note` varchar(255) DEFAULT NULL,
  `raw` longtext DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `processed_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `fiscal_device_secrets`;
CREATE TABLE `fiscal_device_secrets` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `fiscal_device_id` int(10) UNSIGNED NOT NULL,
  `secret_key` varchar(48) NOT NULL,
  `cipher` varchar(24) NOT NULL DEFAULT 'aes-256-gcm',
  `secret_value` text NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `fiscal_provider_logs`;
CREATE TABLE `fiscal_provider_logs` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `fiscal_device_id` int(10) UNSIGNED DEFAULT NULL,
  `fiscal_transaction_id` bigint(20) UNSIGNED DEFAULT NULL,
  `provider` varchar(32) NOT NULL,
  `direction` varchar(12) NOT NULL,
  `operation` varchar(48) NOT NULL,
  `payload_masked` longtext DEFAULT NULL,
  `http_status` smallint(5) UNSIGNED DEFAULT NULL,
  `duration_ms` int(10) UNSIGNED DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `fiscal_receipts`;
CREATE TABLE `fiscal_receipts` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `fiscal_transaction_id` bigint(20) UNSIGNED NOT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `fiscal_receipt_no` varchar(48) DEFAULT NULL,
  `document_no` varchar(48) DEFAULT NULL,
  `z_number` varchar(24) DEFAULT NULL,
  `ekh_serial` varchar(48) DEFAULT NULL,
  `fiscal_reference` varchar(96) DEFAULT NULL,
  `payment_reference` varchar(96) DEFAULT NULL,
  `fiscal_timestamp` datetime DEFAULT NULL,
  `raw_response` longtext DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `fiscal_refunds`;
CREATE TABLE `fiscal_refunds` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `idempotency_key` char(36) NOT NULL,
  `original_fiscal_transaction_id` bigint(20) UNSIGNED NOT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `fiscal_device_id` int(10) UNSIGNED DEFAULT NULL,
  `provider` varchar(32) NOT NULL,
  `refund_type` varchar(16) NOT NULL DEFAULT 'PARTIAL',
  `amount_minor` bigint(20) NOT NULL,
  `reason` varchar(255) DEFAULT NULL,
  `state` varchar(32) NOT NULL DEFAULT 'CREATED',
  `provider_refund_id` varchar(96) DEFAULT NULL,
  `error_code` varchar(48) DEFAULT NULL,
  `error_message` varchar(255) DEFAULT NULL,
  `restock` tinyint(1) NOT NULL DEFAULT 0,
  `requested_by` int(11) DEFAULT NULL,
  `approved_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `finished_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `fiscal_refund_items`;
CREATE TABLE `fiscal_refund_items` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `fiscal_refund_id` bigint(20) UNSIGNED NOT NULL,
  `fiscal_transaction_item_id` bigint(20) UNSIGNED DEFAULT NULL,
  `order_item_id` int(10) UNSIGNED DEFAULT NULL,
  `product_id` int(11) DEFAULT NULL,
  `product_name` varchar(190) NOT NULL,
  `quantity` decimal(10,3) NOT NULL DEFAULT 1.000,
  `amount_minor` bigint(20) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `fiscal_transactions`;
CREATE TABLE `fiscal_transactions` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `branch_id` int(11) DEFAULT NULL,
  `idempotency_key` char(36) NOT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `order_no` int(11) DEFAULT NULL,
  `table_session_id` int(11) DEFAULT NULL,
  `table_id` int(10) UNSIGNED DEFAULT NULL,
  `cash_register_id` int(10) UNSIGNED DEFAULT NULL,
  `fiscal_device_id` int(10) UNSIGNED DEFAULT NULL,
  `provider` varchar(32) NOT NULL,
  `environment` varchar(16) NOT NULL DEFAULT 'SIMULATOR',
  `cashier_id` int(11) DEFAULT NULL,
  `waiter_id` int(11) DEFAULT NULL,
  `currency` char(3) NOT NULL DEFAULT 'TRY',
  `subtotal_minor` bigint(20) NOT NULL DEFAULT 0,
  `discount_total_minor` bigint(20) NOT NULL DEFAULT 0,
  `service_charge_minor` bigint(20) NOT NULL DEFAULT 0,
  `tax_total_minor` bigint(20) NOT NULL DEFAULT 0,
  `grand_total_minor` bigint(20) NOT NULL DEFAULT 0,
  `requested_amount_minor` bigint(20) NOT NULL DEFAULT 0,
  `approved_amount_minor` bigint(20) DEFAULT NULL,
  `cash_received_minor` bigint(20) DEFAULT NULL,
  `change_minor` bigint(20) DEFAULT NULL,
  `payment_method` varchar(16) NOT NULL,
  `split_mode` varchar(16) DEFAULT NULL,
  `paid_by_guest` varchar(32) DEFAULT NULL,
  `state` varchar(32) NOT NULL DEFAULT 'CREATED',
  `provider_session_id` varchar(96) DEFAULT NULL,
  `provider_transaction_id` varchar(96) DEFAULT NULL,
  `authorization_code` varchar(32) DEFAULT NULL,
  `bank` varchar(64) DEFAULT NULL,
  `card_brand` varchar(32) DEFAULT NULL,
  `card_masked` varchar(24) DEFAULT NULL,
  `installments` tinyint(3) UNSIGNED DEFAULT NULL,
  `batch_no` varchar(16) DEFAULT NULL,
  `stan` varchar(16) DEFAULT NULL,
  `error_code` varchar(48) DEFAULT NULL,
  `error_message` varchar(255) DEFAULT NULL,
  `sale_snapshot` longtext DEFAULT NULL,
  `attempt_count` smallint(5) UNSIGNED NOT NULL DEFAULT 0,
  `started_at` datetime NOT NULL DEFAULT current_timestamp(),
  `state_changed_at` datetime NOT NULL DEFAULT current_timestamp(),
  `finished_at` datetime DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `fiscal_transaction_events`;
CREATE TABLE `fiscal_transaction_events` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `fiscal_transaction_id` bigint(20) UNSIGNED DEFAULT NULL,
  `order_id` int(10) UNSIGNED DEFAULT NULL,
  `table_id` int(10) UNSIGNED DEFAULT NULL,
  `fiscal_device_id` int(10) UNSIGNED DEFAULT NULL,
  `event` varchar(48) NOT NULL,
  `from_state` varchar(32) DEFAULT NULL,
  `to_state` varchar(32) DEFAULT NULL,
  `result` varchar(24) DEFAULT NULL,
  `amount_minor` bigint(20) DEFAULT NULL,
  `actor_user_id` int(11) DEFAULT NULL,
  `actor_role` varchar(24) DEFAULT NULL,
  `actor_device` varchar(64) DEFAULT NULL,
  `detail` text DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `fiscal_transaction_items`;
CREATE TABLE `fiscal_transaction_items` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `fiscal_transaction_id` bigint(20) UNSIGNED NOT NULL,
  `order_item_id` int(10) UNSIGNED DEFAULT NULL,
  `product_id` int(11) DEFAULT NULL,
  `product_name` varchar(190) NOT NULL,
  `sku` varchar(64) DEFAULT NULL,
  `barcode` varchar(64) DEFAULT NULL,
  `fiscal_product_code` varchar(32) DEFAULT NULL,
  `department` varchar(64) DEFAULT NULL,
  `quantity` decimal(10,3) NOT NULL DEFAULT 1.000,
  `unit` varchar(16) NOT NULL DEFAULT 'ADET',
  `unit_price_minor` bigint(20) NOT NULL DEFAULT 0,
  `modifier_total_minor` bigint(20) NOT NULL DEFAULT 0,
  `discount_minor` bigint(20) NOT NULL DEFAULT 0,
  `vat_rate` decimal(5,2) NOT NULL DEFAULT 0.00,
  `vat_amount_minor` bigint(20) NOT NULL DEFAULT 0,
  `line_total_minor` bigint(20) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `inventory_categories`;
CREATE TABLE `inventory_categories` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `name` varchar(128) NOT NULL,
  `created_at` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `inventory_documents`;
CREATE TABLE `inventory_documents` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `supplier_id` int(11) DEFAULT NULL,
  `type` enum('purchase','manual_entry','count_fix','ai_scan') NOT NULL,
  `document_no` varchar(100) DEFAULT NULL,
  `document_date` date NOT NULL,
  `total_amount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `status` enum('draft','approved','cancelled') NOT NULL DEFAULT 'draft',
  `source` enum('manual','camera','upload','api') NOT NULL DEFAULT 'manual',
  `file_path` varchar(255) DEFAULT NULL,
  `created_by` int(11) NOT NULL,
  `approved_by` int(11) DEFAULT NULL,
  `approved_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `inventory_document_items`;
CREATE TABLE `inventory_document_items` (
  `id` int(11) NOT NULL,
  `document_id` int(11) NOT NULL,
  `item_id` int(11) DEFAULT NULL,
  `raw_name` varchar(255) NOT NULL,
  `quantity` decimal(12,3) NOT NULL,
  `unit` varchar(20) NOT NULL,
  `unit_price` decimal(12,4) NOT NULL,
  `total_price` decimal(12,4) NOT NULL,
  `vat_rate` decimal(5,2) NOT NULL DEFAULT 0.00,
  `vat_amount` decimal(12,4) NOT NULL DEFAULT 0.0000,
  `matched_confidence` decimal(5,2) DEFAULT NULL,
  `is_approved` tinyint(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `inventory_items`;
CREATE TABLE `inventory_items` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `name` varchar(255) NOT NULL,
  `sku` varchar(100) DEFAULT NULL,
  `barcode` varchar(100) DEFAULT NULL,
  `unit` enum('pcs','kg','g','lt','ml','pack') NOT NULL DEFAULT 'pcs',
  `category_id` int(11) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `inventory_stock_cache`;
CREATE TABLE `inventory_stock_cache` (
  `client_id` int(11) NOT NULL,
  `item_id` int(11) NOT NULL,
  `quantity` decimal(12,3) NOT NULL DEFAULT 0.000,
  `updated_at` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `inventory_stock_ledger`;
CREATE TABLE `inventory_stock_ledger` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `item_id` int(11) NOT NULL,
  `source_type` enum('document','sale','adjustment') NOT NULL,
  `source_id` int(11) NOT NULL,
  `quantity_in` decimal(12,3) NOT NULL DEFAULT 0.000,
  `quantity_out` decimal(12,3) NOT NULL DEFAULT 0.000,
  `unit_cost` decimal(12,4) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `inventory_units`;
CREATE TABLE `inventory_units` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `name` varchar(64) NOT NULL,
  `created_at` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `loyalty_cards`;
CREATE TABLE `loyalty_cards` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `program_id` int(10) UNSIGNED NOT NULL,
  `progress_count` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `rewards_available` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `rewards_used` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `loyalty_events`;
CREATE TABLE `loyalty_events` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `program_id` int(10) UNSIGNED NOT NULL,
  `card_id` int(10) UNSIGNED DEFAULT NULL,
  `product_id` int(10) UNSIGNED DEFAULT NULL,
  `order_id` int(10) UNSIGNED DEFAULT NULL,
  `user_id` int(11) DEFAULT NULL,
  `kind` enum('stamp','reward','adjust') NOT NULL DEFAULT 'stamp',
  `qty` int(11) NOT NULL DEFAULT 1,
  `source` enum('scan','order','manual') NOT NULL DEFAULT 'scan',
  `note` varchar(190) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `loyalty_programs`;
CREATE TABLE `loyalty_programs` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `product_id` int(10) UNSIGNED DEFAULT NULL,
  `title` varchar(190) NOT NULL,
  `target_count` int(10) UNSIGNED NOT NULL DEFAULT 10,
  `reward_text` varchar(190) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `loyalty_qr_tokens`;
CREATE TABLE `loyalty_qr_tokens` (
  `token` char(64) NOT NULL,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `expires_at` datetime NOT NULL,
  `expires_ts` int(10) UNSIGNED NOT NULL DEFAULT 0,
  `used_at` datetime DEFAULT NULL,
  `used_by_client_id` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `orders`;
CREATE TABLE `orders` (
  `id` int(10) UNSIGNED NOT NULL,
  `adisyon_no` int(11) DEFAULT NULL,
  `client_id` int(11) NOT NULL,
  `business_date` date NOT NULL DEFAULT curdate(),
  `table_id` int(10) UNSIGNED NOT NULL,
  `waiter_id` int(11) NOT NULL DEFAULT 0,
  `customer_id` int(10) UNSIGNED DEFAULT NULL,
  `status` enum('open','closed','cancelled') NOT NULL DEFAULT 'open',
  `opened_at` datetime NOT NULL DEFAULT current_timestamp(),
  `closed_at` datetime DEFAULT NULL,
  `closed_by` int(11) DEFAULT NULL,
  `total` decimal(10,2) NOT NULL DEFAULT 0.00,
  `discount_total` decimal(10,2) NOT NULL DEFAULT 0.00,
  `vat_total` decimal(10,2) NOT NULL DEFAULT 0.00,
  `grand_total` decimal(10,2) NOT NULL DEFAULT 0.00,
  `notes` text DEFAULT NULL,
  `bill_label` varchar(20) DEFAULT NULL,
  `table_session_id` int(11) DEFAULT NULL,
  `parent_order_id` int(11) DEFAULT NULL,
  `created_by` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL,
  `is_closed` tinyint(1) NOT NULL DEFAULT 0,
  `exclude_from_reports` tinyint(1) NOT NULL DEFAULT 0,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `app_local_id` varchar(64) DEFAULT NULL,
  `app_device_id` varchar(64) DEFAULT NULL,
  `app_created_offline` tinyint(1) NOT NULL DEFAULT 0,
  `shift_id` bigint(20) UNSIGNED DEFAULT NULL,
  `reopen_count` smallint(6) NOT NULL DEFAULT 0,
  `reopened_at` datetime DEFAULT NULL,
  `reopened_by` int(11) DEFAULT NULL,
  `reopened_label` varchar(120) DEFAULT NULL,
  `qr_oturum_id` bigint(20) UNSIGNED DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `order_counters`;
CREATE TABLE `order_counters` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `last_no` int(11) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `order_delete_logs`;
CREATE TABLE `order_delete_logs` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `order_id` int(11) NOT NULL,
  `bill_label` varchar(20) DEFAULT NULL,
  `adisyon_no` int(11) DEFAULT NULL,
  `table_id` int(11) DEFAULT NULL,
  `waiter_id` int(11) DEFAULT NULL,
  `opened_at` datetime DEFAULT NULL,
  `closed_at` datetime DEFAULT NULL,
  `total` decimal(10,2) DEFAULT NULL,
  `discount_total` decimal(10,2) DEFAULT NULL,
  `grand_total` decimal(10,2) DEFAULT NULL,
  `deleted_at` datetime NOT NULL DEFAULT current_timestamp(),
  `deleted_by` int(11) NOT NULL,
  `reason` varchar(255) NOT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `user_agent` varchar(255) DEFAULT NULL,
  `original_data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`original_data`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `order_items`;
CREATE TABLE `order_items` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `product_id` int(11) NOT NULL,
  `station_id` int(10) UNSIGNED DEFAULT NULL,
  `station_status` enum('new','preparing','ready','served','cancelled') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL DEFAULT 'new',
  `station_updated_at` datetime DEFAULT NULL,
  `qty` decimal(10,2) NOT NULL DEFAULT 1.00,
  `note` varchar(255) DEFAULT NULL,
  `price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `cost_price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `total` decimal(10,2) NOT NULL DEFAULT 0.00,
  `line_total` decimal(10,2) NOT NULL,
  `discount_amount` decimal(10,2) NOT NULL DEFAULT 0.00,
  `unit_price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `vat_rate` decimal(5,2) NOT NULL DEFAULT 0.00,
  `vat_total` decimal(10,2) NOT NULL DEFAULT 0.00,
  `stock_applied` tinyint(1) NOT NULL DEFAULT 0,
  `sent_qty` decimal(10,2) NOT NULL DEFAULT 0.00,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `app_local_id` varchar(64) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `qr_kaynak` tinyint(1) NOT NULL DEFAULT 0,
  `qr_onay` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `order_item_cancel_events`;
CREATE TABLE `order_item_cancel_events` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `order_id` int(11) NOT NULL,
  `product_id` int(11) NOT NULL,
  `qty` int(11) NOT NULL,
  `line_total` decimal(10,2) NOT NULL,
  `vat_total` decimal(10,2) NOT NULL,
  `vat_rate` decimal(5,2) NOT NULL,
  `cancelled_at` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `order_payments`;
CREATE TABLE `order_payments` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `method` varchar(50) NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `fiscal_transaction_id` bigint(20) UNSIGNED DEFAULT NULL,
  `paid_by_guest` varchar(32) DEFAULT NULL,
  `payment_channel` varchar(24) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `voided_at` datetime DEFAULT NULL,
  `voided_by` int(11) DEFAULT NULL,
  `void_reason` text DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  `is_deleted` tinyint(1) NOT NULL DEFAULT 0,
  `deleted_at` datetime DEFAULT NULL,
  `deleted_by` int(11) DEFAULT NULL,
  `shift_id` bigint(20) UNSIGNED DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `order_payment_locks`;
CREATE TABLE `order_payment_locks` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `lock_token` char(36) NOT NULL,
  `fiscal_transaction_id` bigint(20) UNSIGNED DEFAULT NULL,
  `reason` varchar(32) NOT NULL DEFAULT 'PAYMENT',
  `locked_by_user_id` int(11) DEFAULT NULL,
  `locked_by_device` varchar(64) DEFAULT NULL,
  `acquired_at` datetime NOT NULL DEFAULT current_timestamp(),
  `expires_at` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `pass_remember_tokens`;
CREATE TABLE `pass_remember_tokens` (
  `id` int(10) UNSIGNED NOT NULL,
  `selector` varchar(32) NOT NULL,
  `validator_hash` char(64) NOT NULL,
  `customer_id` int(11) NOT NULL,
  `expires_at` datetime NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `payment_delete_logs`;
CREATE TABLE `payment_delete_logs` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `payment_id` int(11) NOT NULL,
  `order_id` int(11) DEFAULT NULL,
  `table_id` int(11) DEFAULT NULL,
  `method` varchar(20) DEFAULT NULL,
  `amount` decimal(10,2) DEFAULT NULL,
  `payment_created_at` datetime DEFAULT NULL,
  `deleted_at` datetime NOT NULL DEFAULT current_timestamp(),
  `deleted_by` int(11) NOT NULL,
  `ip_address` varchar(45) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `user_agent` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `original_data` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`original_data`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `pos_shifts`;
CREATE TABLE `pos_shifts` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `shift_uid` char(36) NOT NULL COMMENT 'minted by the till, the idempotency key',
  `device_id` varchar(64) DEFAULT NULL,
  `business_date` date NOT NULL,
  `shift_no` int(10) UNSIGNED NOT NULL DEFAULT 1 COMMENT 'per client per business day',
  `opened_by` int(11) DEFAULT NULL,
  `opened_by_name` varchar(120) DEFAULT NULL,
  `opened_at` datetime NOT NULL,
  `opening_float_minor` bigint(20) NOT NULL DEFAULT 0,
  `closed_by` int(11) DEFAULT NULL,
  `closed_by_name` varchar(120) DEFAULT NULL,
  `closed_at` datetime DEFAULT NULL,
  `counted_cash_minor` bigint(20) DEFAULT NULL COMMENT 'what the drawer actually held',
  `expected_cash_minor` bigint(20) DEFAULT NULL COMMENT 'recomputed server-side from the ledger',
  `claimed_cash_minor` bigint(20) DEFAULT NULL COMMENT 'what the till thought while offline',
  `variance_minor` bigint(20) DEFAULT NULL,
  `cash_sales_minor` bigint(20) DEFAULT NULL,
  `card_sales_minor` bigint(20) DEFAULT NULL,
  `other_sales_minor` bigint(20) DEFAULT NULL,
  `paid_out_minor` bigint(20) NOT NULL DEFAULT 0,
  `paid_in_minor` bigint(20) NOT NULL DEFAULT 0,
  `order_count` int(10) UNSIGNED DEFAULT NULL,
  `status` varchar(12) NOT NULL DEFAULT 'open' COMMENT 'open|closed',
  `note` varchar(255) DEFAULT NULL,
  `opened_offline` tinyint(1) NOT NULL DEFAULT 0,
  `closed_offline` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `pos_shift_movements`;
CREATE TABLE `pos_shift_movements` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `shift_id` bigint(20) UNSIGNED NOT NULL,
  `movement_uid` char(36) NOT NULL,
  `direction` varchar(4) NOT NULL COMMENT 'in|out',
  `amount_minor` bigint(20) NOT NULL,
  `reason` varchar(190) DEFAULT NULL,
  `user_id` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `price_change_log`;
CREATE TABLE `price_change_log` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `product_id` int(11) NOT NULL,
  `old_price` decimal(10,2) NOT NULL,
  `new_price` decimal(10,2) NOT NULL,
  `source` enum('ai','manual') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `reference_id` int(11) DEFAULT NULL,
  `changed_by` int(11) NOT NULL,
  `changed_at` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `pricing_notifications`;
CREATE TABLE `pricing_notifications` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `suggestion_id` int(11) NOT NULL,
  `channel` enum('dashboard','email') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT 'dashboard',
  `created_at` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `pricing_strategy`;
CREATE TABLE `pricing_strategy` (
  `id` int(11) NOT NULL,
  `client_id` int(10) UNSIGNED NOT NULL,
  `mode` enum('profit','volume') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `set_at` datetime NOT NULL DEFAULT current_timestamp(),
  `set_by` int(10) UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `pricing_suggestions`;
CREATE TABLE `pricing_suggestions` (
  `id` int(11) NOT NULL,
  `client_id` int(10) UNSIGNED NOT NULL,
  `product_id` int(10) UNSIGNED NOT NULL,
  `current_price` decimal(10,2) NOT NULL,
  `suggested_price` decimal(10,2) NOT NULL,
  `chosen_price` decimal(10,2) DEFAULT NULL,
  `suggested_min` decimal(10,2) NOT NULL,
  `suggested_max` decimal(10,2) NOT NULL,
  `strategy` enum('profit','volume') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `confidence` int(11) NOT NULL,
  `reason` text NOT NULL,
  `data_window_days` int(10) UNSIGNED NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `accepted_at` datetime DEFAULT NULL,
  `rejected_at` datetime DEFAULT NULL,
  `accepted_by` int(10) UNSIGNED DEFAULT NULL,
  `shown_count` int(11) NOT NULL DEFAULT 0,
  `applied_count` int(11) NOT NULL DEFAULT 0,
  `estimated_profit` decimal(10,2) NOT NULL DEFAULT 0.00
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `printers`;
CREATE TABLE `printers` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `station_id` int(11) NOT NULL,
  `name` varchar(100) NOT NULL,
  `type` varchar(50) NOT NULL,
  `ip_address` varchar(100) DEFAULT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `print_jobs`;
CREATE TABLE `print_jobs` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `job_type` enum('order','receipt') NOT NULL,
  `order_id` int(11) NOT NULL,
  `station_id` int(11) DEFAULT NULL,
  `content` mediumtext NOT NULL,
  `status` enum('pending','sent','done','failed') NOT NULL DEFAULT 'pending',
  `sent_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `products`;
CREATE TABLE `products` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `category_id` int(11) NOT NULL,
  `name` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `price` decimal(10,2) NOT NULL,
  `cost_price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `description` mediumtext DEFAULT NULL,
  `sort_order` int(11) DEFAULT 0,
  `is_active` tinyint(1) DEFAULT 1,
  `use_in_pos` tinyint(1) NOT NULL DEFAULT 1,
  `use_in_qr` tinyint(1) NOT NULL DEFAULT 1,
  `vat_rate` decimal(5,2) NOT NULL DEFAULT 0.00,
  `track_stock` tinyint(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

DROP TABLE IF EXISTS `product_costs`;
CREATE TABLE `product_costs` (
  `id` int(11) NOT NULL,
  `client_id` int(10) UNSIGNED NOT NULL,
  `product_id` int(10) UNSIGNED NOT NULL,
  `cost` decimal(10,2) NOT NULL,
  `currency` char(3) DEFAULT 'TRY',
  `effective_date` date NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `created_by` int(11) DEFAULT NULL,
  `note` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `product_price_history`;
CREATE TABLE `product_price_history` (
  `id` int(11) NOT NULL,
  `client_id` int(10) UNSIGNED NOT NULL,
  `product_id` int(10) UNSIGNED NOT NULL,
  `price` decimal(10,2) NOT NULL,
  `effective_date` date NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `created_by` int(11) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `product_stock`;
CREATE TABLE `product_stock` (
  `id` int(11) NOT NULL,
  `product_id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `quantity` decimal(10,2) NOT NULL DEFAULT 0.00,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `stock` decimal(12,3) NOT NULL DEFAULT 0.000
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `product_stock_movements`;
CREATE TABLE `product_stock_movements` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `product_id` int(11) NOT NULL,
  `qty` decimal(10,3) NOT NULL,
  `reason` enum('sale','adjustment','purchase','cancel') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `order_item_id` int(11) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `qr_categories`;
CREATE TABLE `qr_categories` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `name` varchar(200) NOT NULL,
  `image` varchar(255) DEFAULT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `qr_login_attempts`;
CREATE TABLE `qr_login_attempts` (
  `id` int(10) UNSIGNED NOT NULL,
  `ip` varchar(45) NOT NULL,
  `username` varchar(190) DEFAULT NULL,
  `ok` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `qr_menu_assets`;
CREATE TABLE `qr_menu_assets` (
  `client_id` int(11) NOT NULL,
  `qr_image_path` varchar(255) NOT NULL,
  `last_generated_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `qr_menu_settings`;
CREATE TABLE `qr_menu_settings` (
  `client_id` int(11) NOT NULL,
  `slug` varchar(120) NOT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `google_url` varchar(255) DEFAULT NULL,
  `instagram_url` varchar(255) DEFAULT NULL,
  `website_url` varchar(255) DEFAULT NULL,
  `business_name` varchar(120) DEFAULT NULL,
  `about` text DEFAULT NULL,
  `currency` varchar(8) NOT NULL DEFAULT '₺',
  `theme` varchar(16) NOT NULL DEFAULT 'light',
  `is_published` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `qr_products`;
CREATE TABLE `qr_products` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `category_id` int(11) NOT NULL,
  `name_1` varchar(200) NOT NULL,
  `image` varchar(255) DEFAULT NULL,
  `name_2` varchar(200) DEFAULT NULL,
  `name_3` varchar(200) DEFAULT NULL,
  `price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `image_path` varchar(255) DEFAULT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `description` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `reservations`;
CREATE TABLE `reservations` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `table_id` int(10) UNSIGNED DEFAULT NULL,
  `guest_name` varchar(120) NOT NULL,
  `guest_phone` varchar(40) DEFAULT NULL,
  `party_size` int(11) NOT NULL DEFAULT 2,
  `starts_at` datetime NOT NULL,
  `duration_min` int(11) NOT NULL DEFAULT 120,
  `status` enum('booked','seated','done','cancelled','noshow') NOT NULL DEFAULT 'booked',
  `note` varchar(255) DEFAULT NULL,
  `order_id` int(10) UNSIGNED DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `restaurant_tables`;
CREATE TABLE `restaurant_tables` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `zone_id` int(10) UNSIGNED DEFAULT NULL,
  `name` varchar(50) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'empty',
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_occupied` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `qr_token` varchar(32) DEFAULT NULL COMMENT 'masaya özel karekod jetonu — tahmin edilemez'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `stations`;
CREATE TABLE `stations` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(11) NOT NULL,
  `name` varchar(50) NOT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT 0,
  `display_name` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(10) UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `station_logins`;
CREATE TABLE `station_logins` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `station_id` int(11) NOT NULL,
  `pin` varchar(10) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `station_projection_items`;
CREATE TABLE `station_projection_items` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `client_id` int(10) UNSIGNED NOT NULL,
  `station_id` int(10) UNSIGNED NOT NULL,
  `order_id` int(10) UNSIGNED NOT NULL,
  `order_item_id` int(10) UNSIGNED NOT NULL,
  `product_id` int(10) UNSIGNED NOT NULL,
  `qty` int(11) NOT NULL,
  `station_status` enum('new','preparing','ready','done','cancelled') NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `suppliers`;
CREATE TABLE `suppliers` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `name` varchar(255) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `vkn` varchar(20) DEFAULT '',
  `vergi_dairesi` varchar(100) DEFAULT '',
  `created_at` datetime NOT NULL,
  `phone` varchar(64) NOT NULL DEFAULT '',
  `email` varchar(255) NOT NULL DEFAULT '',
  `address` text DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

DROP TABLE IF EXISTS `table_zones`;
CREATE TABLE `table_zones` (
  `id` int(11) NOT NULL,
  `client_id` int(10) UNSIGNED NOT NULL,
  `name` varchar(50) NOT NULL,
  `sort_order` int(10) UNSIGNED DEFAULT 0,
  `is_active` tinyint(1) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `id` int(10) UNSIGNED NOT NULL,
  `client_id` int(10) UNSIGNED NOT NULL,
  `username` varchar(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `email` varchar(190) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `display_name` varchar(100) DEFAULT NULL,
  `role` enum('superadmin','admin','cashier','waiter') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL DEFAULT 'waiter',
  `password_hash` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `pin_hash` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `created_at` datetime DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `is_logged_in` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 0,
  `email_verify_token` varchar(64) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `email_verify_expires_at` datetime DEFAULT NULL,
  `email_verified_at` datetime DEFAULT NULL,
  `invited_by_user_id` int(11) DEFAULT NULL,
  `pin_changed_at` datetime DEFAULT NULL,
  `pin_set_by` int(11) DEFAULT NULL,
  `pin_set_by_label` varchar(120) DEFAULT NULL,
  `pin_fail_count` smallint(6) NOT NULL DEFAULT 0,
  `pin_locked_until` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `user_permissions`;
CREATE TABLE `user_permissions` (
  `id` int(11) NOT NULL,
  `client_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `perm_key` varchar(40) NOT NULL,
  `granted_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TABLE IF EXISTS `v_valid_orders`;
CREATE TABLE `v_valid_orders` (
`id` int(10) unsigned
,`adisyon_no` int(11)
,`client_id` int(11)
,`business_date` date
,`table_id` int(10) unsigned
,`waiter_id` int(11)
,`status` enum('open','closed','cancelled')
,`opened_at` datetime
,`closed_at` datetime
,`closed_by` int(11)
,`total` decimal(10,2)
,`discount_total` decimal(10,2)
,`vat_total` decimal(10,2)
,`grand_total` decimal(10,2)
,`notes` text
,`bill_label` varchar(20)
,`table_session_id` int(11)
,`parent_order_id` int(11)
,`created_by` int(11)
,`created_at` datetime
,`updated_at` datetime
,`is_closed` tinyint(1)
,`exclude_from_reports` tinyint(1)
,`is_deleted` tinyint(1)
);

-- --------------------------------------------------------

--
-- Table structure for table `v_waiter_performance`
--

CREATE TABLE `v_waiter_performance` (
  `id` int(11) NOT NULL,
  `client_id` int(11) DEFAULT NULL,
  `waiter_user_id` decimal(10,0) DEFAULT NULL,
  `order_id` int(10) UNSIGNED DEFAULT NULL,
  `opened_at` datetime DEFAULT NULL,
  `closed_at` datetime DEFAULT NULL,
  `order_total` decimal(10,2) DEFAULT NULL,
  `paid_total` decimal(32,2) DEFAULT NULL,
  `payment_count` bigint(21) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- indexes & auto_increment ----
ALTER TABLE `agent_pair_attempts`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_ip` (`ip`,`created_at`);
ALTER TABLE `app_change_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_cursor` (`client_id`,`id`),
  ADD KEY `idx_entity` (`client_id`,`entity`,`entity_id`);
ALTER TABLE `app_device_numbers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_device` (`client_id`,`device_id`),
  ADD UNIQUE KEY `uq_prefix` (`client_id`,`prefix`);
ALTER TABLE `app_device_tokens`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_token` (`token_hash`),
  ADD UNIQUE KEY `uq_refresh` (`refresh_hash`),
  ADD KEY `idx_client_device` (`client_id`,`device_id`),
  ADD KEY `idx_expiry` (`expires_at`);
ALTER TABLE `app_login_attempts`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_ip_time` (`ip`,`created_at`),
  ADD KEY `idx_ident_time` (`identifier`,`created_at`);
ALTER TABLE `app_order_counters`
  ADD PRIMARY KEY (`client_id`,`business_date`,`prefix`);
ALTER TABLE `app_passkeys`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_pk_cred` (`credential_id`),
  ADD KEY `idx_pk_owner` (`client_id`,`user_ref`,`is_client`);
ALTER TABLE `app_remember_tokens`
  ADD PRIMARY KEY (`selector`),
  ADD KEY `idx_rt_expiry` (`expires_at`),
  ADD KEY `idx_rt_owner` (`client_id`,`user_ref`);
ALTER TABLE `app_sync_ops`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_op` (`client_id`,`op_id`),
  ADD KEY `idx_device` (`client_id`,`device_id`,`created_at`);
ALTER TABLE `audit_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `business_settings`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `cash_registers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_register_code` (`client_id`,`code`),
  ADD KEY `idx_register_client` (`client_id`,`is_active`);
ALTER TABLE `categories`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_category` (`client_id`,`name`),
  ADD KEY `idx_client` (`client_id`);
ALTER TABLE `clients`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `costs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `crm_messages`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_msg_client` (`client_id`,`id`),
  ADD KEY `idx_msg_kind` (`kind`,`created_at`);
ALTER TABLE `crm_tasks`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_task_due` (`done_at`,`due_on`),
  ADD KEY `idx_task_client` (`client_id`,`id`);
ALTER TABLE `customers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_cust_phone` (`phone`),
  ADD UNIQUE KEY `uq_cust_qr` (`qr_uid`),
  ADD KEY `idx_cust_email` (`email`),
  ADD KEY `idx_cust_name` (`first_name`,`last_name`);
ALTER TABLE `daily_closings`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`),
  ADD KEY `idx_dc_client_date` (`client_id`,`date`),
  ADD UNIQUE KEY `uq_dc_client_date_seq` (`client_id`,`date`,`close_seq`),
  ADD UNIQUE KEY `uq_dc_active_day` (`client_id`,`active_date`);
ALTER TABLE `daily_costs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`),
  ADD KEY `idx_dcost_client_date` (`client_id`,`date`);
ALTER TABLE `daily_finance_snapshots`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `deleted_activity_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `doviz_kurlari`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_doviz` (`client_id`,`code`);
ALTER TABLE `doviz_kur_gecmisi`
  ADD PRIMARY KEY (`id`),
  ADD KEY `ix_kurgec` (`doviz_id`,`created_at`);
ALTER TABLE `finance_daily_snapshots`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `fiscal_agents`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_agent_id` (`agent_id`),
  ADD KEY `idx_agent_client` (`client_id`,`revoked_at`);
ALTER TABLE `fiscal_agent_pairings`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_pairing_code` (`code`),
  ADD KEY `idx_pairing_client` (`client_id`,`expires_at`);
ALTER TABLE `fiscal_devices`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_device_serial` (`client_id`,`serial_number`),
  ADD KEY `idx_device_client` (`client_id`,`is_active`),
  ADD KEY `idx_device_register` (`client_id`,`cash_register_id`,`is_active`);
ALTER TABLE `fiscal_device_commands`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_cmd_pending` (`client_id`,`fiscal_device_id`,`status`,`id`),
  ADD KEY `idx_cmd_txn` (`fiscal_transaction_id`,`id`);
ALTER TABLE `fiscal_device_reports`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_report_key` (`client_id`,`report_key`),
  ADD KEY `idx_report_status` (`client_id`,`status`,`id`),
  ADD KEY `idx_report_order` (`client_id`,`order_no`),
  ADD KEY `idx_report_device` (`client_id`,`fiscal_device_id`,`id`);
ALTER TABLE `fiscal_device_secrets`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_device_secret` (`fiscal_device_id`,`secret_key`),
  ADD KEY `idx_secret_client` (`client_id`);
ALTER TABLE `fiscal_provider_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_fpl_txn` (`fiscal_transaction_id`,`id`),
  ADD KEY `idx_fpl_client_time` (`client_id`,`created_at`);
ALTER TABLE `fiscal_receipts`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_receipt_txn` (`fiscal_transaction_id`),
  ADD KEY `idx_receipt_order` (`client_id`,`order_id`),
  ADD KEY `idx_receipt_z` (`client_id`,`z_number`);
ALTER TABLE `fiscal_refunds`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_refund_idem` (`client_id`,`idempotency_key`),
  ADD KEY `idx_refund_original` (`original_fiscal_transaction_id`),
  ADD KEY `idx_refund_order` (`client_id`,`order_id`);
ALTER TABLE `fiscal_refund_items`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_fri_refund` (`fiscal_refund_id`);
ALTER TABLE `fiscal_transactions`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_fiscal_idem` (`client_id`,`idempotency_key`),
  ADD KEY `idx_fiscal_order` (`client_id`,`order_id`,`state`),
  ADD KEY `idx_fiscal_order_no` (`client_id`,`order_no`),
  ADD KEY `idx_fiscal_state` (`client_id`,`state`,`started_at`),
  ADD KEY `idx_fiscal_device` (`client_id`,`fiscal_device_id`,`started_at`),
  ADD KEY `idx_fiscal_day` (`client_id`,`started_at`);
ALTER TABLE `fiscal_transaction_events`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_fte_txn` (`fiscal_transaction_id`,`id`),
  ADD KEY `idx_fte_order` (`client_id`,`order_id`,`id`),
  ADD KEY `idx_fte_client_time` (`client_id`,`created_at`);
ALTER TABLE `fiscal_transaction_items`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_fti_txn` (`fiscal_transaction_id`),
  ADD KEY `idx_fti_client` (`client_id`,`product_id`);
ALTER TABLE `inventory_categories`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_client_name` (`client_id`,`name`);
ALTER TABLE `inventory_documents`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_date` (`client_id`,`document_date`),
  ADD KEY `idx_status` (`status`),
  ADD KEY `idx_supplier` (`supplier_id`);
ALTER TABLE `inventory_document_items`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_doc` (`document_id`),
  ADD KEY `idx_item` (`item_id`);
ALTER TABLE `inventory_items`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client` (`client_id`),
  ADD KEY `idx_barcode` (`barcode`),
  ADD KEY `idx_name` (`name`);
ALTER TABLE `inventory_stock_cache`
  ADD PRIMARY KEY (`client_id`,`item_id`),
  ADD UNIQUE KEY `uniq_client_item` (`client_id`,`item_id`);
ALTER TABLE `inventory_stock_ledger`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_item` (`client_id`,`item_id`),
  ADD KEY `idx_source` (`source_type`,`source_id`);
ALTER TABLE `inventory_units`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_client_name` (`client_id`,`name`);
ALTER TABLE `loyalty_cards`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_card` (`client_id`,`customer_id`,`program_id`),
  ADD KEY `idx_lc_customer` (`customer_id`);
ALTER TABLE `loyalty_events`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_le_client_date` (`client_id`,`created_at`),
  ADD KEY `idx_le_customer` (`customer_id`,`created_at`),
  ADD KEY `idx_le_order` (`client_id`,`order_id`);
ALTER TABLE `loyalty_programs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_lp_client` (`client_id`,`is_active`),
  ADD KEY `idx_lp_product` (`client_id`,`product_id`);
ALTER TABLE `loyalty_qr_tokens`
  ADD PRIMARY KEY (`token`),
  ADD KEY `idx_qr_customer` (`customer_id`,`expires_at`),
  ADD KEY `idx_qr_expiry` (`expires_at`);
ALTER TABLE `orders`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_app_local` (`client_id`,`app_local_id`),
  ADD UNIQUE KEY `uq_adisyon_day` (`client_id`,`business_date`,`adisyon_no`),
  ADD KEY `idx_orders_client_deleted` (`client_id`,`is_deleted`,`id`),
  ADD KEY `idx_client` (`client_id`),
  ADD KEY `idx_reports` (`exclude_from_reports`,`total`,`grand_total`),
  ADD KEY `idx_orders_client_closed` (`client_id`,`closed_at`),
  ADD KEY `idx_orders_client_table_status` (`client_id`,`table_id`,`status`,`is_closed`),
  ADD KEY `idx_orders_customer` (`client_id`,`customer_id`),
  ADD KEY `idx_order_shift` (`client_id`,`shift_id`);
ALTER TABLE `order_counters`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `order_delete_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `order_items`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_item_app_local` (`client_id`,`app_local_id`),
  ADD KEY `idx_station_live` (`client_id`,`station_id`,`station_status`,`station_updated_at`,`id`),
  ADD KEY `idx_station_item` (`client_id`,`id`),
  ADD KEY `idx_client` (`client_id`),
  ADD KEY `idx_oi_order_client` (`order_id`,`client_id`),
  ADD KEY `idx_oi_product` (`client_id`,`product_id`);
ALTER TABLE `order_item_cancel_events`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `order_payments`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`),
  ADD KEY `idx_op_order_client` (`order_id`,`client_id`),
  ADD KEY `idx_op_fiscal_txn` (`client_id`,`fiscal_transaction_id`),
  ADD KEY `idx_pay_shift` (`client_id`,`shift_id`);
ALTER TABLE `order_payment_locks`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_lock_order` (`client_id`,`order_id`),
  ADD KEY `idx_lock_expiry` (`expires_at`);
ALTER TABLE `pass_remember_tokens`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_sel` (`selector`),
  ADD KEY `idx_cust` (`customer_id`);
ALTER TABLE `payment_delete_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `pos_shifts`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_shift_uid` (`client_id`,`shift_uid`),
  ADD KEY `idx_open` (`client_id`,`status`,`business_date`),
  ADD KEY `idx_device` (`client_id`,`device_id`,`status`);
ALTER TABLE `pos_shift_movements`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_movement` (`client_id`,`movement_uid`),
  ADD KEY `idx_shift` (`client_id`,`shift_id`);
ALTER TABLE `price_change_log`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `pricing_notifications`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `pricing_strategy`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_id` (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `pricing_suggestions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `printers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_printer` (`client_id`,`name`),
  ADD KEY `idx_client` (`client_id`);
ALTER TABLE `print_jobs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`),
  ADD KEY `idx_pj_client_status` (`client_id`,`status`,`id`);
ALTER TABLE `products`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_product` (`client_id`,`name`),
  ADD KEY `idx_client` (`client_id`);
ALTER TABLE `product_costs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `product_price_history`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `product_stock`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `product_stock_movements`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `qr_categories`
  ADD PRIMARY KEY (`id`),
  ADD KEY `client_id` (`client_id`);
ALTER TABLE `qr_login_attempts`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_try` (`ip`,`created_at`);
ALTER TABLE `qr_menu_assets`
  ADD PRIMARY KEY (`client_id`);
ALTER TABLE `qr_menu_settings`
  ADD PRIMARY KEY (`client_id`),
  ADD UNIQUE KEY `slug` (`slug`);
ALTER TABLE `qr_products`
  ADD PRIMARY KEY (`id`),
  ADD KEY `client_id` (`client_id`),
  ADD KEY `category_id` (`category_id`);
ALTER TABLE `reservations`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_res_client_time` (`client_id`,`starts_at`),
  ADD KEY `idx_res_client_table` (`client_id`,`table_id`,`starts_at`),
  ADD KEY `idx_res_status` (`client_id`,`status`,`starts_at`);
ALTER TABLE `restaurant_tables`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_table` (`client_id`,`name`),
  ADD UNIQUE KEY `uq_masa_qr` (`qr_token`),
  ADD KEY `idx_client` (`client_id`);
ALTER TABLE `stations`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_station` (`client_id`,`name`),
  ADD UNIQUE KEY `uniq_station_name` (`client_id`,`name`),
  ADD KEY `idx_client` (`client_id`);
ALTER TABLE `station_logins`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `station_projection_items`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_station_item` (`station_id`,`order_item_id`),
  ADD KEY `idx_station_live` (`client_id`,`station_id`,`station_status`,`updated_at`);
ALTER TABLE `suppliers`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_client_vkn` (`client_id`,`vkn`),
  ADD KEY `idx_client_name` (`client_id`,`name`);
ALTER TABLE `table_zones`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_client_id` (`client_id`);
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_user_email` (`client_id`,`email`),
  ADD KEY `idx_client` (`client_id`);
ALTER TABLE `user_permissions`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_user_perm` (`client_id`,`user_id`,`perm_key`),
  ADD KEY `idx_up_user` (`client_id`,`user_id`);
ALTER TABLE `agent_pair_attempts`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=18;
ALTER TABLE `app_change_log`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1628;
ALTER TABLE `app_device_numbers`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=17;
ALTER TABLE `app_device_tokens`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;
ALTER TABLE `app_login_attempts`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;
ALTER TABLE `app_passkeys`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;
ALTER TABLE `app_sync_ops`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=419;
ALTER TABLE `audit_logs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=117;
ALTER TABLE `business_settings`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;
ALTER TABLE `cash_registers`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;
ALTER TABLE `categories`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=61;
ALTER TABLE `clients`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=31;
ALTER TABLE `costs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `crm_messages`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;
ALTER TABLE `crm_tasks`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `customers`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;
ALTER TABLE `daily_closings`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;
ALTER TABLE `daily_costs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=35;
ALTER TABLE `daily_finance_snapshots`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `deleted_activity_log`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `doviz_kurlari`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=28;
ALTER TABLE `doviz_kur_gecmisi`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;
ALTER TABLE `finance_daily_snapshots`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;
ALTER TABLE `fiscal_agents`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `fiscal_agent_pairings`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `fiscal_devices`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
ALTER TABLE `fiscal_device_commands`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `fiscal_device_reports`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `fiscal_device_secrets`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `fiscal_provider_logs`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `fiscal_receipts`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `fiscal_refunds`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `fiscal_refund_items`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `fiscal_transactions`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
ALTER TABLE `fiscal_transaction_events`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;
ALTER TABLE `fiscal_transaction_items`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
ALTER TABLE `inventory_categories`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;
ALTER TABLE `inventory_documents`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=77;
ALTER TABLE `inventory_document_items`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=22;
ALTER TABLE `inventory_items`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=12;
ALTER TABLE `inventory_stock_ledger`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=17;
ALTER TABLE `inventory_units`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;
ALTER TABLE `loyalty_cards`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
ALTER TABLE `loyalty_events`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=8;
ALTER TABLE `loyalty_programs`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
ALTER TABLE `orders`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=943;
ALTER TABLE `order_counters`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `order_delete_logs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `order_items`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1247;
ALTER TABLE `order_item_cancel_events`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=530;
ALTER TABLE `order_payments`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=390;
ALTER TABLE `order_payment_locks`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
ALTER TABLE `pass_remember_tokens`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
ALTER TABLE `payment_delete_logs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `pos_shifts`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;
ALTER TABLE `pos_shift_movements`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `price_change_log`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `pricing_notifications`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `pricing_strategy`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `pricing_suggestions`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;
ALTER TABLE `printers`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7;
ALTER TABLE `print_jobs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=772;
ALTER TABLE `products`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=268;
ALTER TABLE `product_costs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=51;
ALTER TABLE `product_price_history`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
ALTER TABLE `product_stock`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
ALTER TABLE `product_stock_movements`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;
ALTER TABLE `qr_categories`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=35;
ALTER TABLE `qr_login_attempts`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;
ALTER TABLE `qr_products`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=213;
ALTER TABLE `reservations`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;
ALTER TABLE `restaurant_tables`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=64;
ALTER TABLE `stations`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=28;
ALTER TABLE `station_logins`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `station_projection_items`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT;
ALTER TABLE `suppliers`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=8;
ALTER TABLE `table_zones`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7;
ALTER TABLE `users`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=28;
ALTER TABLE `user_permissions`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;
ALTER TABLE `inventory_document_items`
  ADD CONSTRAINT `fk_doc_items_doc` FOREIGN KEY (`document_id`) REFERENCES `inventory_documents` (`id`) ON DELETE CASCADE;

-- ---- view ----
DROP TABLE IF EXISTS `v_valid_orders`;
CREATE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW `v_valid_orders`  AS SELECT `orders`.`id` AS `id`, `orders`.`adisyon_no` AS `adisyon_no`, `orders`.`client_id` AS `client_id`, `orders`.`business_date` AS `business_date`, `orders`.`table_id` AS `table_id`, `orders`.`waiter_id` AS `waiter_id`, `orders`.`status` AS `status`, `orders`.`opened_at` AS `opened_at`, `orders`.`closed_at` AS `closed_at`, `orders`.`closed_by` AS `closed_by`, `orders`.`total` AS `total`, `orders`.`discount_total` AS `discount_total`, `orders`.`vat_total` AS `vat_total`, `orders`.`grand_total` AS `grand_total`, `orders`.`notes` AS `notes`, `orders`.`bill_label` AS `bill_label`, `orders`.`table_session_id` AS `table_session_id`, `orders`.`parent_order_id` AS `parent_order_id`, `orders`.`created_by` AS `created_by`, `orders`.`created_at` AS `created_at`, `orders`.`updated_at` AS `updated_at`, `orders`.`is_closed` AS `is_closed`, `orders`.`exclude_from_reports` AS `exclude_from_reports`, `orders`.`is_deleted` AS `is_deleted` FROM `orders` WHERE `orders`.`exclude_from_reports` = 0 AND `orders`.`total` > 0 AND `orders`.`grand_total` > 0 ;

DELIMITER $$
CREATE PROCEDURE `close_business_day` (IN `p_client_id` INT, IN `p_date` DATE, IN `p_user_id` INT)   BEGIN
    DECLARE v_dummy INT;

    START TRANSACTION;

    /* GUARD 1: day already closed (LOCKED) */
    IF EXISTS (
        SELECT 1
        FROM daily_closings
        WHERE client_id = p_client_id
          AND date = p_date
        FOR UPDATE
    ) THEN
        ROLLBACK;
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Day already closed';
    END IF;

    /* GUARD 2: open orders exist */
    SELECT 1
    INTO v_dummy
    FROM orders
    WHERE client_id = p_client_id
      AND business_date = p_date
      AND status = 'open'
    LIMIT 1
    FOR UPDATE;

    IF v_dummy IS NOT NULL THEN
        ROLLBACK;
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Cannot close day: open orders exist';
    END IF;

    /* CLOSE ORDERS */
    UPDATE orders
    SET status = 'closed',
        is_closed = 1,
        closed_by = p_user_id,
        closed_at = NOW()
    WHERE client_id = p_client_id
      AND business_date = p_date;

    /* INSERT DAILY CLOSING */
    INSERT INTO daily_closings (
        client_id,
        date,
        close_seq,
        declared_cash,
        declared_card,
        cash_difference,
        card_difference,
        closed_by,
        closed_at
    ) VALUES (
        p_client_id,
        p_date,
        1,
        0, 0, 0, 0,
        p_user_id,
        NOW()
    );

    COMMIT;
END$$
DROP TRIGGER IF EXISTS `trg_orders_ai`$$
CREATE TRIGGER `trg_orders_ai` AFTER INSERT ON `orders` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (NEW.client_id, 'order', NEW.id, NEW.id, 'ins');
END
$$
DROP TRIGGER IF EXISTS `trg_orders_au`$$
CREATE TRIGGER `trg_orders_au` AFTER UPDATE ON `orders` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (NEW.client_id, 'order', NEW.id, NEW.id, 'upd');
END
$$
DROP TRIGGER IF EXISTS `trg_audit_bill_delete`$$
CREATE TRIGGER `trg_audit_bill_delete` AFTER INSERT ON `order_delete_logs` FOR EACH ROW BEGIN
    INSERT INTO audit_logs
    (
        client_id,
        actor_client_id,
        role,
        action,
        entity_type,
        entity_id,
        before_json,
        ip,
        user_agent,
        created_at
    )
    VALUES
    (
        NEW.client_id,
        NEW.deleted_by,
        'cashier',
        'bill.delete',
        'bill',
        NEW.order_id,
        NEW.original_data,
        NEW.ip_address,
        NEW.user_agent,
        NEW.deleted_at
    );
END
$$
DROP TRIGGER IF EXISTS `ai_order_items_vat`$$
CREATE TRIGGER `ai_order_items_vat` AFTER INSERT ON `order_items` FOR EACH ROW BEGIN
    UPDATE orders
    SET vat_total = (
        SELECT COALESCE(SUM(vat_total),0)
        FROM order_items
        WHERE order_id = NEW.order_id
          AND client_id = NEW.client_id
    )
    WHERE id = NEW.order_id
      AND client_id = NEW.client_id;
END
$$
DROP TRIGGER IF EXISTS `bi_order_items_vat`$$
CREATE TRIGGER `bi_order_items_vat` BEFORE INSERT ON `order_items` FOR EACH ROW BEGIN
    DECLARE v_vat_rate DECIMAL(5,2) DEFAULT 0;
    DECLARE v_gross DECIMAL(10,2) DEFAULT 0;
    DECLARE v_vat DECIMAL(10,2) DEFAULT 0;

    -- Read VAT rate from product (tenant-safe)
    SELECT vat_rate
      INTO v_vat_rate
      FROM products
     WHERE id = NEW.product_id
       AND client_id = NEW.client_id
     LIMIT 1;

    SET NEW.vat_rate = IFNULL(v_vat_rate, 0);

    SET v_gross = NEW.qty * NEW.unit_price;

    IF NEW.vat_rate > 0 THEN
        SET v_vat = ROUND((v_gross * NEW.vat_rate) / (100 + NEW.vat_rate), 2);
    ELSE
        SET v_vat = 0;
    END IF;

    SET NEW.vat_total = v_vat;
END
$$
DROP TRIGGER IF EXISTS `bu_order_items_vat`$$
CREATE TRIGGER `bu_order_items_vat` BEFORE UPDATE ON `order_items` FOR EACH ROW BEGIN
    DECLARE v_gross DECIMAL(10,2) DEFAULT 0;
    DECLARE v_vat DECIMAL(10,2) DEFAULT 0;

    SET v_gross = NEW.qty * NEW.unit_price;

    IF NEW.vat_rate > 0 THEN
        SET v_vat = ROUND((v_gross * NEW.vat_rate) / (100 + NEW.vat_rate), 2);
    ELSE
        SET v_vat = 0;
    END IF;

    SET NEW.vat_total = v_vat;
END
$$
DROP TRIGGER IF EXISTS `trg_items_ad`$$
CREATE TRIGGER `trg_items_ad` AFTER DELETE ON `order_items` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (OLD.client_id, 'order_item', OLD.id, OLD.order_id, 'del');
END
$$
DROP TRIGGER IF EXISTS `trg_items_ai`$$
CREATE TRIGGER `trg_items_ai` AFTER INSERT ON `order_items` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (NEW.client_id, 'order_item', NEW.id, NEW.order_id, 'ins');
END
$$
DROP TRIGGER IF EXISTS `trg_items_au`$$
CREATE TRIGGER `trg_items_au` AFTER UPDATE ON `order_items` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (NEW.client_id, 'order_item', NEW.id, NEW.order_id, 'upd');
END
$$
DROP TRIGGER IF EXISTS `trg_order_items_before_delete`$$
CREATE TRIGGER `trg_order_items_before_delete` BEFORE DELETE ON `order_items` FOR EACH ROW BEGIN
  INSERT INTO order_item_cancel_events
    (client_id, order_id, product_id, qty, line_total, vat_total, vat_rate, cancelled_at)
  VALUES
    (OLD.client_id, OLD.order_id, OLD.product_id, OLD.qty,
     OLD.line_total, OLD.vat_total, OLD.vat_rate, NOW());
END
$$
DROP TRIGGER IF EXISTS `trg_order_items_set_station`$$
CREATE TRIGGER `trg_order_items_set_station` BEFORE INSERT ON `order_items` FOR EACH ROW BEGIN
  IF NEW.station_id IS NULL THEN
    SET NEW.station_id = (
      SELECT c.station_id
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.id = NEW.product_id
      LIMIT 1
    );
    SET NEW.station_status = 'new';
    SET NEW.station_updated_at = NOW();
  END IF;
END
$$
DROP TRIGGER IF EXISTS `trg_orders_vat_ad`$$
CREATE TRIGGER `trg_orders_vat_ad` AFTER DELETE ON `order_items` FOR EACH ROW BEGIN
  UPDATE orders
  SET vat_total = (
    SELECT ROUND(COALESCE(SUM(vat_total),0), 2)
    FROM order_items
    WHERE order_id = OLD.order_id
      AND client_id = OLD.client_id
  )
  WHERE id = OLD.order_id
    AND client_id = OLD.client_id;
END
$$
DROP TRIGGER IF EXISTS `trg_orders_vat_after_item_update`$$
CREATE TRIGGER `trg_orders_vat_after_item_update` AFTER UPDATE ON `order_items` FOR EACH ROW BEGIN
  UPDATE orders o
  SET o.vat_total = (
    SELECT COALESCE(ROUND(SUM(oi.vat_total), 2), 0)
    FROM order_items oi
    WHERE oi.order_id = o.id
      AND oi.client_id = o.client_id
  )
  WHERE o.id = NEW.order_id
    AND o.client_id = NEW.client_id;
END
$$
DROP TRIGGER IF EXISTS `trg_pay_ad`$$
CREATE TRIGGER `trg_pay_ad` AFTER DELETE ON `order_payments` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (OLD.client_id, 'payment', OLD.id, OLD.order_id, 'del');
END
$$
DROP TRIGGER IF EXISTS `trg_pay_ai`$$
CREATE TRIGGER `trg_pay_ai` AFTER INSERT ON `order_payments` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (NEW.client_id, 'payment', NEW.id, NEW.order_id, 'ins');
END
$$
DROP TRIGGER IF EXISTS `trg_pay_au`$$
CREATE TRIGGER `trg_pay_au` AFTER UPDATE ON `order_payments` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, order_id, op)
  VALUES (NEW.client_id, 'payment', NEW.id, NEW.order_id, 'upd');
END
$$
DROP TRIGGER IF EXISTS `trg_audit_payment_delete`$$
CREATE TRIGGER `trg_audit_payment_delete` AFTER INSERT ON `payment_delete_logs` FOR EACH ROW BEGIN
    DECLARE v_client_id INT DEFAULT NULL;

    SELECT client_id
      INTO v_client_id
      FROM users
     WHERE id = NEW.deleted_by
     LIMIT 1;

    INSERT INTO audit_logs
    (
        client_id,
        actor_client_id,
        role,
        action,
        entity_type,
        entity_id,
        before_json,
        ip,
        user_agent,
        created_at
    )
    VALUES
    (
        v_client_id,
        NEW.deleted_by,
        'cashier',
        'payment.delete',
        'payment',
        NEW.payment_id,
        NEW.original_data,
        NEW.ip_address,
        NEW.user_agent,
        NEW.deleted_at
    );
END
$$
DROP TRIGGER IF EXISTS `trg_products_ai`$$
CREATE TRIGGER `trg_products_ai` AFTER INSERT ON `products` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, op)
  VALUES (NEW.client_id, 'product', NEW.id, 'ins');
END
$$
DROP TRIGGER IF EXISTS `trg_products_au`$$
CREATE TRIGGER `trg_products_au` AFTER UPDATE ON `products` FOR EACH ROW BEGIN
  INSERT INTO app_change_log (client_id, entity, entity_id, op)
  VALUES (NEW.client_id, 'product', NEW.id, 'upd');
END
$$
DELIMITER ;
SET FOREIGN_KEY_CHECKS = 1;