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
 * NOKTApp POS - chain layer, section 6: consolidated reporting.
 *
 * Everything here runs against the real MariaDB, the real desktop endpoint and
 * the real admin screen over HTTP. Nothing is mocked, because the failures
 * this exists to catch are exactly the ones a mock hides: a retried push that
 * doubles a day's turnover, a corrected re-close that gets ADDED to the day it
 * was meant to replace, a combined total that does not equal the rows printed
 * under it, a branch whose till has been off since Friday quietly reading as
 * zero, and an export whose figures have drifted from the page it came off.
 *
 * Three throwaway tenants are created and destroyed by the run, so the suite
 * never touches the tenants the other tests use.
 *
 * Run:  php panel/tests/rapor.php
 * Env:  NP_DB_PORT (3399) NP_DB_USER (noktapp) NP_DB_PASS (nokpass)
 *       NP_DB_NAME (nokpos_panel)  PANEL (http://127.0.0.1:8090)
 *       PANEL_ADMIN / PANEL_ADMIN_PASS for the screen and export checks
 */
foreach ([
    'NP_DB_HOST' => '127.0.0.1', 'NP_DB_PORT' => '3399', 'NP_DB_NAME' => 'nokpos_panel',
    'NP_DB_USER' => 'noktapp',   'NP_DB_PASS' => 'nokpass',
] as $k => $v) { if (getenv($k) === false) putenv("$k=$v"); }

require_once __DIR__ . '/../lib/rapor.php';
require_once __DIR__ . '/../lib/pdf.php';

$PANEL = getenv('PANEL') ?: 'http://127.0.0.1:8090';
$ADMIN = getenv('PANEL_ADMIN') ?: 'erik@noktapp.com';
$ADMIN_PASS = getenv('PANEL_ADMIN_PASS') ?: 'ChainTest123';
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
/** Money compared as whole kurus. A float comparison here would pass on a bug. */
function assertMoney($a, $b, string $msg): void {
    if (rapor_kurus($a) !== rapor_kurus($b)) {
        throw new RuntimeException($msg . ' (beklenen ' . rapor_money($a) . ', gelen ' . rapor_money($b) . ')');
    }
}

function http_call(string $method, string $url, array $body = [], array $headers = []): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => array_merge(['Content-Type: application/json'], $headers), CURLOPT_TIMEOUT => 30,
    ]);
    if ($body) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($raw === false) throw new RuntimeException('panel yanit vermedi');
    $j = json_decode($raw, true);
    if (!is_array($j)) throw new RuntimeException('gecersiz JSON (' . $status . '): ' . substr($raw, 0, 200));
    return ['status' => $status] + $j;
}

/** A browser session against the admin screens: the exports need a real login. */
$JAR = sys_get_temp_dir() . '/np-rapor-cookies-' . getmypid() . '.txt';
function browse(string $url, array $post = null): array {
    global $JAR;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true, CURLOPT_TIMEOUT => 30,
        CURLOPT_COOKIEJAR => $JAR, CURLOPT_COOKIEFILE => $JAR, CURLOPT_FOLLOWLOCATION => false,
    ]);
    if ($post !== null) { curl_setopt($ch, CURLOPT_POST, true); curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($post)); }
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hlen = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);
    if ($raw === false) throw new RuntimeException('panel yanit vermedi: ' . $url);
    return ['status' => $status, 'headers' => substr($raw, 0, $hlen), 'body' => substr($raw, $hlen)];
}

