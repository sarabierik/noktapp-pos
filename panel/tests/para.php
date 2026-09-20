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
 * NOKTApp POS - Bayiler (resellers) and Para (invoices, payments, income).
 *
 * Everything runs against the real MariaDB and the real screens over HTTP.
 * Nothing is mocked, because the two failures this suite exists to catch are
 * exactly the ones a mock hides:
 *
 *   1. A RESELLER SEEING SOMEBODY ELSE'S CUSTOMER. /bayi/ is a security
 *      boundary, not a filter: one reseller resells for the same vendor as
 *      another, and a missed scope hands a competitor a customer list, an
 *      invoice and what that customer pays. So the boundary is crossed in both
 *      directions here, by guessing ids, over HTTP, with a real session.
 *
 *   2. MONEY THAT IS ONLY NEARLY RIGHT. KDV is inclusive in Turkey, a balance
 *      has to equal the rows it was summed from, and a renewal run a worried
 *      vendor presses twice must not bill a customer twice. Every assertion
 *      about money below is an equality in KURUS - never a tolerance, because
 *      a tolerance is how a ledger stops being a ledger.
 *
 * Throwaway resellers and customers are created and
 * destroyed by the run, and the invoices the whole-book renewal checks issue
 * for real customers are deleted again at teardown, so a run leaves the
 * vendor's book exactly as it found it and never touches the DEMO fixture or
 * the tenants the chain, rapor and panel suites make.
 *
 * Run:  php panel/tests/para.php
 * Env:  NP_DB_PORT (3399) NP_DB_USER (noktapp) NP_DB_PASS (nokpass)
 *       NP_DB_NAME (nokpos_panel)  PANEL (http://127.0.0.1:8090)
 *       PANEL_ADMIN / PANEL_ADMIN_PASS for the screen checks
 */
foreach ([
    'NP_DB_HOST' => '127.0.0.1', 'NP_DB_PORT' => '3399', 'NP_DB_NAME' => 'nokpos_panel',
    'NP_DB_USER' => 'noktapp',   'NP_DB_PASS' => 'nokpass',
] as $k => $v) { if (getenv($k) === false) putenv("$k=$v"); }

require_once __DIR__ . '/../lib/para.php';

$PANEL = getenv('PANEL') ?: 'http://127.0.0.1:8090';
$ADMIN = getenv('PANEL_ADMIN') ?: 'erik@noktapp.com';
$ADMIN_PASS = getenv('PANEL_ADMIN_PASS') ?: 'ChainTest123';
$BAYI_PASS = 'ParaTest123';

$pass = 0; $total = 0; $failures = [];

function check(string $name, callable $fn): void {
    global $pass, $total, $failures;
    $total++;
    try { $fn(); $pass++; echo "  PASS  $name\n"; }
    catch (Throwable $e) { $failures[] = $name . ' -> ' . $e->getMessage(); echo "  FAIL  $name  -> " . $e->getMessage() . "\n"; }
}
function assertThat($cond, string $msg): void { if (!$cond) throw new RuntimeException($msg); }
function assertSame($a, $b, string $msg): void {
    if ($a !== $b) throw new RuntimeException($msg . ' (beklenen ' . var_export($a, true) . ', gelen ' . var_export($b, true) . ')');
}
/** Money equality. Kurus, always - never a tolerance. */
function assertKurus(int $a, int $b, string $msg): void {
    if ($a !== $b) throw new RuntimeException($msg . ' (beklenen ' . para_tl($a) . ', gelen ' . para_tl($b) . ')');
}

/* --------------------------- http, as a browser --------------------------- */
/* Two jars, because the whole point is that the two doors do not share one. */
$JAR_ADMIN = sys_get_temp_dir() . '/np-para-admin-' . getmypid() . '.cookies';
$JAR_BAYI  = sys_get_temp_dir() . '/np-para-bayi-' . getmypid() . '.cookies';
$JAR_BAYI2 = sys_get_temp_dir() . '/np-para-bayi2-' . getmypid() . '.cookies';
foreach ([$JAR_ADMIN, $JAR_BAYI, $JAR_BAYI2] as $j) @unlink($j);

function http(?string $jar, string $method, string $url, array $form = []): array {
    $ch = curl_init($url);
    $opt = [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_FOLLOWLOCATION => false, CURLOPT_HEADER => true, CURLOPT_TIMEOUT => 30];
    if ($jar !== null) { $opt[CURLOPT_COOKIEJAR] = $jar; $opt[CURLOPT_COOKIEFILE] = $jar; }
    curl_setopt_array($ch, $opt);
    if ($form) curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($form));
    $raw = (string) curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hsize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($raw === '' && $err) throw new RuntimeException('panel yanit vermedi: ' . $err);
    $head = substr($raw, 0, $hsize);
    $loc = '';
    if (preg_match('/^location:\s*(.+)$/mi', $head, $m)) $loc = trim($m[1]);
    return ['status' => $status, 'body' => substr($raw, $hsize), 'location' => $loc];
}

/** Did the page render, or did the panel's error box catch a fatal? */
function assertRendered(array $r, string $what): void {
    assertSame(200, $r['status'], $what . ' HTTP durumu');
    foreach (['Panel bir hata ile karsilasti', 'Panel durdu', 'Bayi paneli durdu',
              'Bayi paneli bir hata ile karsilasti', 'Fatal error', 'Parse error',
              'Warning:', 'Notice:', 'Deprecated:'] as $bad) {
        assertThat(strpos($r['body'], $bad) === false, $what . ' hata gosterdi: ' . $bad);
    }
    assertThat(strlen($r['body']) > 400, $what . ' sayfasi bos geldi');
}

/* ------------------------------- fixture ---------------------------------- */
function drop_para_tenant(string $email): void {
    $t = one('SELECT id FROM np_tenants WHERE email=?', [$email]);
    if (!$t) return;
    $id = (int) $t['id'];
    foreach (['np_payments', 'np_invoices', 'np_devices', 'np_backups', 'np_reports',
              'np_relay_messages', 'np_licences'] as $tab) {
        try { q("DELETE FROM {$tab} WHERE tenant_id=?", [$id]); } catch (Throwable $e) {}
    }
    try { q('DELETE FROM np_audit WHERE tenant_id=?', [$id]); } catch (Throwable $e) {}
    q('DELETE FROM np_tenants WHERE id=?', [$id]);
}

