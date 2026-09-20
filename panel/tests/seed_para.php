<?php
/*
 * COMMAND LINE ONLY.
 *
 * These suites create tenants, delete rows and rebuild fixtures. They are
 * written to be run with `php panel/tests/<name>.php` from a shell, against a
 * sandbox database. Nothing stops them being uploaded to public_html by
 * accident along with the rest of the panel, and a file sitting there is a URL
 * anybody on the internet can open - which would let a stranger create and
 * delete tenants on the live panel by loading a page.
 *
 * So the first line of every one of them refuses to run over HTTP, and answers
 * 404 rather than 403: a refusal that says "something is here" is an
 * invitation to look harder.
 */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

/**
 * Demo fixture for Bayiler and Para - resellers, invoices, payments.
 *
 * NOT part of the panel. It exists so the money and reseller screens can be
 * reviewed with something on them, and so the browser walk has real rows to
 * measure. It only ever touches the DEMO customers made by seed_demo.php and
 * the resellers it creates itself (code BAYI*), and it deletes those before
 * re-creating them, so running it twice is harmless and it cannot reach a real
 * customer or the throwaway tenants the other suites make.
 *
 * Run:  php panel/tests/seed_para.php
 *       php panel/tests/seed_para.php --clean
 */
foreach ([
    'NP_DB_HOST' => '127.0.0.1', 'NP_DB_PORT' => '3399', 'NP_DB_NAME' => 'nokpos_panel',
    'NP_DB_USER' => 'noktapp',   'NP_DB_PASS' => 'nokpass',
] as $k => $v) { if (getenv($k) === false) putenv("$k=$v"); }

require_once __DIR__ . '/../lib/para.php';

$demo = all("SELECT t.id, t.company_name, l.price, l.billing_period, l.expires_at, l.plan
               FROM np_tenants t
          LEFT JOIN np_licences l ON l.id=(SELECT MAX(id) FROM np_licences WHERE tenant_id=t.id)
              WHERE t.code LIKE 'DEMO%' ORDER BY t.id");
$ids = array_column($demo, 'id');

/* ------------------------------ teardown ------------------------------ */
if ($ids) {
    $in = implode(',', array_map('intval', $ids));
    q("DELETE FROM np_payments WHERE tenant_id IN ($in)");
    q("DELETE FROM np_invoices WHERE tenant_id IN ($in)");
    q("UPDATE np_tenants SET reseller_id=NULL WHERE id IN ($in)");
}
q("DELETE FROM np_resellers WHERE code LIKE 'BAYI%'");
echo "temizlendi\n";
if (in_array('--clean', $argv, true)) { echo "bitti (yalnızca temizlik)\n"; exit; }
if (!$demo) { echo "DEMO işletme yok — önce seed_demo.php çalıştırın\n"; exit(1); }

/* ------------------------------ resellers ----------------------------- */
$resellers = [
    ['BAYI01', 'Akdeniz Bilgisayar', 'Serkan Aydın', 'bayi.akdeniz@ornek.test', 'Antalya', 12.50],
    ['BAYI02', 'Ege Kasa Sistemleri', 'Neslihan Er', 'bayi.ege@ornek.test', 'İzmir', 10.00],
    ['BAYI03', 'Marmara Teknoloji', 'Onur Kaya', 'bayi.marmara@ornek.test', 'İstanbul', 15.00],
    ['BAYI04', 'İç Anadolu POS', 'Hatice Demir', 'bayi.anadolu@ornek.test', 'Ankara', 8.00],
];
$rids = [];
foreach ($resellers as [$code, $name, $contact, $email, $city, $pct]) {
    q('INSERT INTO np_resellers (code, name, contact, email, phone, city, commission_pct,
         password_hash, is_active) VALUES (?,?,?,?,?,?,?,?,1)',
      [$code, $name, $contact, $email, '05' . random_int(300000000, 399999999), $city,
       number_format($pct, 2, '.', ''), password_hash('BayiTest123', PASSWORD_BCRYPT)]);
    $rids[] = lastId();
}
echo count($rids) . " bayi oluşturuldu (şifre: BayiTest123)\n";

