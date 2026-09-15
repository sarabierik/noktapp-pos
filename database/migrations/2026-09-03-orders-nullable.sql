-- Bills without a table, and bills without a waiter.
--
-- "Hizli satis" (counter takeaway) has no table, and an owner signed in on the
-- licence rather than as a staff member has no waiter id. Both columns came
-- from the web schema as NOT NULL, because the PHP layer always passed
-- something; on the desktop the till answered "Column 'table_id' cannot be
-- null" and would not open the bill at all.
--
-- Re-running this is harmless.
ALTER TABLE `orders`
  MODIFY `table_id`  int(11) DEFAULT NULL,
  MODIFY `waiter_id` int(11) DEFAULT NULL;
