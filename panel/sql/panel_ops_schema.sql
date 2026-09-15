-- =====================================================================
--  NOKTApp POS - panel operations migration
--
--  WHAT: one nullable column, np_audit.tenant_id, plus an index on it.
--
--  WHY: the customer page has to answer "what have we done to THIS
--  customer" - extended the licence, changed the seat count, blocked a
--  till, reset their password. np_audit already records every one of
--  those, but it records them against a free-text `subject` ("licence#41",
--  a company name, a device id). You cannot filter that by customer
--  without string-matching, and string-matching a company name would
--  quietly show one customer's history on another customer's page the
--  first time two names overlap.
--
--  A real foreign key is deliberately NOT used: np_audit outlives the
--  rows it describes (deleting a tenant must not delete the record that
--  we deleted them), so the column is a plain nullable int.
--
--  Guarded, so applying it twice is harmless and admin/guncelle.php can
--  run it on a live panel. Existing rows keep tenant_id NULL - they are
--  history and are not back-filled, because the subject strings they
--  carry cannot be resolved to a customer reliably. That is exactly the
--  problem this column exists to stop.
-- =====================================================================
SET NAMES utf8mb4;

ALTER TABLE `np_audit` ADD COLUMN IF NOT EXISTS `tenant_id` int(11) DEFAULT NULL;
ALTER TABLE `np_audit` ADD KEY IF NOT EXISTS `ix_tenant` (`tenant_id`, `id`);