function make_para_tenant(string $code, string $name, string $email, ?int $resellerId,
                          float $price, int $expiresInDays, string $period = 'yearly'): array {
    drop_para_tenant($email);
    q('INSERT INTO np_tenants (code, company_name, owner_name, email, password_hash, phone,
         tax_number, tax_office, city, is_active, reseller_id)
       VALUES (?,?,?,?,?,?,?,?,?,1,?)',
      [$code, $name, 'Para Test', $email, password_hash('x', PASSWORD_BCRYPT),
       '05559990000', '1234567890', 'Test VD', 'Antalya', $resellerId]);
    $id = lastId();
    q('INSERT INTO np_licences (tenant_id, licence_key, plan, status, seats, starts_at, expires_at,
         grace_days, price, billing_period)
       VALUES (?,?,?,?,?, CURDATE(), DATE_ADD(NOW(), INTERVAL ? DAY), 7, ?, ?)',
      [$id, strtoupper(bin2hex(random_bytes(12))), 'pro', 'active', 3, $expiresInDays,
       number_format($price, 2, '.', ''), $period]);
    return ['id' => $id, 'name' => $name, 'code' => $code, 'email' => $email];
}

function make_para_reseller(string $code, string $name, string $email, float $pct): int {
    global $BAYI_PASS;
    q('DELETE FROM np_resellers WHERE code=? OR email=?', [$code, $email]);
    q('INSERT INTO np_resellers (code, name, contact, email, phone, city, commission_pct,
         password_hash, is_active) VALUES (?,?,?,?,?,?,?,?,1)',
      [$code, $name, 'Yetkili', $email, '05551112233', 'Antalya',
       number_format($pct, 2, '.', ''), password_hash($BAYI_PASS, PASSWORD_BCRYPT)]);
    return lastId();
}

function drop_fixture(): void {
    foreach (['para-a@ornek.test', 'para-b@ornek.test', 'para-c@ornek.test',
              'para-yenileme@ornek.test', 'para-kdv@ornek.test'] as $m) drop_para_tenant($m);
    q("DELETE FROM np_resellers WHERE code LIKE 'PTB%'");
}

echo "\nNOKTApp POS - bayiler ve para\n";
echo str_repeat('-', 62) . "\n";

drop_fixture();

$RA = make_para_reseller('PTBA', 'Para Test Bayi A', 'para-bayi-a@ornek.test', 12.50);
$RB = make_para_reseller('PTBB', 'Para Test Bayi B', 'para-bayi-b@ornek.test', 20.00);

/* A belongs to reseller A, B to reseller B, C to nobody. Deliberately similar,
   so a query that forgets its reseller scope has something to leak into. */
$A = make_para_tenant('PTPARA_A', 'Para Test A Lokantası', 'para-a@ornek.test', $RA, 12000.00, 200);
$B = make_para_tenant('PTPARA_B', 'Para Test B Restoran', 'para-b@ornek.test', $RB, 9000.00, 200);
$C = make_para_tenant('PTPARA_C', 'Para Test C Doğrudan', 'para-c@ornek.test', null, 6000.00, 200);
$Y = make_para_tenant('PTPARA_Y', 'Para Test Yenileme', 'para-yenileme@ornek.test', $RA, 4800.00, 10);
$K = make_para_tenant('PTPARA_K', 'Para Test KDV', 'para-kdv@ornek.test', null, 1234.57, 300);

/* ===================================================================== */
echo "\n1. KDV - iki yonde de, gercek bir fatura uzerinde\n";

/*
 * 1.234,57 TL is chosen because it does not divide cleanly by 1,2: the tax
 * inside it is 205,76166..., so the rounding has to land somewhere and the two
 * halves still have to add back up to the penny.
 */
$gross = 1234.57;
$invGrossId = 0;

check('KDV dahil bir tutardan kesilen fatura: matrah + KDV = genel toplam', function () use ($K, $gross, &$invGrossId) {
    $invGrossId = para_invoice_create(['tenant_id' => $K['id'], 'gross' => $gross, 'vat_rate' => 20,
        'status' => 'sent', 'note' => 'KDV dahil test']);
    assertThat($invGrossId > 0, 'fatura kesilemedi');
    $inv = one('SELECT * FROM np_invoices WHERE id=?', [$invGrossId]);
    $netK = para_k($inv['amount']); $totK = para_k($inv['total']); $vatK = para_invoice_vat_k($inv);

    assertKurus(123457, $totK, 'genel toplam girilen KDV dahil tutar olmali');
    /* The contract's formula, computed here independently of lib/para.php. */
    assertKurus((int) round(123457 * 20 / 120), $vatK, 'KDV = brut * oran / (100 + oran)');
    assertKurus(20576, $vatK, 'KDV kurusu');
    assertKurus(102881, $netK, 'matrah');
    assertKurus($totK, $netK + $vatK, 'matrah + KDV genel toplama esit degil');
});

check('KDV, fiyatin uzerine EKLENMIYOR', function () use ($invGrossId, $gross) {
    $inv = one('SELECT * FROM np_invoices WHERE id=?', [$invGrossId]);
    /* The mistake this guards against: 1234.57 * 1.20 = 1481.48. If the total
       ever comes back as that, the panel added the tax on top of a price the
       customer was already quoted. */
    assertThat(para_k($inv['total']) !== para_k($gross * 1.20),
        'KDV fiyatin uzerine eklenmis: genel toplam ' . $inv['total']);
    assertKurus(para_k($gross), para_k($inv['total']), 'genel toplam degismis olmamali');
});

check('KDV haric bir matrahtan kesilen fatura ayni ucluyu veriyor', function () use ($K) {
    $id = para_invoice_create(['tenant_id' => $K['id'], 'net' => 1028.81, 'vat_rate' => 20,
        'issued_at' => date('Y-m-d', strtotime('-1 day')), 'status' => 'sent', 'note' => 'KDV haric test']);
    assertThat($id > 0, 'fatura kesilemedi');
    $inv = one('SELECT * FROM np_invoices WHERE id=?', [$id]);
    assertKurus(102881, para_k($inv['amount']), 'matrah girilen tutar olmali');
    assertKurus((int) round(102881 * 20 / 100), para_invoice_vat_k($inv), 'KDV = matrah * oran / 100');
    assertKurus(123457, para_k($inv['total']), 'genel toplam matrah + KDV olmali');
    assertKurus(para_k($inv['total']), para_k($inv['amount']) + para_invoice_vat_k($inv), 'ucluyu tutmuyor');
});

check('KDV hesabi 1 kurusluk tutarlarda bile toplamı bozmuyor', function () use ($K) {
    /* Fifty awkward figures, each asserted on the invariant that actually
       matters: whatever the rounding did, the two stored figures and the tax
       between them still add up. */
    for ($i = 1; $i <= 50; $i++) {
        $g = 0.01 * $i * 7 + $i;              // 1.07, 2.14, 3.21 ...
        $s = para_split_gross(para_k($g), 20);
        assertKurus($s['total'], $s['net'] + $s['vat'], 'brut bolme tutmuyor: ' . $g);
        $n = para_split_net(para_k($g), 20);
        assertKurus($n['total'], $n['net'] + $n['vat'], 'net bolme tutmuyor: ' . $g);
        $r = para_split_gross(para_k($g), 10);
        assertKurus($r['total'], $r['net'] + $r['vat'], '%10 brut bolme tutmuyor: ' . $g);
    }
});

/* ===================================================================== */
echo "\n2. Bakiye, kendi satirlarinin toplamina kurusu kurusuna esit\n";

