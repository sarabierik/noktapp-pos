-- =====================================================================
--  NOKTApp POS - CHAIN (multi-branch) LAYER
--
--  A customer with ten branches runs ten independent installs today: ten
--  menus, ten price lists, and no way for head office to change a price once
--  or to see which branch has drifted. These tables are the head-office half
--  of closing that gap. The panel holds the master menu; every till PULLS a
--  published version of it. The panel never pushes, because a branch behind a
--  hotel NAT or switched off on a Monday must still be able to catch up when
--  it comes back.
--
--  Everything here is ADDITIVE and guarded. A tenant with one branch (which
--  is nearly all of them) has no rows in any of these tables, and the panel
--  keeps behaving exactly as it did before this file was applied. Run it as
--  many times as you like:
--
--    mysql ... nokpos_panel < sql/chain_schema.sql
--
--  Nothing here is restaurant operating data. Tables, staff, stock, printers
--  and shifts are facts about a building and stay on the building's own PC.
-- =====================================================================
SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- 1. Branch identity
--
-- np_devices is a list of machines with no idea which restaurant they sit
-- in. This is the restaurant. `code` is short and human because head office
-- reads it out to the branch over the phone ("MERKEZ", "AIRPORT").
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `np_branches` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `code` varchar(32) NOT NULL,
  `name` varchar(160) NOT NULL,
  `city` varchar(80) DEFAULT NULL,
  `address` text DEFAULT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  -- what menu-ack.php last heard back from this branch's tills; this is the
  -- column an area manager reads to see who is still on last week's prices
  `menu_version` int(11) NOT NULL DEFAULT 0,
  `menu_applied_at` datetime DEFAULT NULL,
  `menu_counts` varchar(160) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_branch_code` (`tenant_id`,`code`),
  KEY `ix_tenant` (`tenant_id`,`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A device binds to exactly one branch; a branch may hold several devices (a
-- till and a bar station). NULL means single-shop mode, which is the state
-- every existing install is already in.
ALTER TABLE `np_devices` ADD COLUMN IF NOT EXISTS `branch_id` int(11) DEFAULT NULL;
ALTER TABLE `np_devices` ADD KEY IF NOT EXISTS `ix_branch` (`branch_id`);

-- ---------------------------------------------------------------------
-- 2. Master menu
--
-- Mirrors the local shapes but must never be confused with them: a branch's
-- local products.id has nothing to do with the id here. `master_code` is the
-- only identity that crosses the wire, so a rename at head office updates
-- the branch's row in place and every historical order line, recipe and
-- stock movement keeps pointing at the same row.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `np_menu_categories` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `master_code` varchar(64) NOT NULL,
  `name` varchar(160) NOT NULL,
  `station_hint` varchar(64) DEFAULT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `use_in_pos` tinyint(1) NOT NULL DEFAULT 1,
  `use_in_qr` tinyint(1) NOT NULL DEFAULT 1,
  -- default posture is everything central, nothing overridable: a chain that
  -- wants uniformity never touches the exception screen and gets uniformity
  `price_locked` tinyint(1) NOT NULL DEFAULT 1,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_master` (`tenant_id`,`master_code`),
  KEY `ix_order` (`tenant_id`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_menu_products` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `master_code` varchar(64) NOT NULL,
  `category_id` int(11) DEFAULT NULL,
  `name` varchar(190) NOT NULL,
  `description` text DEFAULT NULL,
  `price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `cost_price` decimal(10,2) DEFAULT NULL,
  `vat_rate` decimal(5,2) NOT NULL DEFAULT 10.00,
  `track_stock` tinyint(1) NOT NULL DEFAULT 0,
  `use_in_pos` tinyint(1) NOT NULL DEFAULT 1,
  `use_in_qr` tinyint(1) NOT NULL DEFAULT 1,
  `image_url` varchar(255) DEFAULT NULL,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `price_locked` tinyint(1) NOT NULL DEFAULT 1,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_master` (`tenant_id`,`master_code`),
  KEY `ix_cat` (`tenant_id`,`category_id`),
  KEY `ix_order` (`tenant_id`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Editing the rows above changes NOTHING at any branch. Pressing Yayınla
-- mints a row here and freezes the current state as that version. Branches
-- only ever pull a published version, so half-finished edits cannot reach
-- ten tills in the middle of service.
CREATE TABLE IF NOT EXISTS `np_menu_versions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `version` int(11) NOT NULL,
  `note` varchar(255) DEFAULT NULL,
  `published_at` datetime NOT NULL DEFAULT current_timestamp(),
  `published_by` varchar(120) DEFAULT NULL,
  `product_count` int(11) NOT NULL DEFAULT 0,
  `category_count` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_version` (`tenant_id`,`version`),
  KEY `ix_tenant` (`tenant_id`,`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The frozen state of one published version, one row per menu row.
--
-- This table is what makes `since=<n>` answerable and what makes "editing
-- after publishing changes nothing at a branch" true rather than hopeful.
-- Diffing live rows against a timestamp cannot do either: it would leak an
-- unpublished edit the moment a till asked, and it could not tell a till that
-- has been dark for three versions what actually changed underneath it.
-- `row_hash` over the frozen payload is the whole diff engine.
CREATE TABLE IF NOT EXISTS `np_menu_version_items` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `version_id` int(11) NOT NULL,
  `version` int(11) NOT NULL,
  `entity` enum('category','product') NOT NULL,
  `master_code` varchar(64) NOT NULL,
  `payload` longtext NOT NULL,
  `row_hash` char(40) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_item` (`tenant_id`,`version_id`,`entity`,`master_code`),
  KEY `ix_version` (`tenant_id`,`version`,`entity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 4. Exceptions
--
-- Not versioned on purpose. An override is a standing local fact ("no pizza
-- oven at Gazipaşa"), not part of the house menu, so it reaches its branch on
-- the very next pull instead of waiting for the next Yayınla. It is also the
-- only per-branch row in this file: everything else is the same for everyone.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `np_branch_overrides` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `branch_id` int(11) NOT NULL,
  `entity` enum('product','category') NOT NULL,
  `master_code` varchar(64) NOT NULL,
  `available` tinyint(1) DEFAULT NULL,
  `price` decimal(10,2) DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `updated_by` varchar(120) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_override` (`tenant_id`,`branch_id`,`entity`,`master_code`),
  KEY `ix_branch` (`tenant_id`,`branch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
