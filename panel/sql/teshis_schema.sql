-- =====================================================================
--  NOKTApp POS - KASA TEŞHİS (till diagnostics)
--
--  WHAT: what a till says about its own health, one row per till, plus a
--  short history of the same document so a fault can be watched
--  developing instead of only being seen once it has landed.
--
--  WHY it is stored twice
--  ----------------------
--  np_diagnostics is the CURRENT state and is what every screen reads:
--  one row per (tenant, till), replaced on each push. A support call is
--  "what is that machine doing right now", and that question must be one
--  indexed lookup, not a MAX(id) over a growing log.
--
--  np_diagnostics_log is the last few documents for the same till, in
--  order. A printer that has failed since Tuesday, a disk that has lost
--  4 GB a day, a database that doubled after an import - none of those
--  are visible in a single snapshot. They are the difference between
--  "the till is broken" and "the till has been getting worse since the
--  update", which is the thing the owner actually rings about. The log
--  is TRIMMED to the newest NP_DIAG_KEEP rows per till by the code that
--  writes it (see lib/teshis.php); it is a diagnostic tail, not an
--  archive, and it must never become the biggest table in the panel.
--
--  WHY there is a payload column at all
--  ------------------------------------
--  The named columns are the ones that get filtered, sorted and shown in
--  a list - the fields a screen needs before it knows which till you
--  care about. The rest of the document (the printer list, the last log
--  lines, the counts) is JSON, because it is READ WHOLE, exactly once,
--  on one till's page. Giving each of those a column would mean a schema
--  change every time the till learns to report one more thing, and the
--  till and the panel are updated on different days by different people.
--
--  WHAT IS NOT HERE, DELIBERATELY
--  ------------------------------
--  No guest, no customer, no staff name, no bill, no order line, no
--  amount. This is a health document, not a data export: KVKK does not
--  care that we only meant to look at it during a support call, and a
--  panel that holds a copy of every restaurant's bills is a far larger
--  thing to protect than a panel that holds counts. The till builds the
--  document (pos-service/src/modules/teshis.js) from counts and machine
--  facts only, and panel/tests/teshis.php and pos-service/test/teshis.js
--  both assert that nothing identifying survives the round trip.
--
--  device_id is the till's own uuid, the same string np_devices carries,
--  and it is only ever meaningful INSIDE a tenant - two customers may
--  legitimately hold the same string. Every key here therefore starts
--  with tenant_id and no query in the panel may look a till up by
--  device_id alone.
--
--  Guarded throughout, so admin/guncelle.php can apply it to a live
--  panel and applying it twice is harmless.
-- =====================================================================
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `np_diagnostics` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `device_id` varchar(64) NOT NULL,
  -- when WE received it. The till's own clock is in the payload and is
  -- never trusted for ordering: a machine with a wrong date must not be
  -- able to push its snapshot to the top of the history.
  `received_at` datetime NOT NULL DEFAULT current_timestamp(),
  `app_version` varchar(32) DEFAULT NULL,
  `engine_version` varchar(64) DEFAULT NULL,
  `os` varchar(120) DEFAULT NULL,
  `disk_free_mb` int(11) DEFAULT NULL,
  `db_size_mb` int(11) DEFAULT NULL,
  `stations` int(11) DEFAULT NULL,
  `printers` int(11) DEFAULT NULL,
  -- how many printers' last job did NOT succeed. The one number that
  -- decides whether this till belongs at the top of the list.
  `printers_bad` int(11) DEFAULT NULL,
  `print_pending` int(11) DEFAULT NULL,
  `open_bills` int(11) DEFAULT NULL,
  `last_close_date` date DEFAULT NULL,
  `okc` tinyint(1) DEFAULT NULL,
  `errors` int(11) DEFAULT NULL,
  `payload` longtext DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_diag_device` (`tenant_id`,`device_id`),
  KEY `ix_diag_seen` (`received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_diagnostics_log` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `device_id` varchar(64) NOT NULL,
  `received_at` datetime NOT NULL DEFAULT current_timestamp(),
  `payload` longtext DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_diag_hist` (`tenant_id`,`device_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