check('bakiye = kesilen - tahsil edilen, iptaller haric', function () use ($A) {
    $tid = (int) $A['id'];
    /* An awkward spread on purpose: two invoices at different rates, a part
       payment, a payment with no invoice behind it, and a cancelled invoice
       that must not be counted anywhere. */
    $i1 = para_invoice_create(['tenant_id' => $tid, 'gross' => 12000.00, 'vat_rate' => 20,
        'issued_at' => date('Y-m-d', strtotime('-40 day')), 'due_at' => date('Y-m-d', strtotime('-26 day')),
        'period_start' => date('Y-m-d', strtotime('-40 day')), 'period_end' => date('Y-m-d', strtotime('+325 day')),
        'status' => 'sent']);
    $i2 = para_invoice_create(['tenant_id' => $tid, 'net' => 3333.33, 'vat_rate' => 10,
        'issued_at' => date('Y-m-d', strtotime('-8 day')), 'due_at' => date('Y-m-d', strtotime('+6 day')),
        'status' => 'sent']);
    $i3 = para_invoice_create(['tenant_id' => $tid, 'gross' => 999.99, 'vat_rate' => 20,
        'issued_at' => date('Y-m-d', strtotime('-3 day')), 'status' => 'draft']);
    q("UPDATE np_invoices SET status='cancelled' WHERE id=?", [$i3]);

    para_payment_add(['tenant_id' => $tid, 'invoice_id' => $i1, 'amount' => 5000.00,
                      'paid_at' => date('Y-m-d', strtotime('-20 day')), 'method' => 'havale']);
    para_payment_add(['tenant_id' => $tid, 'invoice_id' => $i2, 'amount' => 1111.11,
                      'paid_at' => date('Y-m-d', strtotime('-2 day')), 'method' => 'nakit']);
    para_payment_add(['tenant_id' => $tid, 'invoice_id' => null, 'amount' => 250.55,
                      'paid_at' => date('Y-m-d'), 'method' => 'diger', 'note' => 'avans']);

    /* Add the ROWS up here, independently of the function under test, exactly
       as the customer page lists them. */
    $invK = 0; $netK = 0;
    foreach (para_tenant_invoices($tid) as $r) {
        if ($r['status'] === 'cancelled') continue;
        $invK += para_k($r['total']);
        $netK += para_k($r['amount']);
    }
    $payK = 0;
    foreach (para_tenant_payments($tid) as $r) $payK += para_k($r['amount']);

    $bal = para_tenant_balance($tid);
    assertKurus($invK, $bal['invoiced'], 'kesilen toplam satirlarla ayni degil');
    assertKurus($netK, $bal['net'], 'matrah toplami satirlarla ayni degil');
    assertKurus($invK - $netK, $bal['vat'], 'KDV toplami matrah/toplam farkina esit degil');
    assertKurus($payK, $bal['paid'], 'tahsilat toplami satirlarla ayni degil');
    assertKurus($invK - $payK, $bal['balance'], 'BAKIYE satirlarin toplamina esit degil');
});

check('iptal edilen fatura hicbir toplama girmiyor', function () use ($A) {
    $tid = (int) $A['id'];
    $before = para_tenant_balance($tid);
    $x = para_invoice_create(['tenant_id' => $tid, 'gross' => 50000.00, 'vat_rate' => 20,
        'issued_at' => date('Y-m-d'), 'status' => 'sent']);
    q("UPDATE np_invoices SET status='cancelled' WHERE id=?", [$x]);
    $after = para_tenant_balance($tid);
    assertKurus($before['balance'], $after['balance'], 'iptal fatura bakiyeyi degistirdi');
    assertKurus($before['invoiced'], $after['invoiced'], 'iptal fatura kesilen toplamina girdi');
});

/* ===================================================================== */
echo "\n3. Yenileme calistirmasi - iki kez calistirmak tek fatura kesiyor\n";

/*
 * The renewal run is a WHOLE-BOOK action - it has to be, that is the feature -
 * so running it here issues real invoices for every real customer whose licence
 * is about to expire. Their ids are collected and deleted at teardown, so a
 * test run leaves the vendor's book exactly as it found it. Testing it on a
 * narrowed-down copy of the function instead would test something that is not
 * the thing the button calls.
 */
$RENEWED = [];

check('yenileme calistirmasi bekleyen lisansa fatura kesiyor', function () use ($Y, &$RENEWED) {
    $r = para_renewal_run(30);
    $RENEWED = array_merge($RENEWED, $r['ids']);
    assertThat($r['created'] >= 1, 'hicbir yenileme faturasi kesilmedi');
    $n = (int) val('SELECT COUNT(*) FROM np_invoices WHERE tenant_id=?', [$Y['id']]);
    assertSame(1, $n, 'yenileme faturasi sayisi');
});

check('AYNI calistirma ikinci kez tek bir fatura bile kesmiyor', function () use ($Y, &$RENEWED) {
    $before = (int) val('SELECT COUNT(*) FROM np_invoices');
    $r = para_renewal_run(30);
    $RENEWED = array_merge($RENEWED, $r['ids']);
    $after = (int) val('SELECT COUNT(*) FROM np_invoices');
    assertSame(0, $r['created'], 'ikinci calistirmada fatura kesildi');
    assertThat($r['skipped'] >= 1, 'ikinci calistirma atlanan fatura bildirmedi');
    assertSame($before, $after, 'toplam fatura sayisi degisti');
    assertSame(1, (int) val('SELECT COUNT(*) FROM np_invoices WHERE tenant_id=?', [$Y['id']]),
        'ayni musteriye ayni donem icin ikinci fatura kesildi');
});

check('daha genis bir pencerede calistirmak da ayni donemi tekrarlamiyor', function () use ($Y, &$RENEWED) {
    $r = para_renewal_run(90);
    $RENEWED = array_merge($RENEWED, $r['ids']);
    assertSame(1, (int) val('SELECT COUNT(*) FROM np_invoices WHERE tenant_id=?', [$Y['id']]),
        '90 gunluk pencere ayni donemi tekrar kesti');
});

check('yenileme faturasi lisans ucretini KDV DAHIL kabul ediyor', function () use ($Y) {
    $inv = one('SELECT * FROM np_invoices WHERE tenant_id=? ORDER BY id DESC LIMIT 1', [$Y['id']]);
    assertKurus(480000, para_k($inv['total']), 'genel toplam lisans ucretine esit olmali');
    assertKurus(80000, para_invoice_vat_k($inv), 'KDV, 4800 TL nin icinden cikmali');
    assertKurus(400000, para_k($inv['amount']), 'matrah');
});

