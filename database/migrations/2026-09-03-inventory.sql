-- ---------------------------------------------------------------------------
-- STOK / DEPO - the tables the old system never had.
--
-- The PHP had two stock universes that never met: `inventory_items` (raw
-- materials, filled by purchase documents) and `products` (menu items, whose
-- `product_stock` row was written by five files and read by none). Selling a
-- pide never consumed a gram of flour because nothing said a pide contains
-- flour. Everything below exists to close that hole, and to give sayim, zayi
-- and depo transfers a real home instead of the enum values nobody wrote.
--
-- Re-running this is harmless: every statement carries IF NOT EXISTS.
-- ---------------------------------------------------------------------------

-- THE MISSING LINK. One row per raw material in a menu product.
-- qty_per_unit is expressed in the item's own unit (inventory_items.unit), so
-- 0.3 kg of flour in one pide is qty_per_unit=0.3000 on a kg item.
CREATE TABLE IF NOT EXISTS `product_recipes` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `product_id` int(11) NOT NULL,
  `inventory_item_id` int(11) NOT NULL,
  `qty_per_unit` decimal(12,4) NOT NULL DEFAULT 0.0000,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_recipe_line` (`client_id`,`product_id`,`inventory_item_id`),
  KEY `idx_recipe_product` (`client_id`,`product_id`),
  KEY `idx_recipe_item` (`client_id`,`inventory_item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Depots. The old schema had exactly one implicit location, so a transfer had
-- nowhere to go. NULL location on a ledger row means "the default depot"; the
-- rows written before this migration existed keep meaning what they meant.
CREATE TABLE IF NOT EXISTS `inventory_locations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `name` varchar(100) NOT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_location_name` (`client_id`,`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Sayim. A count is a session: you freeze what the ledger says (expected),
-- type what is on the shelf (counted), and approving it writes the difference
-- to the ledger as an adjustment. A draft count moves nothing - that is the
-- whole point of the defect this replaces, where a draft purchase already had.
CREATE TABLE IF NOT EXISTS `inventory_counts` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `location_id` int(11) DEFAULT NULL,
  `count_date` date NOT NULL,
  `status` enum('draft','approved','cancelled') NOT NULL DEFAULT 'draft',
  `note` varchar(255) DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `approved_by` int(11) DEFAULT NULL,
  `approved_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_count_client` (`client_id`,`count_date`),
  KEY `idx_count_status` (`client_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `inventory_count_items` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `count_id` int(11) NOT NULL,
  `item_id` int(11) NOT NULL,
  `expected_qty` decimal(12,3) NOT NULL DEFAULT 0.000,
  `counted_qty` decimal(12,3) NOT NULL DEFAULT 0.000,
  `variance` decimal(12,3) NOT NULL DEFAULT 0.000,
  `unit_cost` decimal(12,4) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_count_item` (`count_id`,`item_id`),
  KEY `idx_count_item` (`item_id`),
  CONSTRAINT `fk_count_items_count` FOREIGN KEY (`count_id`)
    REFERENCES `inventory_counts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Zayi. Waste always carries a reason: "it went off" and "it was dropped" and
-- "the kitchen burnt it" are three different management problems, and a stock
-- figure that hides which one happened is worth very little.
CREATE TABLE IF NOT EXISTS `inventory_waste` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `item_id` int(11) NOT NULL,
  `location_id` int(11) DEFAULT NULL,
  `quantity` decimal(12,3) NOT NULL,
  `reason` varchar(32) NOT NULL,
  `note` varchar(255) DEFAULT NULL,
  `unit_cost` decimal(12,4) DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_waste_client` (`client_id`,`created_at`),
  KEY `idx_waste_item` (`client_id`,`item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS `inventory_transfers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `item_id` int(11) NOT NULL,
  `from_location_id` int(11) NOT NULL,
  `to_location_id` int(11) NOT NULL,
  `quantity` decimal(12,3) NOT NULL,
  `note` varchar(255) DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_transfer_client` (`client_id`,`created_at`),
  KEY `idx_transfer_item` (`client_id`,`item_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- The ledger becomes the ONE source of truth, so it has to be able to say what
-- every movement was. 'count', 'waste' and 'transfer' are new; 'sale' finally
-- gets written by something. `order_id` and `note` let a movement be traced
-- back to the bill or the reason that caused it, and `location_id` lets a
-- transfer be two rows that net to zero.
ALTER TABLE `inventory_stock_ledger`
  MODIFY `source_type` enum('document','sale','adjustment','count','waste','transfer') NOT NULL,
  ADD COLUMN IF NOT EXISTS `location_id` int(11) DEFAULT NULL AFTER `source_id`,
  ADD COLUMN IF NOT EXISTS `order_id` int(11) DEFAULT NULL AFTER `location_id`,
  ADD COLUMN IF NOT EXISTS `note` varchar(255) DEFAULT NULL AFTER `unit_cost`,
  ADD COLUMN IF NOT EXISTS `created_by` int(11) DEFAULT NULL AFTER `note`;

ALTER TABLE `inventory_stock_ledger`
  ADD KEY IF NOT EXISTS `idx_ledger_order` (`client_id`,`order_id`);

-- Kritik stok. The old dashboard let you type a minimum into a filter box and
-- forgot it on the next page load; a reorder level belongs on the item.
ALTER TABLE `inventory_items`
  ADD COLUMN IF NOT EXISTS `min_qty` decimal(12,3) NOT NULL DEFAULT 0.000 AFTER `category_id`,
  ADD COLUMN IF NOT EXISTS `updated_at` datetime DEFAULT NULL;

-- The purchase document gains a note field; a delivery that was short by two
-- crates is a fact somebody needs to read next week.
ALTER TABLE `inventory_documents`
  ADD COLUMN IF NOT EXISTS `note` varchar(255) DEFAULT NULL AFTER `file_path`,
  ADD COLUMN IF NOT EXISTS `location_id` int(11) DEFAULT NULL AFTER `supplier_id`;