/* ------------------------------ fixture ------------------------------ */
function drop_tenant(string $email): void {
    $t = one('SELECT id FROM np_tenants WHERE email=?', [$email]);
    if (!$t) return;
    $id = (int) $t['id'];
    foreach (['np_branch_days', 'np_branch_overrides', 'np_menu_version_items', 'np_menu_versions',
              'np_menu_products', 'np_menu_categories', 'np_branches', 'np_devices',
              'np_licences', 'np_reports'] as $tab) {
        q("DELETE FROM {$tab} WHERE tenant_id=?", [$id]);
    }
    q('DELETE FROM np_tenants WHERE id=?', [$id]);
}
function make_tenant(string $code, string $name, string $email): array {
    drop_tenant($email);
    q('INSERT INTO np_tenants (code, company_name, owner_name, email, password_hash, is_active,
                               tax_number, tax_office, address, city)
       VALUES (?,?,?,?,?,1,?,?,?,?)',
      [$code, $name, 'Test', $email, password_hash('x', PASSWORD_BCRYPT),
       '1234567890', 'Muratpaşa VD', 'Test Cad. 1', 'Antalya']);
    $id = lastId();
    $key = strtoupper(bin2hex(random_bytes(12)));
    q("INSERT INTO np_licences (tenant_id, licence_key, plan, status, seats, starts_at, expires_at, grace_days)
       VALUES (?,?,'standart','active',9,CURDATE(), DATE_ADD(NOW(), INTERVAL 365 DAY), 7)", [$id, $key]);
    return ['id' => $id, 'key' => $key];
}
function make_branch(int $tid, string $code, string $name): int {
    q('INSERT INTO np_branches (tenant_id, code, name, city) VALUES (?,?,?,?)', [$tid, $code, $name, 'Antalya']);
    return lastId();
}
function bind_device(int $tid, string $deviceId, ?int $branchId): void {
    q('INSERT INTO np_devices (tenant_id, device_id, branch_id, last_seen_at) VALUES (?,?,?,NOW())
       ON DUPLICATE KEY UPDATE branch_id=VALUES(branch_id), last_seen_at=NOW()', [$tid, $deviceId, $branchId]);
}

/**
 * A day-end payload shaped exactly like the one the till builds in
 * modules/reports.js zReport(). The KDV is given, never derived here: the
 * whole point is that the panel carries what the till calculated.
 */
function z_payload(string $date, int $orders, float $gross, float $discount, float $vat,
                   float $cash, float $card, float $other, ?float $cogs = null, ?float $profit = null): array {
    $net = round($gross - $discount, 2);
    $p = [
        'date' => $date, 'orders' => $orders, 'gross' => $gross, 'discount' => $discount,
        'net' => $net, 'vat_total' => $vat, 'net_ex_vat' => round($net - $vat, 2),
        'vat_breakdown' => [['rate' => 10, 'gross' => $net, 'vat' => $vat, 'base' => round($net - $vat, 2)]],
        'payments' => [
            ['method' => 'nakit', 'count' => 1, 'total' => $cash],
            ['method' => 'kredi_karti', 'count' => 1, 'total' => $card],
            ['method' => 'havale', 'count' => 1, 'total' => $other],
        ],
        'cancelled_items' => ['count' => 0, 'total' => 0],
        'deleted_bills' => ['count' => 0, 'total' => 0],
        'shifts' => [],
    ];
    if ($cogs !== null) { $p['cost_of_goods'] = $cogs; $p['extra_costs'] = 0; $p['profit'] = $profit; }
    return $p;
}

/** Push a day-end exactly as the till's outbox does. */
function push_close(array $cred, string $device, string $date, int $seq, array $payload): array {
    global $PANEL;
    return http_call('POST', $PANEL . '/api/desktop/sync.php', [
        'client_id' => $cred['id'], 'licence_key' => $cred['key'], 'device_id' => $device,
        'items' => [['id' => 1, 'entity' => 'daily_closing',
                     'entity_id' => $cred['id'] . ':' . $date . ':' . $seq, 'payload' => $payload]],
    ]);
}

echo "\nNOKTApp POS - zincir raporlama (merkez konsolidasyonu)\n\n";

$D0 = date('Y-m-d');
$D1 = date('Y-m-d', strtotime('-1 day'));
$D9 = date('Y-m-d', strtotime('-9 day'));

$R = make_tenant('RAPORA', 'Rapor Test A', 'rapor-a@ornek.test');
$S = make_tenant('RAPORB', 'Rapor Test B', 'rapor-b@ornek.test');
$T = make_tenant('RAPORC', 'Rapor Tek Sube', 'rapor-c@ornek.test');
$tidR = $R['id']; $tidS = $S['id']; $tidT = $T['id'];

$bMerkez = make_branch($tidR, 'MERKEZ', 'Merkez');
$bKale   = make_branch($tidR, 'KALEICI', 'Kaleiçi');
$bLara   = make_branch($tidR, 'LARA', 'Lara');
$bMurat  = make_branch($tidR, 'MURATPASA', 'Muratpaşa');
$bYeni   = make_branch($tidR, 'YENI', 'Yeni Şube');
$bB      = make_branch($tidS, 'BMERKEZ', 'B Merkez');
$bB2     = make_branch($tidS, 'BSUBE', 'B Şube');
$bT      = make_branch($tidT, 'TEK', 'Tek Şube');

/* The same device_id string at two tenants on purpose: device identity is only
   ever meaningful inside a tenant, and a report must never cross that line. */
bind_device($tidR, 'rapor-dev-merkez', $bMerkez);
bind_device($tidR, 'rapor-dev-kale', $bKale);
bind_device($tidR, 'rapor-dev-lara', $bLara);
bind_device($tidR, 'rapor-dev-murat', $bMurat);
bind_device($tidS, 'rapor-dev-merkez', $bB);
bind_device($tidT, 'rapor-dev-tek', null);          // single shop: never bound

/* ---------------------- 1. the fill ---------------------- */

check('gün sonu push’u np_branch_days’e düşüyor', function () use ($R, $tidR, $bMerkez, $D0) {
    $r = push_close($R, 'rapor-dev-merkez', $D0, 1, z_payload($D0, 40, 12000, 500, 1045.45, 8000, 3000, 500, 4000, 6454.55));
    assertSame(true, $r['ok'], 'push reddedildi');
    $row = one('SELECT * FROM np_branch_days WHERE tenant_id=? AND branch_id=? AND business_date=?',
               [$tidR, $bMerkez, $D0]);
    assertThat($row !== null, 'satır oluşmadı');
    assertSame(40, (int) $row['orders'], 'adisyon');
    assertMoney(11500, $row['net'], 'ciro');
    assertMoney(1045.45, $row['vat'], 'KDV');
    assertMoney(8000, $row['cash'], 'nakit');
    assertMoney(3000, $row['card'], 'kart');
    assertMoney(500, $row['other'], 'diğer');
    assertMoney(4000, $row['cost'], 'maliyet');
    assertSame(1, (int) $row['close_seq'], 'close_seq');
    assertSame(1, (int) $row['is_current'], 'is_current');
});

check('ham np_reports satırı olduğu gibi duruyor ve kaynağı gösteriyor', function () use ($tidR, $bMerkez, $D0, $R) {
    $raw = one("SELECT * FROM np_reports WHERE tenant_id=? AND entity='daily_closing' AND entity_id=?",
               [$tidR, $R['id'] . ':' . $D0 . ':1']);
    assertThat($raw !== null, 'ham push silindi');
    $p = json_decode((string) $raw['payload'], true);
    assertSame(40, (int) $p['orders'], 'ham payload bozuldu');
    assertSame('rapor-dev-merkez', (string) $raw['device_id'], 'itmiş cihaz kaydedilmedi');
    assertSame($bMerkez, (int) $raw['branch_id'], 'şube ham satıra yazılmadı');
    $day = one('SELECT source_id FROM np_branch_days WHERE tenant_id=? AND branch_id=? AND business_date=?',
               [$tidR, $bMerkez, $D0]);
    assertSame((int) $raw['id'], (int) $day['source_id'], 'materyalize satır kaynağını göstermiyor');
});

check('aynı push iki kez gelince ciro ikiye katlanmıyor', function () use ($R, $tidR, $bMerkez, $D0) {
    push_close($R, 'rapor-dev-merkez', $D0, 1, z_payload($D0, 40, 12000, 500, 1045.45, 8000, 3000, 500, 4000, 6454.55));
    push_close($R, 'rapor-dev-merkez', $D0, 1, z_payload($D0, 40, 12000, 500, 1045.45, 8000, 3000, 500, 4000, 6454.55));
    $n = (int) val('SELECT COUNT(*) FROM np_branch_days WHERE tenant_id=? AND branch_id=? AND business_date=?',
                   [$tidR, $bMerkez, $D0]);
    assertSame(1, $n, 'aynı kapanış için ikinci satır yazıldı');
    $sum = val('SELECT SUM(net) FROM np_branch_days WHERE tenant_id=? AND branch_id=? AND business_date=? AND is_current=1',
               [$tidR, $bMerkez, $D0]);
    assertMoney(11500, $sum, 'ciro katlandı');
});

check('düzeltilmiş kapanış (yüksek close_seq) ekleme değil, yerine geçme', function () use ($R, $tidR, $bMerkez, $D0) {
    push_close($R, 'rapor-dev-merkez', $D0, 2, z_payload($D0, 42, 12600, 500, 1100.00, 8300, 3300, 500, 4200, 6800.00));
    $rows = all('SELECT close_seq, is_current, net FROM np_branch_days
                  WHERE tenant_id=? AND branch_id=? AND business_date=? ORDER BY close_seq', [$tidR, $bMerkez, $D0]);
    assertSame(2, count($rows), 'düzeltme kaydı saklanmadı');
    assertSame(0, (int) $rows[0]['is_current'], 'eski kapanış hâlâ geçerli sayılıyor');
    assertSame(1, (int) $rows[1]['is_current'], 'düzeltme geçerli sayılmıyor');
    $pack = rapor_pack($tidR, $D0, $D0);
    $merkez = null;
    foreach ($pack['rows'] as $r) if ($r['code'] === 'MERKEZ') $merkez = $r;
    assertMoney(12100, $merkez['net'], 'iki kapanış toplanmış (yerine geçmemiş)');
    assertSame(1, $merkez['days'], 'gün iki kez sayıldı');
});

check('sırasız gelen kapanışta yine en yüksek close_seq geçerli', function () use ($R, $tidR, $bMurat, $D1) {
    /* seq 2 first, seq 1 after: a retried outbox can deliver them this way
       round, and the later close must still win. */
    push_close($R, 'rapor-dev-murat', $D1, 2, z_payload($D1, 10, 2200, 0, 200.00, 2200, 0, 0));
    push_close($R, 'rapor-dev-murat', $D1, 1, z_payload($D1, 9, 2000, 0, 181.82, 2000, 0, 0));
    $cur = one('SELECT close_seq, net FROM np_branch_days
                 WHERE tenant_id=? AND branch_id=? AND business_date=? AND is_current=1', [$tidR, $bMurat, $D1]);
    assertSame(2, (int) $cur['close_seq'], 'geç gelen eski kapanış geçerli oldu');
    assertMoney(2200, $cur['net'], 'ciro');
});

check('tek şubeli işletmenin push’u hiçbir satır üretmiyor', function () use ($T, $tidT, $D0) {
    $r = push_close($T, 'rapor-dev-tek', $D0, 1, z_payload($D0, 5, 900, 0, 81.82, 900, 0, 0));
    assertSame(true, $r['ok'], 'tek şubeli push reddedildi');
    assertSame(0, (int) val('SELECT COUNT(*) FROM np_branch_days WHERE tenant_id=?', [$tidT]),
        'şubesiz kasa için konsolidasyon satırı yazıldı');
    assertSame(1, (int) val("SELECT COUNT(*) FROM np_reports WHERE tenant_id=? AND entity='daily_closing'", [$tidT]),
        'ham gün sonu kaybedildi');
});

check('np_branch_days silinse bile ham push’tan yeniden kuruluyor', function () use ($tidR, $D0) {
    $before = all('SELECT branch_id, business_date, close_seq, net, vat, cash FROM np_branch_days
                    WHERE tenant_id=? ORDER BY branch_id, business_date, close_seq', [$tidR]);
    q('DELETE FROM np_branch_days WHERE tenant_id=?', [$tidR]);
    rapor_backfill($tidR);
    $after = all('SELECT branch_id, business_date, close_seq, net, vat, cash FROM np_branch_days
                   WHERE tenant_id=? ORDER BY branch_id, business_date, close_seq', [$tidR]);
    assertSame(count($before), count($after), 'yeniden kurulan satır sayısı farklı');
    foreach ($before as $i => $b) {
        assertSame($b['business_date'], $after[$i]['business_date'], 'tarih');
        assertMoney($b['net'], $after[$i]['net'], 'ciro');
    }
});

/* ---------------------- 2. the numbers ---------------------- */

/* The rest of the period, so there is something to compare and something to
   miss. KALEICI closed yesterday but not today; YENI has never closed at all. */
push_close($R, 'rapor-dev-merkez', $D1, 1, z_payload($D1, 30, 9000, 200, 800.00, 6000, 2500, 300, 3000, 5000.00));
push_close($R, 'rapor-dev-kale', $D1, 1, z_payload($D1, 20, 6000, 100, 536.36, 3000, 2800, 100, 2000, 3463.64));
push_close($R, 'rapor-dev-lara', $D9, 1, z_payload($D9, 12, 3000, 0, 272.73, 3000, 0, 0));

check('birleşik toplam, şube satırlarının kuruşuna kadar toplamı', function () use ($tidR, $D1, $D0) {
    $pack = rapor_pack($tidR, $D1, $D0);
    foreach (['gross', 'discount', 'net', 'vat', 'cash', 'card', 'other'] as $k) {
        $sum = 0;
        foreach ($pack['rows'] as $r) $sum += rapor_kurus($r[$k]);
        assertSame($sum, rapor_kurus($pack['total'][$k]), 'birleşik ' . $k . ' şube satırlarıyla uyuşmuyor');
    }
    $o = 0;
    foreach ($pack['rows'] as $r) $o += (int) $r['orders'];
    assertSame($o, (int) $pack['total']['orders'], 'adisyon toplamı');

    /* And the same figure worked out independently, straight off the table:
       two ways of adding it up that disagree is the bug this catches. */
    $sql = val('SELECT SUM(net) FROM np_branch_days WHERE tenant_id=? AND is_current=1 AND business_date BETWEEN ? AND ?',
               [$tidR, $D1, $D0]);
    assertMoney($sql, $pack['total']['net'], 'SQL toplamı ile ekran toplamı farklı');
});

check('ortalama adisyon şube ortalamalarının ortalaması değil', function () use ($tidR, $D1, $D0) {
    $pack = rapor_pack($tidR, $D1, $D0);
    assertMoney(round($pack['total']['net'] / $pack['total']['orders'], 2), $pack['total']['average'],
        'ortalama adisyon adisyonla ağırlıklandırılmamış');
});

check('KDV kasadan geldiği gibi taşınıyor, yeniden hesaplanmıyor', function () use ($tidR, $D0) {
    $pack = rapor_pack($tidR, $D0, $D0);
    $merkez = null;
    foreach ($pack['rows'] as $r) if ($r['code'] === 'MERKEZ') $merkez = $r;
    assertMoney(1100.00, $merkez['vat'], 'KDV kasanın gönderdiği tutar değil');
    /* Turkish KDV is inside the price. Had the panel added it on top, the
       turnover would have grown by the tax. */
    assertMoney(12100, $merkez['net'], 'KDV ciroya eklenmiş');
    assertThat($merkez['vat'] < $merkez['net'], 'KDV cirodan büyük');
});

check('ödeme dağılımı nakit / kart / diğer olarak ayrışıyor', function () use ($tidR, $D0) {
    $pack = rapor_pack($tidR, $D0, $D0);
    $merkez = null;
    foreach ($pack['rows'] as $r) if ($r['code'] === 'MERKEZ') $merkez = $r;
    assertMoney(8300, $merkez['cash'], 'nakit');
    assertMoney(3300, $merkez['card'], 'kart');
    assertMoney(500, $merkez['other'], 'diğer (havale)');
    assertMoney($merkez['cash'] + $merkez['card'] + $merkez['other'], 12100, 'ödeme toplamı ciroyu vermiyor');
});

check('en yüksek ve en düşük şube yalnızca rapor gönderenler arasından seçiliyor', function () use ($tidR, $D1, $D0) {
    $pack = rapor_pack($tidR, $D1, $D0);
    assertSame('MERKEZ', $pack['best']['code'], 'en yüksek ciro');
    assertThat($pack['worst'] !== null, 'en düşük şube yok');
    assertThat($pack['worst']['days'] > 0, 'gün sonu göndermeyen şube "en düşük" seçildi');
    foreach ($pack['rows'] as $r) {
        if ($r['code'] === 'YENI') assertSame(0, $r['days'], 'hiç kapanmayan şube gün saydı');
    }
});

check('önceki dönemle karşılaştırma aynı uzunlukta ve hemen öncesinde', function () use ($tidR, $D1, $D0) {
    $pack = rapor_pack($tidR, $D1, $D0);
    assertSame(2, $pack['days'], 'dönem uzunluğu');
    assertSame(date('Y-m-d', strtotime('-2 day')), $pack['prev_to'], 'önceki dönem bitişi');
    assertSame(date('Y-m-d', strtotime('-3 day')), $pack['prev_from'], 'önceki dönem başı');
});

/* ---------------------- 3. who has not closed ---------------------- */

check('bugün kapanmayan şube sıfır ciro değil, "bekliyor" olarak görünüyor', function () use ($tidR, $D0) {
    $pack = rapor_pack($tidR, $D0, $D0);
    $kale = null;
    foreach ($pack['rows'] as $r) if ($r['code'] === 'KALEICI') $kale = $r;
    assertThat($kale !== null, 'kapanmayan şube tablodan düştü');
    assertSame(0, $kale['days'], 'kapanmadığı hâlde gün sayıldı');
    assertSame('bekliyor', $kale['state'], 'durum');
    assertSame('gün sonu bekleniyor', rapor_state_text($kale), 'durum metni');
    $codes = array_column($pack['open'], 'code');
    assertThat(in_array('KALEICI', $codes, true), 'kapanmayan şube listede yok');
});

check('günlerdir kapanış göndermeyen şube "sessiz" olarak işaretleniyor', function () use ($tidR, $D0) {
    $pack = rapor_pack($tidR, $D0, $D0);
    $codes = array_column($pack['silent'], 'code');
    sort($codes);
    assertSame(['LARA', 'YENI'], $codes, 'sessiz şubeler');
    $lara = null; $yeni = null;
    foreach ($pack['rows'] as $r) { if ($r['code'] === 'LARA') $lara = $r; if ($r['code'] === 'YENI') $yeni = $r; }
    assertSame('sessiz', $lara['state'], 'LARA durumu');
    assertThat(strpos(rapor_state_text($lara), 'gündür gün sonu yok') !== false, 'LARA metni: ' . rapor_state_text($lara));
    assertSame('hiç gün sonu göndermedi', rapor_state_text($yeni), 'hiç göndermeyen şube metni');
    /* The silent branch stays in the table. Dropped, the chain would look
       healthy - which is the failure mode this whole screen exists for. */
    assertMoney(0, $lara['net'], 'sessiz şube cirosu');
    assertThat($lara['days'] === 0, 'sessiz şube gün saydı');
});

check('bir gün önce kapanmış şube sessiz sayılmıyor', function () use ($tidR, $D1) {
    $pack = rapor_pack($tidR, $D1, $D1);
    $kale = null;
    foreach ($pack['rows'] as $r) if ($r['code'] === 'KALEICI') $kale = $r;
    assertSame('kapandi', $kale['state'], 'dün kapanan şube durumu');
});

check('gelecek tarihli aralık tüm şubeleri kapanmamış göstermiyor', function () use ($tidR, $D0) {
    $future = date('Y-m-d', strtotime('+10 day'));
    $pack = rapor_pack($tidR, $D0, $future);
    assertSame($D0, $pack['as_of'], 'referans gün bugünden ileri alındı');
});

/* ---------------------- 4. tenant isolation ---------------------- */

push_close($S, 'rapor-dev-merkez', $D0, 1, z_payload($D0, 99, 99000, 0, 9000.00, 99000, 0, 0));

check('bir işletmenin rakamları diğerinin raporuna girmiyor', function () use ($tidR, $tidS, $D0, $bB) {
    $packR = rapor_pack($tidR, $D0, $D0);
    foreach ($packR['rows'] as $r) {
        assertThat($r['code'] !== 'BMERKEZ', 'B işletmesinin şubesi A raporunda');
        assertThat((int) $r['orders'] !== 99, 'B işletmesinin adisyonu A raporuna girdi');
    }
    assertThat(rapor_kurus($packR['total']['net']) < rapor_kurus(99000), 'B cirosu A toplamına karıştı');

    $packS = rapor_pack($tidS, $D0, $D0);
    $codes = array_column($packS['rows'], 'code');
    sort($codes);
    assertSame(['BMERKEZ', 'BSUBE'], $codes, 'B raporunda yabancı şube var');
    assertMoney(99000, $packS['total']['net'], 'B kendi cirosunu görmüyor');
});

check('aynı device_id iki işletmede farklı şubeye çözülüyor', function () use ($tidR, $tidS, $bMerkez, $bB) {
    assertSame($bMerkez, rapor_resolve_branch($tidR, [], 'rapor-dev-merkez'), 'A cihazı');
    assertSame($bB, rapor_resolve_branch($tidS, [], 'rapor-dev-merkez'), 'B cihazı');
});

check('başka işletmenin şube id’si ile satır yazılamıyor', function () use ($tidR, $bB, $D0) {
    $r = rapor_materialise($tidR, $bB, '1:' . $D0 . ':1', z_payload($D0, 1, 100, 0, 9.09, 100, 0, 0));
    assertSame(null, $r, 'yabancı şubeye satır yazıldı');
    assertSame(0, (int) val('SELECT COUNT(*) FROM np_branch_days WHERE tenant_id=? AND branch_id=?', [$tidR, $bB]),
        'yabancı şube satırı tabloda');
});

/* ---------------------- 5. the screen and the exports ---------------------- */

$login = browse($PANEL . '/admin/index.php?p=login', ['email' => $ADMIN, 'password' => $ADMIN_PASS]);

check('rapor ekranı zincir işletmede açılıyor', function () use ($PANEL, $tidR, $D1, $D0) {
    $r = browse($PANEL . "/admin/index.php?p=rapor&id={$tidR}&from={$D1}&to={$D0}");
    assertSame(200, $r['status'], 'ekran açılmadı');
    assertThat(strpos($r['body'], 'Şube raporu') !== false, 'başlık yok');
    assertThat(strpos($r['body'], 'Gün sonu durumu') !== false, 'gün sonu paneli yok');
    assertThat(strpos($r['body'], 'sessiz') !== false, 'sessiz şube ekranda görünmüyor');
    assertThat(strpos($r['body'], 'MERKEZ') !== false, 'şube satırı yok');
    assertThat(strpos($r['body'], 'YENI') !== false, 'hiç kapanmayan şube tablodan düşmüş');
});

check('tek şubeli işletmede rapor ekranı açılmıyor', function () use ($PANEL, $tidT) {
    $r = browse($PANEL . "/admin/index.php?p=rapor&id={$tidT}");
    assertSame(200, $r['status'], 'yanıt');
    assertThat(strpos($r['body'], 'tek şube olarak çalışıyor') !== false, 'tek şubeli işletmeye rapor açıldı');
    assertThat(strpos($r['body'], 'Şube karşılaştırma') === false, 'tek şubeye karşılaştırma tablosu gösterildi');
});

check('CSV, ekrandaki rakamların aynısını taşıyor', function () use ($PANEL, $tidR, $D1, $D0) {
    $pack = rapor_pack($tidR, $D1, $D0);
    $r = browse($PANEL . "/admin/index.php?p=rapor&id={$tidR}&from={$D1}&to={$D0}&export=csv");
    assertSame(200, $r['status'], 'CSV indirilemedi');
    assertThat(strpos($r['headers'], 'text/csv') !== false, 'içerik türü CSV değil');
    $body = $r['body'];
    assertThat(substr($body, 0, 3) === "\xEF\xBB\xBF", 'UTF-8 BOM yok - Excel Türkçe karakterleri bozar');
    assertThat(strpos($body, ';') !== false, 'ayraç noktalı virgül değil');

    $lines = explode("\r\n", substr($body, 3));
    $head = null; $rows = [];
    foreach ($lines as $l) {
        $c = explode(';', $l);
        if ($head === null && ($c[0] ?? '') === 'Şube') { $head = $c; continue; }
        if ($head !== null && trim($l) !== '') $rows[] = array_combine($head, array_pad($c, count($head), ''));
    }
    assertThat($head !== null, 'başlık satırı yok');
    $byName = [];
    foreach ($rows as $r2) $byName[$r2['Şube']] = $r2;

    foreach ($pack['rows'] as $b) {
        $key = $b['code'] . ' · ' . $b['name'];
        assertThat(isset($byName[$key]), 'şube CSV’de yok: ' . $key);
        assertSame(rapor_csv_num($b['net']), $byName[$key]['Ciro'], $b['code'] . ' cirosu CSV’de farklı');
        assertSame(rapor_csv_num($b['vat']), $byName[$key]['KDV'], $b['code'] . ' KDV CSV’de farklı');
        assertSame((string) $b['orders'], $byName[$key]['Adisyon'], $b['code'] . ' adisyon CSV’de farklı');
        assertSame(rapor_state_text($b), $byName[$key]['Durum'], $b['code'] . ' durumu CSV’de farklı');
    }
    assertThat(isset($byName['TÜM ŞUBELER']), 'birleşik satır CSV’de yok');
    assertSame(rapor_csv_num($pack['total']['net']), $byName['TÜM ŞUBELER']['Ciro'], 'birleşik ciro CSV’de farklı');
    /* Decimal comma: '11500.00' lands in one column in a Turkish Excel. */
    assertThat(strpos($byName['TÜM ŞUBELER']['Ciro'], ',') !== false, 'CSV ondalığı nokta ile yazılmış');
});

check('PDF, ekrandaki rakamların aynısını taşıyor', function () use ($PANEL, $tidR, $D1, $D0) {
    $pack = rapor_pack($tidR, $D1, $D0);
    $r = browse($PANEL . "/admin/index.php?p=rapor&id={$tidR}&from={$D1}&to={$D0}&export=pdf");
    assertSame(200, $r['status'], 'PDF indirilemedi');
    assertThat(strpos($r['headers'], 'application/pdf') !== false, 'içerik türü PDF değil');
    $body = $r['body'];
    assertThat(substr($body, 0, 5) === '%PDF-', 'PDF başlığı yok');
    assertThat(strpos($body, '%%EOF') !== false, 'PDF sonlandırılmamış');

    /* The page text is uncompressed, so the figures can be read straight out
       of the content stream - which is the only way to prove the file says
       what the screen said, rather than merely being a valid PDF. */
    $text = $body;
    foreach ($pack['rows'] as $b) {
        assertThat(strpos($text, NpPdf::ascii($b['code'])) !== false, 'şube PDF’de yok: ' . $b['code']);
    }
    assertThat(strpos($text, NpPdf::ascii(rapor_money($pack['total']['net']))) !== false,
        'birleşik ciro PDF’de yok: ' . rapor_money($pack['total']['net']));
    assertThat(strpos($text, NpPdf::ascii(rapor_money($pack['total']['vat']))) !== false, 'birleşik KDV PDF’de yok');
    assertThat(strpos($text, 'Sayfa 1 /') !== false, 'sayfa numarası yok');
    assertThat(strpos($text, 'SESSIZ') !== false, 'sessiz şube PDF’de belirtilmemiş');
    /* Helvetica WinAnsi: ğ ş ı yazılırsa sayfada mojibake olur. */
    assertThat(strpos($text, 'Gün sonu') === false, 'PDF metni ASCII’ye indirgenmemiş');
});

check('oturumsuz dışa aktarma veri vermiyor', function () use ($PANEL, $tidR, $D0) {
    $ch = curl_init($PANEL . "/admin/index.php?p=rapor&id={$tidR}&from={$D0}&to={$D0}&export=csv");
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true, CURLOPT_TIMEOUT => 20]);
    $raw = (string) curl_exec($ch);
    curl_close($ch);
    assertThat(strpos($raw, 'p=login') !== false, 'oturumsuz istek giriş ekranına yönlendirilmedi');
    assertThat(strpos($raw, 'TÜM ŞUBELER') === false, 'oturumsuz isteğe rapor verildi');
});

check('dışa aktarma bağlantılarında hiçbir sır yok', function () use ($PANEL, $tidR, $D0) {
    $r = browse($PANEL . "/admin/index.php?p=rapor&id={$tidR}&from={$D0}&to={$D0}");
    assertThat(preg_match('/licence_key|password|csrf=/', $r['body']) === 0, 'ekranda URL üzerinden sır taşınıyor');
});

/* ------------------------------ teardown ------------------------------ */
drop_tenant('rapor-a@ornek.test');
drop_tenant('rapor-b@ornek.test');
drop_tenant('rapor-c@ornek.test');
@unlink($JAR);

echo "\n$pass/$total checks passed\n";
if ($failures) {
    foreach ($failures as $f) echo "  ! $f\n";
    exit(1);
}
exit(0);