check('yenileme donemi lisansin bitisinin ERTESI gunu basliyor', function () use ($Y) {
    $lic = one('SELECT * FROM np_licences WHERE tenant_id=? ORDER BY id DESC LIMIT 1', [$Y['id']]);
    $inv = one('SELECT * FROM np_invoices WHERE tenant_id=? ORDER BY id DESC LIMIT 1', [$Y['id']]);
    $want = date('Y-m-d', strtotime(substr((string) $lic['expires_at'], 0, 10) . ' +1 day'));
    assertSame($want, (string) $inv['period_start'], 'donem baslangici');
    assertSame(date('Y-m-d', strtotime($want . ' +1 year -1 day')), (string) $inv['period_end'], 'donem bitisi');
});

/* ===================================================================== */
echo "\n4. Tahsilat - tam odeme kapatir, kismi odeme kapatmaz\n";

$partialInv = 0;
check('kismi odeme faturayi ODENDI yapmiyor', function () use ($B, &$partialInv) {
    $partialInv = para_invoice_create(['tenant_id' => $B['id'], 'gross' => 1200.00, 'vat_rate' => 20,
        'issued_at' => date('Y-m-d'), 'due_at' => date('Y-m-d', strtotime('+14 day')), 'status' => 'sent']);
    para_payment_add(['tenant_id' => $B['id'], 'invoice_id' => $partialInv, 'amount' => 500.00,
                      'paid_at' => date('Y-m-d'), 'method' => 'havale']);
    $inv = one('SELECT * FROM np_invoices WHERE id=?', [$partialInv]);
    assertThat($inv['status'] !== 'paid', 'kismi odeme faturayi kapatti');
    assertSame('sent', $inv['status'], 'kismi odeme sonrasi durum');
    assertKurus(50000, para_paid_k($partialInv), 'tahsil edilen');
});

check('kalani da odenince fatura ODENDI oluyor', function () use ($B, &$partialInv) {
    para_payment_add(['tenant_id' => $B['id'], 'invoice_id' => $partialInv, 'amount' => 700.00,
                      'paid_at' => date('Y-m-d'), 'method' => 'nakit']);
    $inv = one('SELECT * FROM np_invoices WHERE id=?', [$partialInv]);
    assertSame('paid', $inv['status'], 'tam odeme sonrasi durum');
    assertKurus(120000, para_paid_k($partialInv), 'tahsil edilen');
});

check('odeme silinince fatura yeniden aciliyor', function () use (&$partialInv) {
    $p = one('SELECT * FROM np_payments WHERE invoice_id=? ORDER BY id DESC LIMIT 1', [$partialInv]);
    q('DELETE FROM np_payments WHERE id=?', [$p['id']]);
    para_invoice_settle($partialInv);
    $inv = one('SELECT * FROM np_invoices WHERE id=?', [$partialInv]);
    assertThat($inv['status'] !== 'paid', 'odeme silindigi halde fatura odendi kaldi');
    /* put it back so the rest of the suite sees a settled invoice */
    para_payment_add(['tenant_id' => (int) $inv['tenant_id'], 'invoice_id' => $partialInv,
                      'amount' => 700.00, 'paid_at' => date('Y-m-d'), 'method' => 'nakit']);
    assertSame('paid', one('SELECT status FROM np_invoices WHERE id=?', [$partialInv])['status'], 'geri alma');
});

check('baska bir musterinin faturasina odeme yazilamiyor', function () use ($A, $B, &$partialInv) {
    $id = para_payment_add(['tenant_id' => (int) $A['id'], 'invoice_id' => $partialInv,
                            'amount' => 100.00, 'paid_at' => date('Y-m-d'), 'method' => 'havale']);
    assertSame(0, $id, 'baska musterinin faturasina odeme kaydedildi');
    assertKurus(120000, para_paid_k($partialInv), 'fatura tahsilati degisti');
});

/* ===================================================================== */
echo "\n5. Yaslandirma\n";

check('vadesi gecen fatura GECIKTI oluyor ve gun sayisi dogru', function () use ($C) {
    $id = para_invoice_create(['tenant_id' => $C['id'], 'gross' => 6000.00, 'vat_rate' => 20,
        'issued_at' => date('Y-m-d', strtotime('-59 day')),
        'due_at' => date('Y-m-d', strtotime('-45 day')), 'status' => 'sent']);
    para_touch_overdue();
    $inv = one('SELECT * FROM np_invoices WHERE id=?', [$id]);
    assertSame('overdue', $inv['status'], 'vadesi 45 gun once gecen fatura durumu');
    assertSame(45, para_ageing_days($inv), 'gecikme gunu');
    assertSame('31-60', para_ageing_bucket(45), 'yaslandirma kovasi');
});

check('vadesi gelmemis fatura GECIKTI olmuyor', function () use ($C) {
    $id = para_invoice_create(['tenant_id' => $C['id'], 'gross' => 1500.00, 'vat_rate' => 20,
        'issued_at' => date('Y-m-d'), 'due_at' => date('Y-m-d', strtotime('+10 day')), 'status' => 'sent']);
    para_touch_overdue();
    $inv = one('SELECT * FROM np_invoices WHERE id=?', [$id]);
    assertSame('sent', $inv['status'], 'vadesi gelmemis fatura durumu');
    assertSame(null, para_ageing_days($inv), 'gecikme gunu bos olmali');
});

check('odenmis fatura, vadesi gecmis olsa bile geciken alacakta gorunmuyor', function () use ($C) {
    $id = para_invoice_create(['tenant_id' => $C['id'], 'gross' => 2400.00, 'vat_rate' => 20,
        'issued_at' => date('Y-m-d', strtotime('-100 day')),
        'due_at' => date('Y-m-d', strtotime('-86 day')), 'status' => 'sent']);
    para_payment_add(['tenant_id' => (int) $C['id'], 'invoice_id' => $id, 'amount' => 2400.00,
                      'paid_at' => date('Y-m-d', strtotime('-80 day')), 'method' => 'havale']);
    para_touch_overdue();
    $inv = one('SELECT * FROM np_invoices WHERE id=?', [$id]);
    assertSame('paid', $inv['status'], 'tamami odenmis fatura durumu');
    assertSame(null, para_ageing_days($inv), 'odenmis fatura yaslandirmaya girdi');
});

check('yaslandirma kovalari acik alacagin tamamini kapsiyor', function () {
    $age = para_ageing();
    $sum = array_sum($age['buckets']);
    assertKurus($age['late'], $sum, 'kovalarin toplami gecikmis alacaga esit degil');
    assertThat($age['open'] >= $age['late'], 'gecikmis alacak toplam acik alacaktan buyuk');
});

check('kova sinirlari', function () {
    assertSame('0-30', para_ageing_bucket(1), '1 gun');
    assertSame('0-30', para_ageing_bucket(30), '30 gun');
    assertSame('31-60', para_ageing_bucket(31), '31 gun');
    assertSame('61-90', para_ageing_bucket(90), '90 gun');
    assertSame('90+', para_ageing_bucket(91), '91 gun');
});

/* ===================================================================== */
echo "\n6. Bayi kapisi - bir bayi yalnizca kendi musterilerini goruyor\n";

