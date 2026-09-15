-- =====================================================================
--  NOKTApp POS - CLOUD PANEL SCHEMA  (pos.noktapp.com)
--  Everything here is about tenants, licences, backups and the relay.
--  No restaurant operating data is stored: that lives on their own PC.
-- =====================================================================
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `np_tenants` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `code` varchar(32) NOT NULL,
  `company_name` varchar(255) NOT NULL,
  `owner_name` varchar(255) DEFAULT NULL,
  `email` varchar(190) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `tax_number` varchar(50) DEFAULT NULL,
  `tax_office` varchar(120) DEFAULT NULL,
  `address` text DEFAULT NULL,
  `city` varchar(80) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `notes` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_email` (`email`),
  UNIQUE KEY `uq_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_licences` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `licence_key` varchar(64) NOT NULL,
  `plan` varchar(64) NOT NULL DEFAULT 'standart',
  `status` enum('active','suspended','expired','trial') NOT NULL DEFAULT 'trial',
  `seats` int(11) NOT NULL DEFAULT 1,
  `features` text DEFAULT NULL,
  `starts_at` date DEFAULT NULL,
  `expires_at` datetime DEFAULT NULL,
  `grace_days` smallint(6) NOT NULL DEFAULT 7,
  `price` decimal(10,2) DEFAULT NULL,
  `billing_period` varchar(16) DEFAULT 'yearly',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_key` (`licence_key`),
  KEY `ix_tenant` (`tenant_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_devices` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `device_id` varchar(64) NOT NULL,
  `device_name` varchar(160) DEFAULT NULL,
  `app_version` varchar(32) DEFAULT NULL,
  `os` varchar(64) DEFAULT NULL,
  `last_ip` varchar(64) DEFAULT NULL,
  `last_seen_at` datetime DEFAULT NULL,
  `first_seen_at` datetime NOT NULL DEFAULT current_timestamp(),
  `is_blocked` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_device` (`tenant_id`,`device_id`),
  KEY `ix_seen` (`last_seen_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_backups` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `device_id` varchar(64) DEFAULT NULL,
  `filename` varchar(190) NOT NULL,
  `path` varchar(255) NOT NULL,
  `size_bytes` bigint(20) NOT NULL DEFAULT 0,
  `sha256` char(64) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `ix_tenant` (`tenant_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- what the owner sees from outside: the numbers the PC pushed up
CREATE TABLE IF NOT EXISTS `np_reports` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `entity` varchar(48) NOT NULL,
  `entity_id` varchar(64) NOT NULL,
  `payload` longtext DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_entity` (`tenant_id`,`entity`,`entity_id`),
  KEY `ix_tenant` (`tenant_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- the relay: a phone posts a request here, the restaurant PC picks it up
CREATE TABLE IF NOT EXISTS `np_relay_messages` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `method` varchar(8) NOT NULL DEFAULT 'GET',
  `path` varchar(255) NOT NULL,
  `body` longtext DEFAULT NULL,
  `authorization` varchar(512) DEFAULT NULL,
  `device_id` varchar(64) DEFAULT NULL,
  `status` enum('queued','taken','answered','expired') NOT NULL DEFAULT 'queued',
  `answer_status` int(11) DEFAULT NULL,
  `answer_body` longtext DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `taken_at` datetime DEFAULT NULL,
  `answered_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_queue` (`tenant_id`,`status`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_versions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `version` varchar(32) NOT NULL,
  `channel` varchar(16) NOT NULL DEFAULT 'stable',
  `filename` varchar(190) NOT NULL,
  `size_bytes` bigint(20) NOT NULL DEFAULT 0,
  `sha512` text DEFAULT NULL,
  `release_notes` text DEFAULT NULL,
  `is_current` tinyint(1) NOT NULL DEFAULT 0,
  `released_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_version` (`version`,`channel`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_admins` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `email` varchar(190) NOT NULL,
  `name` varchar(120) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `last_login_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_audit` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `actor` varchar(120) DEFAULT NULL,
  `action` varchar(64) NOT NULL,
  `subject` varchar(120) DEFAULT NULL,
  `detail` text DEFAULT NULL,
  `ip` varchar(64) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `ix_when` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- the published QR menu, pushed up by each restaurant
CREATE TABLE IF NOT EXISTS `np_qr_menus` (
  `tenant_id` int(11) NOT NULL,
  `slug` varchar(120) NOT NULL,
  `payload` longtext NOT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`tenant_id`),
  UNIQUE KEY `uq_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_login_attempts` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `email` varchar(190) DEFAULT NULL,
  `ip` varchar(64) DEFAULT NULL,
  `ok` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `ix_ip` (`ip`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
