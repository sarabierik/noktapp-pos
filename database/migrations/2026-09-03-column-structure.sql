-- =====================================================================
--  Columns the desktop cannot fill.
--
--  The schema came from the multi-tenant web app, where a PHP layer sat in
--  front of every write and always passed SOMETHING. On the desktop the
--  service writes these tables directly, so every NOT NULL column with no
--  default is a landmine that goes off in front of a customer:
--
--      Column 'order_id' cannot be null
--
--  is what a restaurant saw on its bill screen when it printed a Z report -
--  a report has no order, and never did.
--
--  Every change here is either "this column is genuinely optional on a till"
--  or "this value is unknown when nobody is signed in". Nothing that carries
--  money is loosened. Safe to re-run.
-- =====================================================================
SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- 1) print_jobs: not every print job belongs to a bill
--    A Z report, an X report, a cash-drawer pulse and a printer test all
--    have no order. The column was NOT NULL and the enum had only the two
--    values the web app used, so all four failed.
-- ---------------------------------------------------------------------
ALTER TABLE `print_jobs`
  MODIFY `order_id` int(11) DEFAULT NULL,
  MODIFY `job_type` enum('order','receipt','report','drawer','test') NOT NULL DEFAULT 'order';

-- ---------------------------------------------------------------------
-- 2) "who did this" columns. On a till the answer is sometimes nobody:
--    the owner is signed in on the licence rather than as a staff member,
--    or the write is a background job. 0 means "not a person", which is
--    honest; refusing the write is not.
-- ---------------------------------------------------------------------
ALTER TABLE `order_delete_logs`
  MODIFY `deleted_by` int(11) NOT NULL DEFAULT 0,
  MODIFY `reason`     varchar(255) NOT NULL DEFAULT '';
ALTER TABLE `payment_delete_logs`  MODIFY `deleted_by` int(11) NOT NULL DEFAULT 0;
ALTER TABLE `deleted_activity_log` MODIFY `user_id`    int(11) NOT NULL DEFAULT 0;
ALTER TABLE `inventory_documents`  MODIFY `created_by` int(11) NOT NULL DEFAULT 0;
ALTER TABLE `price_change_log`     MODIFY `changed_by` int(11) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------
-- 3) price_change_log.source: a price can now also change because a
--    spreadsheet was imported. The enum allowed only 'ai' and 'manual',
--    so every imported price change was silently dropped.
-- ---------------------------------------------------------------------
--
-- 'merkez' is in this list even though it arrives in 2026-09-07-zincir.sql,
-- which runs AFTER this file. It has to be.
--
-- The migrations are replayed in filename order on every boot. This statement
-- ran second and NARROWED the enum back to three values, so on a chain till
-- every restart truncated the source of every price row head office had
-- written - the row survived, its provenance did not, and the price history
-- screen showed "Elle" for a change the shop never made. The later migration
-- then widened the column again, which is why the schema always looked correct
-- and only the data was wrong.
--
-- The rule this file now obeys: a migration may widen a type, never narrow one
-- a later migration widened. test/gocler.js replays every file a second time
-- and fails on exactly this.
ALTER TABLE `price_change_log`
  MODIFY `source` enum('ai','manual','import','merkez') NOT NULL DEFAULT 'manual',
  MODIFY `changed_at` datetime NOT NULL DEFAULT current_timestamp();

-- ---------------------------------------------------------------------
-- 4) station_projection_items.station_id: an item whose category has no
--    kitchen station still belongs on the board. NULL means "no station",
--    which is exactly the case being described.
-- ---------------------------------------------------------------------
ALTER TABLE `station_projection_items` MODIFY `station_id` int(11) DEFAULT NULL;

-- ---------------------------------------------------------------------
-- 5) A staff member who only ever uses the PIN pad has no username - that
--    is the phone app's login, and most waiters never get one. The unique
--    key on this table is (client_id, email), so blanks do not collide.
-- ---------------------------------------------------------------------
ALTER TABLE `users` MODIFY `username` varchar(100) NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------
-- 6) fiscal_devices.serial_number is not known until the device has been
--    paired and has answered once.
-- ---------------------------------------------------------------------
ALTER TABLE `fiscal_devices` MODIFY `serial_number` varchar(64) NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------
-- 7) fiscal_device_reports.report_key is the idempotency key. It is
--    derived when the report is claimed, not when the row is first seen.
-- ---------------------------------------------------------------------
ALTER TABLE `fiscal_device_reports` MODIFY `report_key` varchar(64) NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------
-- 8) product_price_history: this table records the price a product HAD
--    from a given date. It is a history of prices, not a diff, and the
--    service was writing old_price/new_price/changed_by/changed_at -
--    four columns that do not exist here. Every insert threw and was
--    swallowed by a catch, so the price history has always been empty.
--    The code is fixed to write the real columns; this only makes the
--    date default so a row without one still lands.
-- ---------------------------------------------------------------------
ALTER TABLE `product_price_history`
  MODIFY `effective_date` date NOT NULL DEFAULT (curdate()),
  MODIFY `price` decimal(10,2) NOT NULL DEFAULT 0.00;