check('bayi listesi yalnizca kendi musterilerini iceriyor', function () use ($RA, $RB, $A, $B, $C) {
    $mine = array_column(bayi_customers($RA), 'id');
    assertThat(in_array((int) $A['id'], array_map('intval', $mine), true), 'kendi musterisi listede yok');
    assertThat(!in_array((int) $B['id'], array_map('intval', $mine), true), 'BASKA BAYININ musterisi listede');
    assertThat(!in_array((int) $C['id'], array_map('intval', $mine), true), 'bayisiz musteri listede');
});

check('bayi, baska bayinin musterisine id tahmin ederek ulasamiyor', function () use ($RA, $RB, $A, $B, $C) {
    assertSame(null, bayi_tenant($RA, (int) $B['id']), 'A, B nin musterisini okudu');
    assertSame(null, bayi_tenant($RB, (int) $A['id']), 'B, A nin musterisini okudu');
    assertSame(null, bayi_tenant($RA, (int) $C['id']), 'bayisiz musteri bayiye acildi');
    assertThat(bayi_tenant($RA, (int) $A['id']) !== null, 'bayi kendi musterisini okuyamadi');
});

check('bayi, baska bayinin faturasina id tahmin ederek ulasamiyor', function () use ($RA, $RB, $A, $B) {
    $ownA = one('SELECT id FROM np_invoices WHERE tenant_id=? LIMIT 1', [$A['id']]);
    $ownB = one('SELECT id FROM np_invoices WHERE tenant_id=? LIMIT 1', [$B['id']]);
    assertThat($ownA && $ownB, 'test faturalari yok');
    assertSame(null, bayi_invoice($RA, (int) $ownB['id']), 'A, B nin faturasini okudu');
    assertSame(null, bayi_invoice($RB, (int) $ownA['id']), 'B, A nin faturasini okudu');
    assertThat(bayi_invoice($RA, (int) $ownA['id']) !== null, 'bayi kendi faturasini okuyamadi');
});

check('bayi, baska bayinin odemesine id tahmin ederek ulasamiyor', function () use ($RA, $RB, $A, $B) {
    $pA = one('SELECT id FROM np_payments WHERE tenant_id=? LIMIT 1', [$A['id']]);
    $pB = one('SELECT id FROM np_payments WHERE tenant_id=? LIMIT 1', [$B['id']]);
    assertThat($pA && $pB, 'test odemeleri yok');
    assertSame(null, bayi_payment($RA, (int) $pB['id']), 'A, B nin odemesini okudu');
    assertSame(null, bayi_payment($RB, (int) $pA['id']), 'B, A nin odemesini okudu');
    assertThat(bayi_payment($RA, (int) $pA['id']) !== null, 'bayi kendi odemesini okuyamadi');
});

check('bayinin fatura ve odeme listeleri baska bayiye sizmiyor', function () use ($RA, $RB, $A, $B) {
    foreach (bayi_invoices($RA) as $r) assertThat((int) $r['tenant_id'] !== (int) $B['id'], 'A nin fatura listesinde B var');
    foreach (bayi_invoices($RB) as $r) assertThat((int) $r['tenant_id'] !== (int) $A['id'], 'B nin fatura listesinde A var');
    foreach (bayi_payments($RA) as $r) assertThat((int) $r['tenant_id'] !== (int) $B['id'], 'A nin odeme listesinde B var');
    foreach (bayi_payments($RB) as $r) assertThat((int) $r['tenant_id'] !== (int) $A['id'], 'B nin odeme listesinde A var');
});

check('bayi toplamlari yalnizca kendi musterilerinden olusuyor', function () use ($RA, $A) {
    $tot = bayi_totals($RA);
    $own = 0;
    foreach (bayi_invoices($RA) as $r) if ($r['status'] !== 'cancelled') $own += para_k($r['total']);
    assertKurus($own, $tot['invoiced'], 'bayi kesilen toplami kendi satirlarina esit degil');
    assertThat($tot['customers'] === (int) val('SELECT COUNT(*) FROM np_tenants WHERE reseller_id=?', [$RA]),
        'musteri sayisi');
});

check('komisyon yalnizca ODENMIS faturalarin MATRAHI uzerinden', function () use ($RA) {
    $base = 0;
    foreach (bayi_invoices($RA) as $r) if ($r['status'] === 'paid') $base += para_k($r['amount']);
    $tot = bayi_totals($RA);
    assertKurus($base, $tot['base'], 'komisyon tabani odenmis faturalarin matrahi degil');
    assertKurus((int) round($base * 12.5 / 100), $tot['commission'], 'komisyon');
});

/* ===================================================================== */
echo "\n7. Iki kapi - biri digerinin adresini acmiyor\n";

check('bayi girisi yapiliyor', function () use ($PANEL, $JAR_BAYI, $BAYI_PASS) {
    http($JAR_BAYI, 'GET', $PANEL . '/bayi/index.php?p=login');
    $r = http($JAR_BAYI, 'POST', $PANEL . '/bayi/index.php?p=login',
              ['email' => 'para-bayi-a@ornek.test', 'password' => $BAYI_PASS]);
    assertSame(302, $r['status'], 'giris HTTP durumu');
    assertThat(strpos($r['location'], 'p=home') !== false, 'girisin ardindan bayi paneline gitmeli');
});

check('ikinci bayi de kendi oturumuyla giriyor', function () use ($PANEL, $JAR_BAYI2, $BAYI_PASS) {
    http($JAR_BAYI2, 'GET', $PANEL . '/bayi/index.php?p=login');
    $r = http($JAR_BAYI2, 'POST', $PANEL . '/bayi/index.php?p=login',
              ['email' => 'para-bayi-b@ornek.test', 'password' => $BAYI_PASS]);
    assertSame(302, $r['status'], 'giris HTTP durumu');
});

check('yanlis sifre reddediliyor', function () use ($PANEL, $BAYI_PASS) {
    $jar = sys_get_temp_dir() . '/np-para-bad-' . getmypid() . '.cookies';
    @unlink($jar);
    $r = http($jar, 'POST', $PANEL . '/bayi/index.php?p=login',
              ['email' => 'para-bayi-a@ornek.test', 'password' => $BAYI_PASS . 'x']);
    assertSame(200, $r['status'], 'yanlis sifre yonlendirdi');
    assertThat(strpos($r['body'], 'E-posta veya şifre hatalı') !== false, 'hata mesaji yok');
    $r2 = http($jar, 'GET', $PANEL . '/bayi/index.php?p=home');
    assertSame(302, $r2['status'], 'basarisiz giristen sonra oturum acilmis');
    @unlink($jar);
});

check('yonetici girisi yapiliyor', function () use ($PANEL, $JAR_ADMIN, $ADMIN, $ADMIN_PASS) {
    http($JAR_ADMIN, 'GET', $PANEL . '/admin/index.php?p=login');
    $r = http($JAR_ADMIN, 'POST', $PANEL . '/admin/index.php?p=login',
              ['email' => $ADMIN, 'password' => $ADMIN_PASS]);
    assertSame(302, $r['status'], 'giris HTTP durumu');
    assertThat(strpos($r['location'], 'p=home') !== false, 'girisin ardindan panele gitmeli');
});

