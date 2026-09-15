-- =====================================================================
--  NOKTApp POS - LOCAL ADJUSTMENTS
--  The production schema came from a multi-tenant web app where the PHP
--  layer always supplied every column. On the desktop the service writes
--  these tables directly, so a few columns need sane defaults and a few
--  tables need the unique keys the upsert logic depends on.
--  Safe to re-run: every statement is idempotent.
-- =====================================================================
SET NAMES utf8mb4;

-- 1) clients: allow a partial row to be written from the licence response
ALTER TABLE `clients`
  MODIFY `slug`            varchar(100)  NOT NULL DEFAULT '',
  MODIFY `owner_name`      varchar(255)  NOT NULL DEFAULT '',
  MODIFY `company_name`    varchar(255)  NOT NULL DEFAULT '',
  MODIFY `full_address`    text          DEFAULT NULL,
  MODIFY `permanent_email` varchar(255)  NOT NULL DEFAULT '',
  MODIFY `username`        varchar(255)  NOT NULL DEFAULT '',
  MODIFY `password_hash`   char(60)      NOT NULL DEFAULT '',
  MODIFY `pin_hash`        varchar(255)  DEFAULT NULL,
  MODIFY `tax_number`      varchar(100)  NOT NULL DEFAULT '',
  MODIFY `tax_office`      varchar(255)  NOT NULL DEFAULT '',
  MODIFY `phone`           varchar(50)   NOT NULL DEFAULT '',
  MODIFY `contact_name`    varchar(255)  NOT NULL DEFAULT '',
  MODIFY `contact_email`   varchar(255)  NOT NULL DEFAULT '',
  MODIFY `contact_phone`   varchar(50)   NOT NULL DEFAULT '';

-- 2) unique keys the desktop upserts rely on
ALTER TABLE `product_stock`            ADD UNIQUE KEY `uq_client_product` (`client_id`,`product_id`);
ALTER TABLE `finance_daily_snapshots`  ADD UNIQUE KEY `uq_client_date` (`client_id`,`date`);
ALTER TABLE `order_counters`           ADD UNIQUE KEY `uq_client` (`client_id`);
ALTER TABLE `daily_finance_snapshots`  ADD UNIQUE KEY `uq_client_date` (`client_id`,`date`);

-- 3) orders: a bill without a table and a bill without a waiter are both real
--    "Hizli satis" (takeaway at the counter) has no table, and an owner logged
--    in on the licence rather than as a staff member has no waiter id. Both
--    columns arrived NOT NULL from the web app, where PHP always passed
--    something, so on the desktop the till answered "Column 'table_id' cannot
--    be null" and simply would not open the bill.
ALTER TABLE `orders`
  MODIFY `table_id`  int(11) DEFAULT NULL,
  MODIFY `waiter_id` int(11) DEFAULT NULL;

-- 4) pricing_strategy.set_by is written by a background job on the web app
ALTER TABLE `pricing_strategy` MODIFY `set_by` int(10) NOT NULL DEFAULT 0;

-- 5) indexes that matter once a busy restaurant has a year of history locally
ALTER TABLE `orders`        ADD KEY `ix_local_day_status` (`client_id`,`business_date`,`status`,`is_deleted`);
ALTER TABLE `order_items`   ADD KEY `ix_local_order` (`order_id`,`is_deleted`);
ALTER TABLE `order_payments`ADD KEY `ix_local_shift` (`client_id`,`shift_id`,`is_deleted`);
ALTER TABLE `print_jobs`    ADD KEY `ix_local_status` (`status`,`id`);