/* Three quarters of the customers came through a reseller; the rest were sold
   direct, which is what makes the "bayisiz" figure on the list mean anything. */
$assigned = 0;
foreach ($demo as $i => $t) {
    if ($i % 4 === 3) continue;
    /* Cycle over the assigned ones, not over $i: every fourth customer is a
       direct sale, so indexing by $i would have left one reseller with none. */
    q('UPDATE np_tenants SET reseller_id=? WHERE id=?', [$rids[$assigned % count($rids)], $t['id']]);
    $assigned++;
}
echo "$assigned işletme bayilere bağlandı\n";

/* ------------------------- invoices and payments ---------------------- */
mt_srand(20260904);   // repeatable spread
$made = 0; $paid = 0; $partial = 0;

foreach ($demo as $i => $t) {
    $price = $t['price'] !== null ? (float) $t['price'] : 0;
    if ($price <= 0) $price = 4800;
    $monthly = ($t['billing_period'] ?? 'yearly') === 'monthly';

    /* Between one and four past periods, ending in the current one. Every
       invoice carries a real period so the uniqueness constraint is exercised
       by the fixture as well as by the tests. */
    $n = 1 + ($i % 4);
    $stepMonths = $monthly ? 1 : 12;
    /* k counts backwards from the oldest period to the current one, so the
       newest invoice is a few days old - some inside their 14-day terms and
       some past them. That is what puts rows in every ageing bucket and gives
       the screens both a `sent` and an `overdue` case to draw. */
    for ($k = $n - 1; $k >= 0; $k--) {
        $back = $k * $stepMonths;
        $issued = date('Y-m-d', strtotime("-{$back} month -" . mt_rand(1, 40) . ' day'));
        $due = date('Y-m-d', strtotime($issued . ' +14 day'));
        $start = date('Y-m-d', strtotime($issued . ' +1 day'));
        $end = date('Y-m-d', strtotime($start . ($monthly ? ' +1 month' : ' +1 year') . ' -1 day'));

        $id = para_invoice_create([
            'tenant_id' => (int) $t['id'], 'gross' => $price, 'vat_rate' => 20,
            'issued_at' => $issued, 'due_at' => $due,
            'period_start' => $start, 'period_end' => $end,
            'status' => 'sent',
            'note' => 'Lisans · ' . ($t['plan'] ?: 'standart'),
        ]);
        if (!$id) continue;
        $made++;

        /* Older periods are mostly settled; the newest is a mix, so the ageing
           buckets, the partial-payment case and the overdue case all have rows
           on the screens. */
        $roll = mt_rand(1, 100);
        if ($k > 0 || $roll <= 55) {
            para_payment_add(['tenant_id' => (int) $t['id'], 'invoice_id' => $id,
                'paid_at' => date('Y-m-d', strtotime($issued . ' +' . mt_rand(2, 30) . ' day')),
                'amount' => $price, 'method' => ['havale', 'nakit', 'kredi_karti', 'havale'][mt_rand(0, 3)],
                'reference' => 'DEK' . mt_rand(100000, 999999)]);
            $paid++;
        } elseif ($roll <= 75) {
            para_payment_add(['tenant_id' => (int) $t['id'], 'invoice_id' => $id,
                'paid_at' => date('Y-m-d', strtotime($issued . ' +' . mt_rand(2, 20) . ' day')),
                'amount' => round($price / 2, 2), 'method' => 'havale',
                'reference' => 'KISMI' . mt_rand(1000, 9999)]);
            $partial++;
        }
    }
}
para_touch_overdue();

$open = para_ageing();
echo "$made fatura kesildi · $paid tamamen ödendi · $partial kısmi ödendi\n";
echo "açık bakiye " . para_tl($open['open']) . " · gecikmiş " . para_tl($open['late']) . "\n";
echo "bitti\n";