check('BAYI oturumu yonetici ekranini acamiyor', function () use ($PANEL, $JAR_BAYI, $A) {
    foreach (['home', 'faturalar', 'odemeler', 'gelir', 'bayiler', 'tenants',
              'tenant&id=' . $A['id']] as $pg) {
        $r = http($JAR_BAYI, 'GET', $PANEL . '/admin/index.php?p=' . $pg);
        assertSame(302, $r['status'], "?p=$pg HTTP durumu");
        assertThat(strpos($r['location'], 'p=login') !== false, "?p=$pg girise yonlenmeli");
        assertThat(strpos($r['body'], $A['name']) === false, "?p=$pg govdesinde isletme adi var");
    }
});

check('YONETICI oturumu bayi kapisini acamiyor', function () use ($PANEL, $JAR_ADMIN, $A) {
    foreach (['home', 'musteriler', 'faturalar', 'odemeler', 'komisyon',
              'musteri&id=' . $A['id']] as $pg) {
        $r = http($JAR_ADMIN, 'GET', $PANEL . '/bayi/index.php?p=' . $pg);
        assertSame(302, $r['status'], "bayi ?p=$pg HTTP durumu");
        assertThat(strpos($r['location'], 'p=login') !== false, "bayi ?p=$pg girise yonlenmeli");
        assertThat(strpos($r['body'], $A['name']) === false, "bayi ?p=$pg govdesinde isletme adi var");
    }
});

check('oturumsuz ziyaretci bayi kapisinda hicbir sey goremiyor', function () use ($PANEL, $A) {
    foreach (['home', 'musteriler', 'faturalar', 'odemeler', 'komisyon',
              'musteri&id=' . $A['id']] as $pg) {
        $r = http(null, 'GET', $PANEL . '/bayi/index.php?p=' . $pg);
        assertSame(302, $r['status'], "bayi ?p=$pg HTTP durumu");
        assertThat(strpos($r['location'], 'p=login') !== false, "bayi ?p=$pg girise yonlenmeli");
        assertThat(strpos($r['body'], $A['name']) === false, "bayi ?p=$pg govdesinde isletme adi var");
    }
});

check('bayi kendi ekranlarini aciyor', function () use ($PANEL, $JAR_BAYI, $A) {
    foreach (['home' => 'Genel', 'musteriler' => 'Müşterilerim', 'faturalar' => 'Faturalar',
              'odemeler' => 'Tahsilatlar', 'komisyon' => 'Komisyonum'] as $pg => $needle) {
        $r = http($JAR_BAYI, 'GET', $PANEL . '/bayi/index.php?p=' . $pg);
        assertRendered($r, "bayi ?p=$pg");
        assertThat(strpos($r['body'], $needle) !== false, "bayi ?p=$pg icerigi: $needle yok");
    }
    $r = http($JAR_BAYI, 'GET', $PANEL . '/bayi/index.php?p=musteri&id=' . $A['id']);
    assertRendered($r, 'bayi musteri');
    assertThat(strpos($r['body'], $A['name']) !== false, 'bayi kendi musterisini goremedi');
});

check('bayi, EKRANDA da baska bayinin musterisini goremiyor', function () use ($PANEL, $JAR_BAYI, $B) {
    $r = http($JAR_BAYI, 'GET', $PANEL . '/bayi/index.php?p=musteri&id=' . $B['id']);
    assertSame(200, $r['status'], 'HTTP durumu');
    assertThat(strpos($r['body'], $B['name']) === false, 'BASKA BAYININ musteri adi ekranda');
    assertThat(strpos($r['body'], 'Kayıt yok') !== false, '"kayit yok" mesaji gelmedi');
});

check('bayi, EKRANDA da baska bayinin faturasini goremiyor', function () use ($PANEL, $JAR_BAYI, $B) {
    $inv = one('SELECT * FROM np_invoices WHERE tenant_id=? LIMIT 1', [$B['id']]);
    $r = http($JAR_BAYI, 'GET', $PANEL . '/bayi/index.php?p=fatura&id=' . $inv['id']);
    assertSame(200, $r['status'], 'HTTP durumu');
    assertThat(strpos($r['body'], (string) $inv['no']) === false, 'baska bayinin fatura numarasi ekranda');
    assertThat(strpos($r['body'], $B['name']) === false, 'baska bayinin isletme adi ekranda');
});

check('bayi listesinde diger bayinin musterisi yok', function () use ($PANEL, $JAR_BAYI, $JAR_BAYI2, $A, $B) {
    $ra = http($JAR_BAYI, 'GET', $PANEL . '/bayi/index.php?p=musteriler');
    assertThat(strpos($ra['body'], $A['name']) !== false, 'A kendi musterisini goremedi');
    assertThat(strpos($ra['body'], $B['name']) === false, 'A, B nin musterisini gordu');
    $rb = http($JAR_BAYI2, 'GET', $PANEL . '/bayi/index.php?p=musteriler');
    assertThat(strpos($rb['body'], $B['name']) !== false, 'B kendi musterisini goremedi');
    assertThat(strpos($rb['body'], $A['name']) === false, 'B, A nin musterisini gordu');
});

check('bayi ekranlarinda diger bayinin ADI hicbir yerde gecmiyor', function () use ($PANEL, $JAR_BAYI) {
    foreach (['home', 'musteriler', 'faturalar', 'odemeler', 'komisyon'] as $pg) {
        $r = http($JAR_BAYI, 'GET', $PANEL . '/bayi/index.php?p=' . $pg);
        assertThat(strpos($r['body'], 'Para Test Bayi B') === false, "?p=$pg diger bayinin adini gosterdi");
    }
});

check('pasife alinan bayi bir sonraki tiklamada disari cikiyor', function () use ($PANEL, $JAR_BAYI2, $RB, $BAYI_PASS) {
    q('UPDATE np_resellers SET is_active=0 WHERE id=?', [$RB]);
    $r = http($JAR_BAYI2, 'GET', $PANEL . '/bayi/index.php?p=home');
    assertSame(302, $r['status'], 'pasif bayi ekrani acabildi');
    q('UPDATE np_resellers SET is_active=1 WHERE id=?', [$RB]);
    /* the session was destroyed; sign in again so the jar is usable after */
    http($JAR_BAYI2, 'POST', $PANEL . '/bayi/index.php?p=login',
         ['email' => 'para-bayi-b@ornek.test', 'password' => $BAYI_PASS]);
});

/* ===================================================================== */
echo "\n8. Yeni ekranlar: yonetici olarak aciliyor, oturumsuz yonlendiriyor\n";

$invA = one('SELECT id FROM np_invoices WHERE tenant_id=? LIMIT 1', [$A['id']]);
$payA = one('SELECT id FROM np_payments WHERE tenant_id=? LIMIT 1', [$A['id']]);

