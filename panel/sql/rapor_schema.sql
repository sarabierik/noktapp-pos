-- =====================================================================
--  NOKTApp POS - CHAIN, section 6: consolidated reporting
--
--  Every till already pushes its day-end into np_reports as generic JSON.
--  That is the right place for it to land - it is the raw thing the branch
--  said, and it must stay - but it is the wrong thing to report off. Ten
--  branches over ninety days is nine hundred JSON blobs, and an area manager
--  asking "which branch had the worst week" would be asking us to decode all
--  of them on every page load, with no way to index a date or a branch.
--
--  So the push is MATERIALISED into np_branch_days: one row per branch per
--  business day per close. The raw np_reports row is kept alongside it and
--  every materialised row records which raw row it came from, because a
--  materialisation you cannot rebuild from its source is a materialisation
--  you cannot fix. Drop this table and it rebuilds from np_reports.
--
--  Everything here is ADDITIVE and guarded. A single-shop tenant - which is
--  nearly all of them - never gets a row in this table: the fill only runs
--  when the pushing device is bound to a branch, and a single-shop till has
--  no branch. Run it as many times as you like:
--
--    mysql ... nokpos_panel < sql/rapor_schema.sql
--
--  Then, once, to materialise what is already sitting in np_reports:
--
--    php sql/rapor_backfill.php
-- =====================================================================
SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
--  One branch, one business day, one close.
--
--  Money is DECIMAL, never float: these figures are summed across ten
--  branches and the combined total has to equal the sum of the rows under
--  it to the kurus, and binary floating point does not promise that.
--
--  Nothing here is recomputed from anything else. The till worked the KDV
--  out bill by bill, in kurus, with the same engine that printed the guest's
--  bill; whatever it sent is what is stored. Turkish KDV is VAT-INCLUSIVE
--  (vat = gross * rate / (100 + rate)), so a panel that "added the tax on"
--  would invent money the restaurant never took - and a panel that divided
--  it out again would disagree with the printed bill in the third kurus.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `np_branch_days` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `branch_id` int(11) NOT NULL,
  `business_date` date NOT NULL,

  `orders` int(11) NOT NULL DEFAULT 0,
  `gross` decimal(12,2) NOT NULL DEFAULT 0.00,      -- indirim oncesi
  `discount` decimal(12,2) NOT NULL DEFAULT 0.00,
  `net` decimal(12,2) NOT NULL DEFAULT 0.00,        -- ciro, KDV dahil
  `vat` decimal(12,2) NOT NULL DEFAULT 0.00,        -- as the till calculated it
  `cost` decimal(12,2) DEFAULT NULL,                -- NULL where the push carried none
  `profit` decimal(12,2) DEFAULT NULL,

  `cash` decimal(12,2) NOT NULL DEFAULT 0.00,
  `card` decimal(12,2) NOT NULL DEFAULT 0.00,
  `other` decimal(12,2) NOT NULL DEFAULT 0.00,

  -- The till closes a day, reopens it and closes it again with a corrected
  -- count; that second close is close_seq 2 and it SUPERSEDES the first. Both
  -- rows are kept - the correction is part of the record - and `is_current`
  -- is what every report reads, so a corrected day never double-counts.
  `close_seq` int(11) NOT NULL DEFAULT 1,
  `is_current` tinyint(1) NOT NULL DEFAULT 1,

  `closed_at` datetime DEFAULT NULL,                -- the branch's clock
  `received_at` datetime NOT NULL DEFAULT current_timestamp(),
  -- np_reports.id this was built from: the audit trail back to the raw push
  `source_id` bigint(20) DEFAULT NULL,

  PRIMARY KEY (`id`),
  -- The idempotency guarantee. The same push arriving twice - a retried
  -- outbox row, a re-sent batch - lands on this key and updates in place
  -- instead of doubling the day's turnover.
  UNIQUE KEY `uq_branch_day` (`tenant_id`,`branch_id`,`business_date`,`close_seq`),
  KEY `ix_period` (`tenant_id`,`business_date`,`is_current`),
  KEY `ix_branch` (`tenant_id`,`branch_id`,`business_date`),
  KEY `ix_source` (`source_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
--  np_reports keeps the raw push, and now remembers WHO pushed it.
--
--  Without these two columns the raw row cannot be re-materialised: the
--  branch is a property of the pushing device, and np_reports never recorded
--  the device. `device_id` is the durable one - if head office later
--  discovers a till was bound to the wrong branch, fixes np_devices and
--  rebuilds, the days follow the correction. `branch_id` is the resolution
--  as it stood at push time, so the common read needs no join.
--
--  Both are NULL for every existing row and for every single-shop push, and
--  nothing outside the chain layer reads them.
-- ---------------------------------------------------------------------
ALTER TABLE `np_reports` ADD COLUMN IF NOT EXISTS `device_id` varchar(64) DEFAULT NULL;
ALTER TABLE `np_reports` ADD COLUMN IF NOT EXISTS `branch_id` int(11) DEFAULT NULL;
ALTER TABLE `np_reports` ADD KEY IF NOT EXISTS `ix_branch_day` (`tenant_id`,`entity`,`branch_id`);
