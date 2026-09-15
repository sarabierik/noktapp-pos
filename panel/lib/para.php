<?php
/**
 * Para - the money layer, and the reseller scoping that sits beside it.
 *
 * Shared between the admin screens (admin/pages/fatura*.php, odeme*.php,
 * gelir.php, bayi*.php) and the reseller's own door at /bayi/, because the two
 * audiences must compute the same figure from the same rows. A reseller who is
 * told his customer owes 1.180,00 TL and an owner who is told 1.180,00 TL are
 * looking at one function, not two that agree today.
 *
 * ===========================================================================
 * 1. KDV - and why every figure in here is an integer number of kurus
 * ===========================================================================
 * Turkish KDV is quoted INCLUSIVE. The licence price a customer was told is a
 * gross figure with the tax already inside it:
 *
 *      KDV   = gross * rate / (100 + rate)
 *      matrah = gross - KDV
 *
 * The tax is NEVER added on top of a quoted price. When the matrah is what is
 * being typed in instead, it runs the other way:
 *
 *      KDV   = net * rate / 100
 *      total = net + KDV
 *
 * Both directions are computed in integer kurus and the third figure is always
 * the SUBTRACTION of the two that were rounded, never a third rounding. That
 * is what makes `amount + KDV = total` exact rather than exact-to-a-tolerance:
 * round the tax once, and the other side of the equation is whatever is left.
 *
 * Doing it in float loses the last kurus on roughly one invoice in fifty, and
 * a balance that is one kurus out is a balance the owner stops trusting - he
 * cannot tell a rounding artefact from a payment that went missing.
 *
 * ===========================================================================
 * 2. Reseller scope is a boundary, not a filter
 * ===========================================================================
 * Every bayi_* reader below takes $resellerId as its FIRST argument and puts
 * it in the WHERE clause of the query that fetches the row - not in a check
 * afterwards, and never as an ownership test on a row that was already read by
 * id. A reseller guessing `?id=` at another reseller's customer must get an
 * empty result from the database, so that forgetting the check is impossible
 * rather than merely discouraged: there is no unscoped read to forget.
 *
 * The reseller must also never see a figure about the business as a whole.
 * Nothing in the bayi_* half aggregates across resellers, and the functions
 * that do (para_income_by_month, para_ageing) are only ever called by the
 * admin screens.
 */
require_once __DIR__ . '/db.php';

/** Default KDV rate for a new invoice. Turkish standard rate. */
const PARA_VAT_RATE = 20.0;
/** How long a customer is given to pay, in days, when an invoice is issued. */
const PARA_DUE_DAYS = 14;

/* ======================================================================
   KDV
   ====================================================================== */

/** A money figure (string from the DB, float from a form) as whole kurus. */
function para_k($amount): int {
    return (int) round(((float) $amount) * 100);
}

/** Kurus back to the DECIMAL(12,2) string the database column wants. */
function para_money(int $kurus): string {
    return number_format($kurus / 100, 2, '.', '');
}

/**
 * A gross, KDV-INCLUSIVE figure split into its parts.
 * Used wherever the number that was agreed with the customer is the total -
 * the licence price, a figure read off a proforma, a round number the vendor
 * types because that is what he quoted.
 */
function para_split_gross(int $grossK, float $rate): array {
    $vatK = (int) round($grossK * $rate / (100 + $rate));
    return ['net' => $grossK - $vatK, 'vat' => $vatK, 'total' => $grossK];
}

/**
 * A net, KDV-EXCLUSIVE figure (the matrah) plus its KDV.
 * This is how an invoice is actually issued: a matrah, a rate, and the total
 * that follows from them.
 */
function para_split_net(int $netK, float $rate): array {
    $vatK = (int) round($netK * $rate / 100);
    return ['net' => $netK, 'vat' => $vatK, 'total' => $netK + $vatK];
}

/** The KDV inside an invoice row. Never stored - always the two figures' gap. */
function para_invoice_vat_k(array $inv): int {
    return para_k($inv['total']) - para_k($inv['amount']);
}

