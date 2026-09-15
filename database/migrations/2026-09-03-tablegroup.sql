-- ---------------------------------------------------------------------------
-- MASA BIRLESTIRME - birden fazla masa, tek adisyon.
--
-- The product already had two things that LOOK like this and are not:
--
--   * bill_label (A / B / C) puts SEVERAL bills on ONE table - the opposite
--     problem. A family that pushes masa 4, 5 and 6 together is one party with
--     one bill, not three parties on one table.
--   * transferTable MOVES a bill from one table to another. The tables the
--     staff pushed together stay pushed together; moving the bill to masa 5
--     just makes masa 4 look free while six people are sitting at it.
--
-- So the join needs a record of its own. `orders.table_session_id` has existed
-- unused since the PHP days and is exactly the right shape for it: it now
-- points at the group the bill belongs to, so the bill knows its group and the
-- group's tables are found from the members table.
--
-- Nothing is ever hard-deleted: a table that leaves a group keeps its row with
-- left_at set, so "who put masa 7 into that group and when did it come out"
-- has an answer the morning after.
--
-- Re-running this is harmless; every statement is guarded.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `table_groups` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `primary_table_id` int(10) unsigned NOT NULL
    COMMENT 'grubun ana masasi - adisyon bu masada durur, dagitilinca burada kalir',
  `business_date` date NOT NULL,
  `status` enum('open','closed') NOT NULL DEFAULT 'open',
  `note` varchar(190) DEFAULT NULL,
  `opened_at` datetime NOT NULL DEFAULT current_timestamp(),
  `opened_by` int(11) DEFAULT NULL,
  `closed_at` datetime DEFAULT NULL,
  `closed_by` int(11) DEFAULT NULL,
  `closed_reason` varchar(40) DEFAULT NULL COMMENT 'hesap_kapandi | dagitildi | son_masa',
  PRIMARY KEY (`id`),
  KEY `idx_tg_client_status` (`client_id`,`status`,`id`),
  KEY `idx_tg_client_day` (`client_id`,`business_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

CREATE TABLE IF NOT EXISTS `table_group_members` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `group_id` int(10) unsigned NOT NULL,
  `table_id` int(10) unsigned NOT NULL,
  `joined_at` datetime NOT NULL DEFAULT current_timestamp(),
  `joined_by` int(11) DEFAULT NULL,
  `left_at` datetime DEFAULT NULL COMMENT 'NULL ise masa hala grupta',
  `left_by` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  -- one row per table per group: a table taken out and put back in the SAME
  -- group reuses its row rather than growing a second live one
  UNIQUE KEY `uq_tgm_group_table` (`group_id`,`table_id`),
  KEY `idx_tgm_client_table` (`client_id`,`table_id`,`left_at`),
  KEY `idx_tgm_group` (`group_id`,`left_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

-- The column already existed and nothing wrote to it. It now carries the group
-- a bill belongs to, so every reader of a bill - the till, the kitchen slip,
-- the printed hesap - can say "Masa 4+5+6" instead of "Masa 4".
ALTER TABLE `orders`
  ADD KEY IF NOT EXISTS `idx_orders_table_session` (`client_id`,`table_session_id`,`status`);