$screens = [
    'bayiler' => 'Bayiler',
    'bayi&id=' . $RA => 'Para Test Bayi A',
    'faturalar' => 'Faturalar',
    'faturalar&s=overdue' => 'Fatura listesi',
    'faturalar&tenant=' . $A['id'] => 'Fatura listesi',
    'fatura&id=' . $invA['id'] => 'Fatura dökümü',
    'fatura&id=0&tenant=' . $A['id'] => 'Yeni fatura',
    'odemeler' => 'Tahsilat listesi',
    'odeme' => 'Ödeme kaydet',
    'odeme&id=' . $payA['id'] => 'Tahsilat',
    'gelir' => 'Ay ay gelir',
    'tenant&id=' . $A['id'] => 'Faturalar',
];
foreach ($screens as $pg => $needle) {
    check("?p={$pg} yonetici olarak aciliyor", function () use ($PANEL, $JAR_ADMIN, $pg, $needle) {
        $r = http($JAR_ADMIN, 'GET', $PANEL . '/admin/index.php?p=' . $pg);
        assertRendered($r, "?p=$pg");
        assertThat(strpos($r['body'], $needle) !== false, "?p=$pg icerigi: '$needle' bulunamadi");
        assertThat(strpos($r['body'], 'Hazırlanıyor') === false, "?p=$pg hala 'hazirlaniyor' notunu gosteriyor");
        assertThat(strpos($r['body'], 'Sayfa bulunamadı') === false, "?p=$pg 404 ekrani gosterdi");
    });
}
foreach (array_keys($screens) as $pg) {
    check("oturumsuz ?p={$pg} girise yonlendiriyor", function () use ($PANEL, $pg, $A) {
        $r = http(null, 'GET', $PANEL . '/admin/index.php?p=' . $pg);
        assertSame(302, $r['status'], 'HTTP durumu');
        assertThat(strpos($r['location'], 'p=login') !== false, 'login sayfasina yonlendirmeli, giden: ' . $r['location']);
        assertThat(strpos($r['body'], $A['name']) === false, 'yonlendirme govdesinde isletme adi var');
    });
}

check('musteri sayfasindaki bakiye, ayni sayfadaki satirlarin toplami', function () use ($PANEL, $JAR_ADMIN, $A) {
    $bal = para_tenant_balance((int) $A['id']);
    $r = http($JAR_ADMIN, 'GET', $PANEL . '/admin/index.php?p=tenant&id=' . $A['id']);
    assertRendered($r, 'musteri sayfasi');
    /* The exact string the owner reads. If the page ever computed the balance a
       second way, this is where the two figures would part company. */
    assertThat(strpos($r['body'], para_tl($bal['balance'])) !== false,
        'ekranda bakiye yok: ' . para_tl($bal['balance']));
    assertThat(strpos($r['body'], 'Matrah') !== false, 'matrah/KDV ayrimi ekranda yok');
});

/* ===================================================================== */
echo "\n9. Yazma yolu: ekranlarin gonderdigi POST'lar\n";

/*
 * Everything above exercises lib/para.php directly. This section drives the
 * WRITE path the screens actually use - admin/para.php, reached through the
 * panel's one POST block - because that is where a missing CSRF check, a lost
 * redirect or a form field read under the wrong name would live, and none of
 * those is visible from the library side.
 */
function admin_csrf(string $panel, string $jar): string {
    $r = http($jar, 'GET', $panel . '/admin/index.php?p=home');
    if (!preg_match('/name="csrf" value="([a-f0-9]+)"/', $r['body'], $m)) {
        throw new RuntimeException('csrf alinamadi');
    }
    return $m[1];
}
function admin_post(string $panel, string $jar, array $form): array {
    $form['csrf'] = admin_csrf($panel, $jar);
    return http($jar, 'POST', $panel . '/admin/index.php', $form);
}

check('CSRF belirteci olmayan POST reddediliyor', function () use ($PANEL, $JAR_ADMIN, $A) {
    $r = http($JAR_ADMIN, 'POST', $PANEL . '/admin/index.php',
              ['action' => 'fatura_create', 'tenant_id' => $A['id'], 'basis' => 'gross', 'amount' => '100']);
    assertSame(400, $r['status'], 'CSRF olmadan POST kabul edildi');
    assertSame(0, (int) val("SELECT COUNT(*) FROM np_invoices WHERE tenant_id=? AND total=100.00", [$A['id']]),
        'CSRF olmadan fatura kesildi');
});

$smokeRid = 0;
check('bayi_save yeni bayi olusturuyor', function () use ($PANEL, $JAR_ADMIN, &$smokeRid) {
    q("DELETE FROM np_resellers WHERE code='PTBPOST'");
    $r = admin_post($PANEL, $JAR_ADMIN, ['action' => 'bayi_save', 'id' => 0,
        'name' => 'Para Test POST Bayi', 'code' => 'PTBPOST', 'email' => 'para-bayi-post@ornek.test',
        'password' => 'PostTest123', 'commission_pct' => '11,50', 'city' => 'Antalya']);
    assertSame(302, $r['status'], 'HTTP durumu');
    $b = one("SELECT * FROM np_resellers WHERE code='PTBPOST'");
    assertThat($b !== null, 'bayi olusturulmadi');
    /* The form accepts a Turkish decimal comma; the column must still hold a number. */
    assertSame('11.50', (string) $b['commission_pct'], 'komisyon orani');
    assertThat(strpos($r['location'], 'p=bayi&id=' . $b['id']) !== false, 'bayi sayfasina gitmeli');
    $smokeRid = (int) $b['id'];
});

check('tenant_reseller musteriyi bayiye bagliyor ve geri aliyor', function () use ($PANEL, $JAR_ADMIN, $A, $RA, &$smokeRid) {
    admin_post($PANEL, $JAR_ADMIN, ['action' => 'tenant_reseller',
        'tenant_id' => $A['id'], 'reseller_id' => $smokeRid]);
    assertSame($smokeRid, (int) val('SELECT reseller_id FROM np_tenants WHERE id=?', [$A['id']]), 'bayi atanmadi');
    /* And the boundary follows the assignment immediately. */
    assertSame(null, bayi_tenant($RA, (int) $A['id']), 'eski bayi hala musteriyi goruyor');
    assertThat(bayi_tenant($smokeRid, (int) $A['id']) !== null, 'yeni bayi musteriyi goremiyor');
    admin_post($PANEL, $JAR_ADMIN, ['action' => 'tenant_reseller',
        'tenant_id' => $A['id'], 'reseller_id' => $RA]);
    assertSame($RA, (int) val('SELECT reseller_id FROM np_tenants WHERE id=?', [$A['id']]), 'geri alinmadi');
});

