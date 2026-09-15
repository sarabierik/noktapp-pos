-- =====================================================================
--  NOKTApp POS - PARA (invoices and payments)
--
--  Until now the only money in the panel was np_licences.price, which is
--  a contract value, not a record of anything. These two tables are the
--  record: what was billed, and what came in.
--
--  ---------------------------------------------------------------
--  WHICH FIGURE EACH COLUMN HOLDS - read this before touching either
--  ---------------------------------------------------------------
--  np_invoices.amount  = MATRAH, the net figure, KDV HARIC.
--  np_invoices.total   = GENEL TOPLAM, the gross figure, KDV DAHIL.
--  KDV itself is not stored. It is exactly `total - amount`, always, and
--  a third stored figure could only ever drift from the other two. Every
--  screen prints it under the label "KDV" beside the two it came from.
--
--  Turkish KDV is quoted INCLUSIVE. Where a gross figure is the thing
--  that was agreed (the licence price the customer was told), the tax
--  inside it is  gross * rate / (100 + rate)  and the matrah is what is
--  left. It is NEVER added on top of a quoted price. Where the matrah is
--  the thing being entered, the tax is  net * rate / 100  and the total
--  is the sum. lib/para.php does both, in integer kurus, so
--  amount + KDV = total holds to the kurus with no tolerance.
--
--  Money is DECIMAL(12,2). Not FLOAT: 0.1 + 0.2 must be 0.30 in a
--  ledger, and a balance a customer is shown has to equal the sum of the
--  rows behind it exactly or it is not a balance, it is an estimate.
--
--  ---------------------------------------------------------------
--  WHY uq_invoice_period EXISTS
--  ---------------------------------------------------------------
--  The renewal run issues next period's invoice for every licence about
--  to expire. It is a bulk action a worried vendor will press twice, and
--  a customer who receives the same period twice loses trust in every
--  figure the panel prints. Idempotency is therefore enforced by the
--  DATABASE and not by a SELECT that happens to run before an INSERT:
--  one customer has at most one invoice per billing period.
--
--  period_start/period_end are NULLable and MySQL's unique keys ignore
--  NULLs, so an invoice with no period - a one-off charge, a device, a
--  training day - is deliberately outside the constraint and can be
--  issued as often as it needs to be.
--
--  status: draft -> sent -> paid, with overdue a state `sent` decays
--  into once due_at passes with a balance outstanding, and cancelled a
--  dead end. A cancelled invoice is never counted, never deleted: the
--  number it burned has to stay burned.
-- =====================================================================
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `np_invoices` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  `no` varchar(32) NOT NULL,
  `issued_at` date NOT NULL,
  `due_at` date DEFAULT NULL,
  `period_start` date DEFAULT NULL,
  `period_end` date DEFAULT NULL,
  `amount` decimal(12,2) NOT NULL DEFAULT 0.00,     -- MATRAH  (KDV haric)
  `vat_rate` decimal(5,2) NOT NULL DEFAULT 20.00,   -- % KDV orani
  `total` decimal(12,2) NOT NULL DEFAULT 0.00,      -- GENEL TOPLAM (KDV dahil)
  `status` enum('draft','sent','paid','overdue','cancelled') NOT NULL DEFAULT 'draft',
  `note` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_invoice_no` (`no`),
  UNIQUE KEY `uq_invoice_period` (`tenant_id`, `period_start`, `period_end`),
  KEY `ix_inv_tenant` (`tenant_id`, `issued_at`),
  KEY `ix_inv_status` (`status`, `due_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_payments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tenant_id` int(11) NOT NULL,
  -- Nullable: an advance paid before the invoice exists still reduces
  -- what the customer owes, and pretending otherwise would make the
  -- balance disagree with the bank.
  `invoice_id` int(11) DEFAULT NULL,
  `paid_at` date NOT NULL,
  `amount` decimal(12,2) NOT NULL,                  -- tahsil edilen, KDV dahil
  `method` enum('havale','nakit','kredi_karti','diger') NOT NULL DEFAULT 'havale',
  `reference` varchar(120) DEFAULT NULL,
  `note` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `ix_pay_tenant` (`tenant_id`, `paid_at`),
  KEY `ix_pay_invoice` (`invoice_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
