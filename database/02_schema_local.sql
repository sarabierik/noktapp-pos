-- =====================================================================
--  NOKTApp POS - LOCAL-ONLY TABLES
--  These exist only on the restaurant PC. They are not part of the
--  original pos.noktapp.com schema; they carry licence, device, sync,
--  backup, mail and mobile-pairing state for the desktop product.
-- =====================================================================
SET NAMES utf8mb4;

-- Key/value store for machine-level settings (device id, panel url, ports...)
DROP TABLE IF EXISTS `np_settings`;
CREATE TABLE `np_settings` (
  `k` varchar(64) NOT NULL,
  `v` mediumtext DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cached licence answer from the cloud panel; allows offline grace period
DROP TABLE IF EXISTS `np_licence`;
CREATE TABLE `np_licence` (
  `id` tinyint(4) NOT NULL DEFAULT 1,
  `client_id` int(11) NOT NULL,
  `company_name` varchar(255) DEFAULT NULL,
  `licence_key` varchar(64) NOT NULL,
  `plan_name` varchar(64) DEFAULT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'active',
  `seats` int(11) NOT NULL DEFAULT 1,
  `features` mediumtext DEFAULT NULL,
  `expires_at` datetime DEFAULT NULL,
  `grace_days` smallint(6) NOT NULL DEFAULT 7,
  `last_check_at` datetime DEFAULT NULL,
  `last_ok_at` datetime DEFAULT NULL,
  `signature` varchar(512) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cached cloud credentials so staff can log in with no internet
DROP TABLE IF EXISTS `np_login_cache`;
CREATE TABLE `np_login_cache` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `email` varchar(190) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `display_name` varchar(120) DEFAULT NULL,
  `role` varchar(32) NOT NULL DEFAULT 'admin',
  `user_ref` int(11) DEFAULT NULL,
  `cached_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_email` (`client_id`,`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Outbox: every local change that must reach the cloud (reporting/backup)
DROP TABLE IF EXISTS `np_sync_outbox`;
CREATE TABLE `np_sync_outbox` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `entity` varchar(48) NOT NULL,
  `entity_id` varchar(64) NOT NULL,
  `op` varchar(12) NOT NULL DEFAULT 'upsert',
  `payload` longtext DEFAULT NULL,
  `status` enum('pending','sent','failed') NOT NULL DEFAULT 'pending',
  `attempts` smallint(6) NOT NULL DEFAULT 0,
  `last_error` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `sent_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_status` (`status`,`id`),
  KEY `ix_entity` (`entity`,`entity_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backup log (local snapshots + cloud uploads)
DROP TABLE IF EXISTS `np_backups`;
CREATE TABLE `np_backups` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `kind` enum('local','cloud','manual') NOT NULL DEFAULT 'local',
  `file_path` varchar(255) DEFAULT NULL,
  `size_bytes` bigint(20) DEFAULT NULL,
  `sha256` char(64) DEFAULT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'ok',
  `message` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `ix_kind` (`kind`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Outgoing mail queue (mail-the-bill from the till or the phone app)
DROP TABLE IF EXISTS `np_mail_queue`;
CREATE TABLE `np_mail_queue` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `order_id` int(11) DEFAULT NULL,
  `to_email` varchar(190) NOT NULL,
  `subject` varchar(255) NOT NULL,
  `body_html` mediumtext DEFAULT NULL,
  `pdf_path` varchar(255) DEFAULT NULL,
  `status` enum('pending','sent','failed') NOT NULL DEFAULT 'pending',
  `attempts` smallint(6) NOT NULL DEFAULT 0,
  `last_error` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `sent_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_status` (`status`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mobile devices paired to THIS pc (LAN pairing codes)
DROP TABLE IF EXISTS `np_mobile_pairings`;
CREATE TABLE `np_mobile_pairings` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `pair_code` char(6) NOT NULL,
  `qr_token` char(32) DEFAULT NULL,
  `device_id` varchar(64) DEFAULT NULL,
  `device_name` varchar(120) DEFAULT NULL,
  `platform` varchar(16) DEFAULT NULL,
  `user_id` int(11) DEFAULT NULL,
  `for_user_id` int(11) DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  `used_at` datetime DEFAULT NULL,
  `redeemed_by` varchar(8) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_code` (`pair_code`),
  UNIQUE KEY `uq_qr_token` (`qr_token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Relay cursor: last cloud-relay message consumed by this PC
DROP TABLE IF EXISTS `np_relay_state`;
CREATE TABLE `np_relay_state` (
  `id` tinyint(4) NOT NULL DEFAULT 1,
  `last_msg_id` bigint(20) NOT NULL DEFAULT 0,
  `last_poll_at` datetime DEFAULT NULL,
  `consecutive_errors` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Application/update/service log kept on the PC for support
DROP TABLE IF EXISTS `np_app_log`;
CREATE TABLE `np_app_log` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `level` varchar(10) NOT NULL DEFAULT 'info',
  `area` varchar(32) NOT NULL DEFAULT 'app',
  `message` varchar(500) NOT NULL,
  `detail` mediumtext DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `ix_area` (`area`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Customer-display / second monitor configuration
DROP TABLE IF EXISTS `np_display_settings`;
CREATE TABLE `np_display_settings` (
  `id` tinyint(4) NOT NULL DEFAULT 1,
  `template` varchar(32) NOT NULL DEFAULT 'marka',
  `headline` varchar(120) DEFAULT NULL,
  `subline` varchar(200) DEFAULT NULL,
  `media_path` varchar(255) DEFAULT NULL,
  `show_logo` tinyint(1) NOT NULL DEFAULT 1,
  `enabled` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