$postInv = 0;
check('fatura_create ekrandan KDV DAHIL fatura kesiyor', function () use ($PANEL, $JAR_ADMIN, $K, &$postInv) {
    $ps = date('Y-m-d', strtotime('+400 day'));
    $r = admin_post($PANEL, $JAR_ADMIN, ['action' => 'fatura_create', 'tenant_id' => $K['id'],
        'basis' => 'gross', 'amount' => '1234,57', 'vat_rate' => '20',
        'issued_at' => date('Y-m-d'), 'due_at' => date('Y-m-d', strtotime('+14 day')),
        'period_start' => $ps, 'period_end' => date('Y-m-d', strtotime($ps . ' +1 year -1 day')),
        'status' => 'sent', 'note' => 'POST testi']);
    assertSame(302, $r['status'], 'HTTP durumu');
    $inv = one("SELECT * FROM np_invoices WHERE tenant_id=? AND note='POST testi'", [$K['id']]);
    assertThat($inv !== null, 'fatura kesilmedi');
    assertKurus(123457, para_k($inv['total']), 'genel toplam');
    assertKurus(102881, para_k($inv['amount']), 'matrah');
    assertKurus(20576, para_invoice_vat_k($inv), 'KDV');
    assertSame('sent', $inv['status'], 'durum');
    $postInv = (int) $inv['id'];
});

check('ayni donem icin ikinci fatura EKRANDAN da kesilemiyor', function () use ($PANEL, $JAR_ADMIN, $K, &$postInv) {
    $inv = one('SELECT * FROM np_invoices WHERE id=?', [$postInv]);
    $before = (int) val('SELECT COUNT(*) FROM np_invoices WHERE tenant_id=?', [$K['id']]);
    $r = admin_post($PANEL, $JAR_ADMIN, ['action' => 'fatura_create', 'tenant_id' => $K['id'],
        'basis' => 'gross', 'amount' => '9999', 'vat_rate' => '20',
        'issued_at' => date('Y-m-d'), 'due_at' => '',
        'period_start' => $inv['period_start'], 'period_end' => $inv['period_end'],
        'status' => 'sent', 'note' => 'ikinci']);
    assertSame(302, $r['status'], 'HTTP durumu');
    assertSame($before, (int) val('SELECT COUNT(*) FROM np_invoices WHERE tenant_id=?', [$K['id']]),
        'ayni donem icin ikinci fatura kesildi');
    $r2 = http($JAR_ADMIN, 'GET', $PANEL . '/admin/index.php?p=faturalar');
    assertThat(strpos($r2['body'], 'zaten bir faturası var') !== false, 'kullaniciya sebep soylenmedi');
});

check('odeme_add ekrandan kismi odeme kaydediyor, fatura acik kaliyor', function () use ($PANEL, $JAR_ADMIN, $K, &$postInv) {
    admin_post($PANEL, $JAR_ADMIN, ['action' => 'odeme_add', 'tenant_id' => $K['id'],
        'invoice_id' => $postInv, 'amount' => '234,57', 'paid_at' => date('Y-m-d'),
        'method' => 'havale', 'reference' => 'DEK1', 'note' => '']);
    assertKurus(23457, para_paid_k($postInv), 'tahsil edilen');
    assertThat(one('SELECT status FROM np_invoices WHERE id=?', [$postInv])['status'] !== 'paid',
        'kismi odeme faturayi kapatti');
});

check('odeme_add kalani odeyince fatura ODENDI oluyor', function () use ($PANEL, $JAR_ADMIN, $K, &$postInv) {
    $r = admin_post($PANEL, $JAR_ADMIN, ['action' => 'odeme_add', 'tenant_id' => $K['id'],
        'invoice_id' => $postInv, 'amount' => '1000', 'paid_at' => date('Y-m-d'),
        'method' => 'nakit', 'reference' => '', 'note' => '']);
    assertThat(strpos($r['location'], 'p=fatura&id=' . $postInv) !== false, 'faturaya donmeli');
    assertSame('paid', one('SELECT status FROM np_invoices WHERE id=?', [$postInv])['status'], 'durum');
});

check('tahsilati olan fatura EKRANDAN iptal edilemiyor', function () use ($PANEL, $JAR_ADMIN, &$postInv) {
    admin_post($PANEL, $JAR_ADMIN, ['action' => 'fatura_status', 'id' => $postInv, 'status' => 'cancelled']);
    assertSame('paid', one('SELECT status FROM np_invoices WHERE id=?', [$postInv])['status'],
        'tahsilatli fatura iptal edildi');
});

check('fatura_renew dugmesi calisiyor ve iki kez basmak fatura ikilemiyor', function () use ($PANEL, $JAR_ADMIN, &$RENEWED) {
    $before = array_map('intval', array_column(all('SELECT id FROM np_invoices'), 'id'));
    admin_post($PANEL, $JAR_ADMIN, ['action' => 'fatura_renew', 'days' => 30]);
    $mid = array_map('intval', array_column(all('SELECT id FROM np_invoices'), 'id'));
    $RENEWED = array_merge($RENEWED, array_diff($mid, $before));
    admin_post($PANEL, $JAR_ADMIN, ['action' => 'fatura_renew', 'days' => 30]);
    $after = array_map('intval', array_column(all('SELECT id FROM np_invoices'), 'id'));
    $RENEWED = array_merge($RENEWED, array_diff($after, $mid));
    assertSame(count($mid), count($after), 'dugmeye ikinci kez basmak yeni fatura kesti');
});

check('POST sonrasi kullaniciya sonuc soyleniyor (flash)', function () use ($PANEL, $JAR_ADMIN) {
    $r = http($JAR_ADMIN, 'GET', $PANEL . '/admin/index.php?p=faturalar');
    assertThat(strpos($r['body'], 'yenileme faturası kesildi') !== false, 'yenileme sonucu bildirilmedi');
});

/* ===================================================================== */
check('gelir ekranindaki 12 aylik tahsilat, odeme satirlarinin toplami', function () {
    $months = para_income_by_month(12);
    $sum = 0;
    foreach ($months as $m) $sum += $m['collected'];
    $from = $months[0]['month'] . '-01';
    $rows = para_k(val('SELECT COALESCE(SUM(amount),0) FROM np_payments WHERE paid_at >= ?', [$from]));
    assertKurus($rows, $sum, 'aylik tahsilat toplami satirlarla ayni degil');
});

/* ------------------------------- teardown -------------------------------- */
foreach ([$JAR_ADMIN, $JAR_BAYI, $JAR_BAYI2] as $j) @unlink($j);

/* Give the vendor's book back exactly as it was: every invoice the renewal
   checks issued for a real customer is removed again. */
foreach (array_unique(array_map('intval', $RENEWED)) as $iid) {
    q('DELETE FROM np_payments WHERE invoice_id=?', [$iid]);
    q('DELETE FROM np_invoices WHERE id=?', [$iid]);
}
drop_fixture();

echo "\n$pass/$total checks passed\n";
if ($failures) {
    foreach ($failures as $f) echo "  ! $f\n";
    exit(1);
}
exit(0);
