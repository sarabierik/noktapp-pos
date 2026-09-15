-- Two more columns the web app always filled and the desktop legitimately cannot.
--
-- printers.station_id: a RECEIPT printer belongs to the till, not to a kitchen
--   station. The setup wizard's last step and the Ayarlar printer form both
--   sent NULL into a NOT NULL column, so adding the cash printer answered 500 -
--   during first-run setup, which is the worst possible moment.
--
-- users.password_hash: a waiter who only ever uses the PIN pad has no password.
--   The phone-app password is optional by design, so creating a PIN-only staff
--   member answered 500 too.
--
-- Both stay NOT NULL where a value is genuinely required; they just no longer
-- demand one the product does not have. Safe to re-run.
ALTER TABLE `printers` MODIFY `station_id` int(11) DEFAULT NULL;
ALTER TABLE `users`    MODIFY `password_hash` varchar(255) NOT NULL DEFAULT '';

-- The kitchen board rounded half portions to whole ones.
--
-- station_projection_items.qty was int, and orders.js rounded into it, so a
-- "yarim porsiyon" reached the kitchen as a full portion - the cook made the
-- wrong thing and the guest was charged for half. The order line has always
-- been decimal; the board just could not carry it.
ALTER TABLE `station_projection_items` MODIFY `qty` decimal(10,2) NOT NULL DEFAULT 1.00;

-- The unique key was (station_id, order_item_id) with a NULLABLE station_id.
-- NULLs are exempt from a unique index, so a line whose category has no station
-- duplicated on every re-send instead of updating. The order line is the real
-- identity here.
--
-- IF EXISTS / IF NOT EXISTS are not decoration. The migrations are replayed on
-- every single boot, so a statement that is not re-runnable fails every time -
-- and the client is fed the file on one stdin, so it STOPS at the first error
-- and every statement below it is silently skipped for the life of that till.
-- This pair did exactly that on a real machine for seven days.
ALTER TABLE `station_projection_items` DROP INDEX IF EXISTS `uq_station_item`;
ALTER TABLE `station_projection_items` ADD UNIQUE KEY IF NOT EXISTS `uq_client_item` (`client_id`,`order_item_id`);