/* ======================================================================
   Invoices
   ====================================================================== */

/**
 * The next invoice number, YYYY-000041.
 *
 * Sequential within the calendar year, because that is how a Turkish
 * accountant reads a numbered series. `no` carries a UNIQUE key, so a
 * collision (two invoices issued in the same second) is a failed INSERT the
 * caller retries rather than two invoices quietly sharing a number.
 */
function para_next_no(?int $year = null): string {
    $year = $year ?: (int) date('Y');
    $last = val("SELECT MAX(no) FROM np_invoices WHERE no LIKE ?", [$year . '-%']);
    $seq = $last ? ((int) substr((string) $last, 5) + 1) : 1;
    return $year . '-' . str_pad((string) $seq, 6, '0', STR_PAD_LEFT);
}

/**
 * Issue an invoice.
 *
 * $d takes EITHER 'net' or 'gross' (both in lira, as typed) and turns it into
 * the matrah/total pair the table stores. Returns the new id, or 0 when the
 * database refused it because this customer already has an invoice for this
 * period - see uq_invoice_period in sql/para_schema.sql. A 0 is not an error
 * here, it is the constraint doing its job, and the renewal run depends on it.
 */
function para_invoice_create(array $d): int {
    $rate = isset($d['vat_rate']) ? (float) $d['vat_rate'] : PARA_VAT_RATE;
    if (isset($d['gross'])) $s = para_split_gross(para_k($d['gross']), $rate);
    else                    $s = para_split_net(para_k($d['net'] ?? 0), $rate);

    $issued = $d['issued_at'] ?? date('Y-m-d');
    $due    = $d['due_at'] ?? date('Y-m-d', strtotime($issued . ' +' . PARA_DUE_DAYS . ' day'));

    /* Up to five attempts, because the only expected failure is a number
       another request took first; the period constraint is not retried, it is
       reported as 0. */
    for ($try = 0; $try < 5; $try++) {
        try {
            q('INSERT INTO np_invoices (tenant_id, no, issued_at, due_at, period_start, period_end,
                                        amount, vat_rate, total, status, note)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)',
              [(int) $d['tenant_id'], $d['no'] ?? para_next_no((int) substr($issued, 0, 4)),
               $issued, $due, $d['period_start'] ?? null, $d['period_end'] ?? null,
               para_money($s['net']), number_format($rate, 2, '.', ''), para_money($s['total']),
               $d['status'] ?? 'draft', $d['note'] ?? null]);
            return lastId();
        } catch (Throwable $e) {
            $m = $e->getMessage();
            if (strpos($m, 'uq_invoice_period') !== false) return 0;
            if (strpos($m, 'uq_invoice_no') === false) throw $e;
        }
    }
    return 0;
}

/** What has been paid against one invoice, in kurus. */
function para_paid_k(int $invoiceId): int {
    return para_k(val('SELECT COALESCE(SUM(amount),0) FROM np_payments WHERE invoice_id=?', [$invoiceId]));
}

/**
 * Recompute one invoice's status from its payments.
 *
 * Called after every payment and after every edit, so the stored status can
 * never disagree with the rows underneath it. A part payment deliberately does
 * NOT move an invoice to paid - a customer who sends half is still a customer
 * who owes, and an invoice that flips to paid on the first instalment is how a
 * debt disappears from a chase list it should have stayed on.
 */
function para_invoice_settle(int $invoiceId): string {
    $inv = one('SELECT * FROM np_invoices WHERE id=?', [$invoiceId]);
    if (!$inv) return '';
    if ($inv['status'] === 'cancelled') return 'cancelled';

    $paidK = para_paid_k($invoiceId);
    $totK  = para_k($inv['total']);

    if ($paidK >= $totK && $totK > 0) $next = 'paid';
    elseif ($inv['status'] === 'draft') $next = 'draft';
    elseif ($inv['due_at'] && $inv['due_at'] < date('Y-m-d')) $next = 'overdue';
    else $next = 'sent';

    if ($next !== $inv['status']) q('UPDATE np_invoices SET status=? WHERE id=?', [$next, $invoiceId]);
    return $next;
}

/**
 * Move every issued invoice whose due date has passed into `overdue`, and back
 * out again if the date was corrected. Cheap, idempotent, and run when the
 * money screens open, so the vendor never has to remember to press anything to
 * see the truth.
 */
function para_touch_overdue(): void {
    q("UPDATE np_invoices i SET i.status='overdue'
        WHERE i.status='sent' AND i.due_at IS NOT NULL AND i.due_at < CURDATE()
          AND i.total > (SELECT COALESCE(SUM(p.amount),0) FROM np_payments p WHERE p.invoice_id=i.id)");
    q("UPDATE np_invoices i SET i.status='sent'
        WHERE i.status='overdue' AND (i.due_at IS NULL OR i.due_at >= CURDATE())
          AND i.total > (SELECT COALESCE(SUM(p.amount),0) FROM np_payments p WHERE p.invoice_id=i.id)");
}

/** Days past due for an outstanding invoice; null when it is not late. */
function para_ageing_days(array $inv): ?int {
    if (!$inv['due_at'] || in_array($inv['status'], ['paid', 'cancelled'], true)) return null;
    $d = (int) floor((strtotime(date('Y-m-d')) - strtotime($inv['due_at'])) / 86400);
    return $d > 0 ? $d : null;
}

/** Which ageing bucket a number of overdue days falls in. */
function para_ageing_bucket(int $days): string {
    if ($days <= 30) return '0-30';
    if ($days <= 60) return '31-60';
    if ($days <= 90) return '61-90';
    return '90+';
}

/**
 * The whole book's outstanding debt, split by how late it is.
 * Admin only - a reseller is never shown the business's receivables.
 */
function para_ageing(): array {
    $rows = all("SELECT i.*, t.company_name,
                        COALESCE((SELECT SUM(p.amount) FROM np_payments p WHERE p.invoice_id=i.id),0) paid
                   FROM np_invoices i JOIN np_tenants t ON t.id=i.tenant_id
                  WHERE i.status NOT IN ('cancelled','draft')
                  ORDER BY i.due_at");
    $buckets = ['0-30' => 0, '31-60' => 0, '61-90' => 0, '90+' => 0];
    $openK = 0; $lateK = 0;
    foreach ($rows as $r) {
        $out = para_k($r['total']) - para_k($r['paid']);
        if ($out <= 0) continue;
        $openK += $out;
        $late = para_ageing_days($r);
        if ($late === null) continue;
        $lateK += $out;
        $buckets[para_ageing_bucket($late)] += $out;
    }
    return ['open' => $openK, 'late' => $lateK, 'buckets' => $buckets];
}

/**
 * One customer's account: what they were billed, what they paid, what is left.
 *
 * `balance` is the figure printed on their page, and it is arithmetic on the
 * same rows the page lists underneath it - invoiced minus paid, in kurus, with
 * cancelled invoices excluded and nothing else adjusted. tests/para.php adds
 * the listed rows up independently and asserts equality to the kurus.
 */
function para_tenant_balance(int $tenantId): array {
    $invK = para_k(val("SELECT COALESCE(SUM(total),0) FROM np_invoices
                         WHERE tenant_id=? AND status<>'cancelled'", [$tenantId]));
    $netK = para_k(val("SELECT COALESCE(SUM(amount),0) FROM np_invoices
                         WHERE tenant_id=? AND status<>'cancelled'", [$tenantId]));
    $payK = para_k(val('SELECT COALESCE(SUM(amount),0) FROM np_payments WHERE tenant_id=?', [$tenantId]));
    $lateK = para_k(val("SELECT COALESCE(SUM(i.total - COALESCE(
                            (SELECT SUM(p.amount) FROM np_payments p WHERE p.invoice_id=i.id),0)),0)
                           FROM np_invoices i
                          WHERE i.tenant_id=? AND i.status='overdue'", [$tenantId]));
    return ['invoiced' => $invK, 'net' => $netK, 'vat' => $invK - $netK,
            'paid' => $payK, 'balance' => $invK - $payK, 'overdue' => $lateK];
}

/** One customer's invoices, newest first. */
function para_tenant_invoices(int $tenantId, int $limit = 200): array {
    return all("SELECT i.*, COALESCE((SELECT SUM(p.amount) FROM np_payments p WHERE p.invoice_id=i.id),0) paid
                  FROM np_invoices i WHERE i.tenant_id=? ORDER BY i.issued_at DESC, i.id DESC LIMIT " . (int) $limit,
               [$tenantId]);
}

/** One customer's payments, newest first. */
function para_tenant_payments(int $tenantId, int $limit = 200): array {
    return all("SELECT p.*, i.no invoice_no FROM np_payments p
                LEFT JOIN np_invoices i ON i.id=p.invoice_id
                WHERE p.tenant_id=? ORDER BY p.paid_at DESC, p.id DESC LIMIT " . (int) $limit, [$tenantId]);
}

/**
 * Record a payment and settle its invoice in one step.
 *
 * The invoice is re-read scoped by (id, tenant) rather than trusted from the
 * form, so a posted invoice_id belonging to another customer records nothing.
 */
function para_payment_add(array $d): int {
    $tid = (int) $d['tenant_id'];
    $invId = !empty($d['invoice_id']) ? (int) $d['invoice_id'] : null;
    if ($invId) {
        $inv = one('SELECT id FROM np_invoices WHERE id=? AND tenant_id=?', [$invId, $tid]);
        if (!$inv) return 0;
    }
    q('INSERT INTO np_payments (tenant_id, invoice_id, paid_at, amount, method, reference, note)
       VALUES (?,?,?,?,?,?,?)',
      [$tid, $invId, $d['paid_at'] ?? date('Y-m-d'), para_money(para_k($d['amount'])),
       in_array($d['method'] ?? '', ['havale', 'nakit', 'kredi_karti', 'diger'], true) ? $d['method'] : 'havale',
       $d['reference'] ?? null, $d['note'] ?? null]);
    $id = lastId();
    if ($invId) para_invoice_settle($invId);
    return $id;
}

/* ======================================================================
   The renewal run
   ====================================================================== */

/**
 * The licences that would be invoiced by a run over the next $days.
 *
 * A licence is a candidate when it is live, has a price, and expires inside
 * the window. The period it would be billed for starts the day after it
 * expires, which is why running the same window twice a week apart still
 * proposes the SAME period for the same customer - and therefore hits
 * uq_invoice_period rather than issuing a second invoice.
 */
function para_renewal_candidates(int $days = 30): array {
    $rows = all("SELECT t.id tenant_id, t.company_name, t.code,
                        l.id licence_id, l.plan, l.price, l.billing_period, l.expires_at
                   FROM np_tenants t
                   JOIN np_licences l ON l.id = (SELECT MAX(id) FROM np_licences WHERE tenant_id=t.id)
                  WHERE t.is_active=1
                    AND l.status IN ('active','trial')
                    AND l.expires_at IS NOT NULL
                    AND l.price IS NOT NULL AND l.price > 0
                    AND l.expires_at < DATE_ADD(NOW(), INTERVAL ? DAY)
                  ORDER BY l.expires_at", [$days]);
    foreach ($rows as &$r) {
        $r += para_renewal_period($r);
        $r['exists'] = (int) val('SELECT COUNT(*) FROM np_invoices
                                   WHERE tenant_id=? AND period_start=? AND period_end=?',
                                 [$r['tenant_id'], $r['period_start'], $r['period_end']]) > 0;
    }
    return $rows;
}

/** The period a licence's next invoice covers. Derived, never guessed twice. */
function para_renewal_period(array $lic): array {
    $start = date('Y-m-d', strtotime(substr((string) $lic['expires_at'], 0, 10) . ' +1 day'));
    $step = (($lic['billing_period'] ?? 'yearly') === 'monthly') ? '+1 month' : '+1 year';
    $end = date('Y-m-d', strtotime($start . ' ' . $step . ' -1 day'));
    return ['period_start' => $start, 'period_end' => $end];
}

/**
 * Issue next period's invoice for every licence expiring inside the window.
 *
 * Idempotent by construction: the period is a function of the licence's expiry
 * date, and (tenant, period_start, period_end) is UNIQUE. A second run over
 * the same window inserts nothing and reports it as `skipped`, whatever the
 * order or the timing - no SELECT-then-INSERT window to lose.
 *
 * The licence price is treated as the GROSS figure, because it is what the
 * customer was quoted, so the matrah on the invoice is the price with the KDV
 * taken back out of it - never the price with KDV added on top of it.
 */
function para_renewal_run(int $days = 30, string $status = 'draft'): array {
    $made = []; $skipped = 0;
    foreach (para_renewal_candidates($days) as $c) {
        $id = para_invoice_create([
            'tenant_id' => (int) $c['tenant_id'],
            'gross' => $c['price'],
            'vat_rate' => PARA_VAT_RATE,
            'period_start' => $c['period_start'],
            'period_end' => $c['period_end'],
            'status' => $status,
            'note' => 'Lisans yenileme · ' . $c['plan'] . ' · '
                    . date('d.m.Y', strtotime($c['period_start'])) . ' - '
                    . date('d.m.Y', strtotime($c['period_end'])),
        ]);
        if ($id) $made[] = $id; else $skipped++;
    }
    return ['created' => count($made), 'skipped' => $skipped, 'ids' => $made];
}

/* ======================================================================
   Gelir - income by month
   ====================================================================== */

/**
 * The last $months months, each with what was billed, what came in, and what
 * of that month's billing is now late.
 *
 * Three different questions are deliberately kept as three columns rather than
 * being reconciled into one "income" figure:
 *   kesilen  - accrual: invoices issued that month (KDV dahil)
 *   tahsilat - cash: money that arrived that month, whatever it was for
 *   donem tahsilati - how much of THAT month's billing has since been paid
 *   geciken  - what is left of that month's billing, past its due date
 * The first two never add up to each other and pretending they do is how a
 * revenue chart ends up lying.
 */
function para_income_by_month(int $months = 12): array {
    $out = [];
    for ($i = $months - 1; $i >= 0; $i--) {
        $m = date('Y-m', strtotime('first day of -' . $i . ' month'));
        $out[$m] = ['month' => $m, 'invoiced' => 0, 'net' => 0, 'collected' => 0,
                    'period_collected' => 0, 'overdue' => 0, 'count' => 0];
    }
    $from = array_key_first($out) . '-01';

    foreach (all("SELECT DATE_FORMAT(issued_at,'%Y-%m') m, COUNT(*) c,
                         COALESCE(SUM(total),0) t, COALESCE(SUM(amount),0) n
                    FROM np_invoices WHERE status<>'cancelled' AND issued_at >= ?
                   GROUP BY m", [$from]) as $r) {
        if (!isset($out[$r['m']])) continue;
        $out[$r['m']]['invoiced'] = para_k($r['t']);
        $out[$r['m']]['net'] = para_k($r['n']);
        $out[$r['m']]['count'] = (int) $r['c'];
    }
    foreach (all("SELECT DATE_FORMAT(paid_at,'%Y-%m') m, COALESCE(SUM(amount),0) t
                    FROM np_payments WHERE paid_at >= ? GROUP BY m", [$from]) as $r) {
        if (isset($out[$r['m']])) $out[$r['m']]['collected'] = para_k($r['t']);
    }
    foreach (all("SELECT DATE_FORMAT(i.issued_at,'%Y-%m') m, COALESCE(SUM(p.amount),0) t
                    FROM np_payments p JOIN np_invoices i ON i.id=p.invoice_id
                   WHERE i.status<>'cancelled' AND i.issued_at >= ? GROUP BY m", [$from]) as $r) {
        if (isset($out[$r['m']])) $out[$r['m']]['period_collected'] = para_k($r['t']);
    }
    foreach (all("SELECT DATE_FORMAT(i.issued_at,'%Y-%m') m,
                         COALESCE(SUM(i.total - COALESCE(
                           (SELECT SUM(p.amount) FROM np_payments p WHERE p.invoice_id=i.id),0)),0) t
                    FROM np_invoices i WHERE i.status='overdue' AND i.issued_at >= ? GROUP BY m", [$from]) as $r) {
        if (isset($out[$r['m']])) $out[$r['m']]['overdue'] = para_k($r['t']);
    }
    return array_values($out);
}

/* ======================================================================
   Bayiler - resellers
   ====================================================================== */

/**
 * Commission, stated once so the screens cannot disagree.
 *
 * Base = the MATRAH (KDV haric) of invoices this reseller's customers have
 * actually PAID IN FULL. Two rules, both deliberate and both printed on the
 * screen beside the number:
 *
 *  - KDV is excluded, because it was never the vendor's money to share.
 *  - an unpaid invoice earns nothing, because it is not income yet. A part
 *    payment likewise earns nothing until the invoice closes: splitting a
 *    part payment across matrah and KDV means a rounding rule nobody can
 *    check, and "you are paid when the customer pays" is a rule a reseller
 *    can check against his own bank.
 */
function bayi_commission_base_k(int $resellerId): int {
    return para_k(val("SELECT COALESCE(SUM(i.amount),0)
                         FROM np_invoices i JOIN np_tenants t ON t.id=i.tenant_id
                        WHERE t.reseller_id=? AND i.status='paid'", [$resellerId]));
}

/** Every reseller with the figures the list screen prints. Admin only. */
function bayi_list(): array {
    $rows = all('SELECT r.*,
                    (SELECT COUNT(*) FROM np_tenants t WHERE t.reseller_id=r.id) customers,
                    (SELECT COUNT(*) FROM np_tenants t WHERE t.reseller_id=r.id AND t.is_active=1) live
                   FROM np_resellers r ORDER BY r.is_active DESC, r.name');
    foreach ($rows as &$r) {
        $r['invoiced'] = para_k(val("SELECT COALESCE(SUM(i.total),0) FROM np_invoices i
                                       JOIN np_tenants t ON t.id=i.tenant_id
                                      WHERE t.reseller_id=? AND i.status<>'cancelled'", [$r['id']]));
        $r['collected'] = para_k(val('SELECT COALESCE(SUM(p.amount),0) FROM np_payments p
                                        JOIN np_tenants t ON t.id=p.tenant_id
                                       WHERE t.reseller_id=?', [$r['id']]));
        $r['base'] = bayi_commission_base_k($r['id']);
        $r['commission'] = (int) round($r['base'] * (float) $r['commission_pct'] / 100);
    }
    return $rows;
}

/** One reseller, by id. Admin only - the door uses bayi_by_email(). */
function bayi_get(int $id): ?array { return one('SELECT * FROM np_resellers WHERE id=?', [$id]); }

function bayi_by_email(string $email): ?array {
    return one('SELECT * FROM np_resellers WHERE email=? AND is_active=1', [strtolower(trim($email))]);
}

/**
 * This reseller's customers. The reseller_id is in the WHERE clause, and it is
 * the ONLY way this list is ever produced - there is no "all customers, then
 * filter" path for anything under /bayi/.
 */
function bayi_customers(int $resellerId): array {
    return all("SELECT t.*, l.status lic_status, l.plan, l.seats, l.price, l.expires_at, l.billing_period,
                       (SELECT COUNT(*) FROM np_devices d WHERE d.tenant_id=t.id) devices,
                       (SELECT MAX(last_seen_at) FROM np_devices d WHERE d.tenant_id=t.id) last_seen
                  FROM np_tenants t
             LEFT JOIN np_licences l ON l.id = (SELECT MAX(id) FROM np_licences WHERE tenant_id=t.id)
                 WHERE t.reseller_id=?
                 ORDER BY t.is_active DESC, t.company_name", [$resellerId]);
}

/** One customer, ONLY if this reseller sold them. Returns null otherwise. */
function bayi_tenant(int $resellerId, int $tenantId): ?array {
    return one('SELECT * FROM np_tenants WHERE id=? AND reseller_id=?', [$tenantId, $resellerId]);
}

/** One invoice, ONLY if it belongs to a customer this reseller sold. */
function bayi_invoice(int $resellerId, int $invoiceId): ?array {
    return one('SELECT i.*, t.company_name, t.code tenant_code
                  FROM np_invoices i JOIN np_tenants t ON t.id=i.tenant_id
                 WHERE i.id=? AND t.reseller_id=?', [$invoiceId, $resellerId]);
}

/** One payment, ONLY if it belongs to a customer this reseller sold. */
function bayi_payment(int $resellerId, int $paymentId): ?array {
    return one('SELECT p.*, t.company_name, i.no invoice_no
                  FROM np_payments p JOIN np_tenants t ON t.id=p.tenant_id
             LEFT JOIN np_invoices i ON i.id=p.invoice_id
                 WHERE p.id=? AND t.reseller_id=?', [$paymentId, $resellerId]);
}

/** This reseller's customers' invoices; optionally one customer's. */
function bayi_invoices(int $resellerId, ?int $tenantId = null, int $limit = 200): array {
    $sql = "SELECT i.*, t.company_name, t.code tenant_code,
                   COALESCE((SELECT SUM(p.amount) FROM np_payments p WHERE p.invoice_id=i.id),0) paid
              FROM np_invoices i JOIN np_tenants t ON t.id=i.tenant_id
             WHERE t.reseller_id=?";
    $args = [$resellerId];
    if ($tenantId !== null) { $sql .= ' AND i.tenant_id=?'; $args[] = $tenantId; }
    return all($sql . ' ORDER BY i.issued_at DESC, i.id DESC LIMIT ' . (int) $limit, $args);
}

/** This reseller's customers' payments; optionally one customer's. */
function bayi_payments(int $resellerId, ?int $tenantId = null, int $limit = 200): array {
    $sql = 'SELECT p.*, t.company_name, i.no invoice_no
              FROM np_payments p JOIN np_tenants t ON t.id=p.tenant_id
         LEFT JOIN np_invoices i ON i.id=p.invoice_id
             WHERE t.reseller_id=?';
    $args = [$resellerId];
    if ($tenantId !== null) { $sql .= ' AND p.tenant_id=?'; $args[] = $tenantId; }
    return all($sql . ' ORDER BY p.paid_at DESC, p.id DESC LIMIT ' . (int) $limit, $args);
}

/**
 * The reseller's own totals - their customers, their sales, their commission.
 * Never the vendor's book: every SUM here is inside `t.reseller_id = ?`.
 */
function bayi_totals(int $resellerId): array {
    $r = bayi_get($resellerId);
    $pct = $r ? (float) $r['commission_pct'] : 0.0;
    $base = bayi_commission_base_k($resellerId);
    return [
        'customers' => (int) val('SELECT COUNT(*) FROM np_tenants WHERE reseller_id=?', [$resellerId]),
        'live' => (int) val('SELECT COUNT(*) FROM np_tenants WHERE reseller_id=? AND is_active=1', [$resellerId]),
        'invoiced' => para_k(val("SELECT COALESCE(SUM(i.total),0) FROM np_invoices i
                                    JOIN np_tenants t ON t.id=i.tenant_id
                                   WHERE t.reseller_id=? AND i.status<>'cancelled'", [$resellerId])),
        'collected' => para_k(val('SELECT COALESCE(SUM(p.amount),0) FROM np_payments p
                                     JOIN np_tenants t ON t.id=p.tenant_id
                                    WHERE t.reseller_id=?', [$resellerId])),
        'open' => para_k(val("SELECT COALESCE(SUM(i.total - COALESCE(
                                 (SELECT SUM(p.amount) FROM np_payments p WHERE p.invoice_id=i.id),0)),0)
                                FROM np_invoices i JOIN np_tenants t ON t.id=i.tenant_id
                               WHERE t.reseller_id=? AND i.status NOT IN ('cancelled','draft')", [$resellerId])),
        'base' => $base,
        'pct' => $pct,
        'commission' => (int) round($base * $pct / 100),
    ];
}

/** This reseller's commission month by month, from the invoices that closed. */
function bayi_commission_months(int $resellerId, int $months = 12): array {
    $r = bayi_get($resellerId);
    $pct = $r ? (float) $r['commission_pct'] : 0.0;
    $out = [];
    for ($i = $months - 1; $i >= 0; $i--) {
        $m = date('Y-m', strtotime('first day of -' . $i . ' month'));
        $out[$m] = ['month' => $m, 'base' => 0, 'commission' => 0, 'count' => 0];
    }
    $from = array_key_first($out) . '-01';
    foreach (all("SELECT DATE_FORMAT(i.issued_at,'%Y-%m') m, COUNT(*) c, COALESCE(SUM(i.amount),0) n
                    FROM np_invoices i JOIN np_tenants t ON t.id=i.tenant_id
                   WHERE t.reseller_id=? AND i.status='paid' AND i.issued_at >= ?
                   GROUP BY m", [$resellerId, $from]) as $row) {
        if (!isset($out[$row['m']])) continue;
        $out[$row['m']]['base'] = para_k($row['n']);
        $out[$row['m']]['count'] = (int) $row['c'];
        $out[$row['m']]['commission'] = (int) round(para_k($row['n']) * $pct / 100);
    }
    return array_values($out);
}

/* ======================================================================
   Shared presentation helpers
   ====================================================================== */

/** Kurus printed the Turkish way: 1.234,56 TL. */
function para_tl(int $kurus): string { return number_format($kurus / 100, 2, ',', '.') . ' ₺'; }

/** The Turkish label for an invoice status. */
function para_status_label(string $s): string {
    return ['draft' => 'taslak', 'sent' => 'gönderildi', 'paid' => 'ödendi',
            'overdue' => 'gecikti', 'cancelled' => 'iptal'][$s] ?? $s;
}

/**
 * The pill class for a status.
 *
 * Mapped onto the pills the panel already has rather than inventing new ones:
 * `active` is the settled state, `trial` the in-progress one, `suspended` the
 * one that needs attention. Colour never carries the meaning here - the pill
 * prints the Turkish word - which is the same rule the rest of the panel
 * follows because this product has one hue and cannot encode identity in it.
 */
function para_status_pill(string $s): string {
    return ['draft' => 'pill-out', 'sent' => 'pill-trial', 'paid' => 'pill-active',
            'overdue' => 'pill-suspended', 'cancelled' => 'pill-out'][$s] ?? 'pill-out';
}

/** The Turkish label for a payment method. */
function para_method_label(string $m): string {
    return ['havale' => 'Havale/EFT', 'nakit' => 'Nakit', 'kredi_karti' => 'Kredi kartı',
            'diger' => 'Diğer'][$m] ?? $m;
}

/** "Eylül 2025" from "2025-09". */
function para_month_label(string $ym): string {
    $names = ['01' => 'Ocak', '02' => 'Şubat', '03' => 'Mart', '04' => 'Nisan', '05' => 'Mayıs',
              '06' => 'Haziran', '07' => 'Temmuz', '08' => 'Ağustos', '09' => 'Eylül',
              '10' => 'Ekim', '11' => 'Kasım', '12' => 'Aralık'];
    return ($names[substr($ym, 5, 2)] ?? $ym) . ' ' . substr($ym, 0, 4);
}
