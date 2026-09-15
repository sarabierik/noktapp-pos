<?php
/**
 * NOKTApp POS - the vendor-facing panel: dashboard, customer page, search,
 * version distribution.
 *
 * Everything runs against the real MariaDB and the real screens over HTTP.
 * Nothing is mocked, because the failures this exists to catch are exactly the
 * ones a mock hides: a dashboard count that has quietly drifted from the list
 * it links to, a search that reaches across tenants, an "extend by a year"
 * that throws away the four months the customer already paid for, an action
 * that changes a licence without leaving a trace, and a chain screen that
 * opens for a customer with one shop.
 *
 * Two throwaway tenants are created and destroyed by the run, so the suite
 * never touches the real tenants or the ones the chain and rapor suites make.
 *
 * Run:  php panel/tests/panel.php
 * Env:  NP_DB_PORT (3399) NP_DB_USER (noktapp) NP_DB_PASS (nokpass)
 *       NP_DB_NAME (nokpos_panel)  PANEL (http://127.0.0.1:8090)
 *       PANEL_ADMIN / PANEL_ADMIN_PASS for the screen checks
 */
foreach ([
    'NP_DB_HOST' => '127.0.0.1', 'NP_DB_PORT' => '3399', 'NP_DB_NAME' => 'nokpos_panel',
    'NP_DB_USER' => 'noktapp',   'NP_DB_PASS' => 'nokpass',
] as $k => $v) { if (getenv($k) === false) putenv("$k=$v"); }

require_once __DIR__ . '/../lib/panel.php';

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

/* --------------------------- http, as a browser --------------------------- */
$JAR = sys_get_temp_dir() . '/np-panel-test-' . getmypid() . '.cookies';
@unlink($JAR);

function http(string $method, string $url, array $form = [], bool $follow = false): array {
    global $JAR;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_COOKIEJAR => $JAR, CURLOPT_COOKIEFILE => $JAR,
        CURLOPT_FOLLOWLOCATION => $follow, CURLOPT_HEADER => true, CURLOPT_TIMEOUT => 30,
    ]);
    if ($form) curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($form));
    $raw = (string) curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hsize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($raw === '' && $err) throw new RuntimeException('panel yanit vermedi: ' . $err);
    $head = substr($raw, 0, $hsize);
    $body = substr($raw, $hsize);
    $loc = '';
    if (preg_match('/^location:\s*(.+)$/mi', $head, $m)) $loc = trim($m[1]);
    return ['status' => $status, 'body' => $body, 'location' => $loc, 'head' => $head];
}

/**
 * A request with NO cookie jar - a stranger who has just found the address.
 *
 * http() carries the admin session for the whole run, so asking it what the
 * login page shows would answer for a logged-in admin and prove nothing about
 * what the internet can see.
 */
function anon(string $method, string $url): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_FOLLOWLOCATION => false, CURLOPT_HEADER => true, CURLOPT_TIMEOUT => 30,
    ]);
    $raw = (string) curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hsize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);
    return ['status' => $status, 'body' => substr($raw, $hsize), 'head' => substr($raw, 0, $hsize)];
}

/** A desktop-API call: JSON in, JSON out, no session. */
function api_post(string $url, array $payload): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_TIMEOUT => 40,
    ]);
    $body = (string) curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['status' => $status, 'body' => $body, 'json' => json_decode($body, true)];
}

/** The CSRF token off any rendered panel page. */
function csrf_token(string $panel): string {
    $r = http('GET', $panel . '/admin/index.php?p=home');
    if (!preg_match('/name="csrf" value="([a-f0-9]+)"/', $r['body'], $m)) {
        throw new RuntimeException('csrf alinamadi');
    }
    return $m[1];
}

/** Did the page render, or did the panel's error box catch a fatal? */
function assertRendered(array $r, string $what): void {
    assertSame(200, $r['status'], $what . ' HTTP durumu');
    foreach (['Panel bir hata ile karsilasti', 'Panel durdu', 'Fatal error', 'Parse error'] as $bad) {
        assertThat(strpos($r['body'], $bad) === false, $what . ' hata kutusu gosterdi: ' . $bad);
    }
    assertThat(strlen($r['body']) > 400, $what . ' sayfasi bos geldi');
}

/* ------------------------------- fixture ---------------------------------- */
function drop_tenant(string $email): void {
    $t = one('SELECT id FROM np_tenants WHERE email=?', [$email]);
    if (!$t) return;
    $id = (int) $t['id'];
    foreach (['np_branch_overrides', 'np_branch_days', 'np_menu_version_items', 'np_menu_versions',
              'np_menu_products', 'np_menu_categories', 'np_branches', 'np_devices', 'np_backups',
              'np_reports', 'np_relay_messages', 'np_licences'] as $tab) {
        try { q("DELETE FROM {$tab} WHERE tenant_id=?", [$id]); } catch (Throwable $e) {}
    }
    try { q('DELETE FROM np_audit WHERE tenant_id=?', [$id]); } catch (Throwable $e) {}
    q('DELETE FROM np_tenants WHERE id=?', [$id]);
}

/**
 * Two customers, deliberately similar, so a query that forgets its tenant
 * scope has something to leak into.
 */
function make_tenant(string $code, string $name, string $email, string $tax, string $phone): array {
    drop_tenant($email);
    q('INSERT INTO np_tenants (code, company_name, owner_name, email, password_hash, phone,
         tax_number, tax_office, city, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,1)',
      [$code, $name, 'Test Yetkili', $email, password_hash('x', PASSWORD_BCRYPT),
       $phone, $tax, 'Test VD', 'Antalya']);
    $id = lastId();
    $key = strtoupper(bin2hex(random_bytes(12)));
    q('INSERT INTO np_licences (tenant_id, licence_key, plan, status, seats, starts_at, expires_at,
         grace_days, price, billing_period)
       VALUES (?,?,?,?,?, CURDATE(), DATE_ADD(NOW(), INTERVAL 200 DAY), 7, 5000, ?)',
      [$id, $key, 'pro', 'active', 3, 'yearly']);
    $licId = lastId();
    return ['id' => $id, 'key' => $key, 'licence_id' => $licId, 'code' => $code,
            'email' => $email, 'tax' => $tax, 'phone' => $phone, 'name' => $name];
}

echo "\nNOKTApp POS - panel testleri\n";
echo str_repeat('-', 62) . "\n";

$A = make_tenant('PTEST_A', 'Panel Test Bir Lokantası', 'panel-a@ornek.test', '9911223344', '05551110001');
$B = make_tenant('PTEST_B', 'Panel Test İki Restoran', 'panel-b@ornek.test', '9911223355', '05551110002');

$devA = 'ptest-a-kasa-' . bin2hex(random_bytes(4));
$devB = 'ptest-b-kasa-' . bin2hex(random_bytes(4));
q('INSERT INTO np_devices (tenant_id, device_id, device_name, app_version, last_seen_at, first_seen_at)
   VALUES (?,?,?,?, NOW(), NOW())', [$A['id'], $devA, 'A Kasa 1', '1.0.0']);
$devAId = lastId();
q('INSERT INTO np_devices (tenant_id, device_id, device_name, app_version, last_seen_at, first_seen_at)
   VALUES (?,?,?,?, NOW(), NOW())', [$B['id'], $devB, 'B Kasa 1', '1.0.0']);

/* --------------------------- 1. access control ---------------------------- */
echo "\n1. Erisim: giris yapmadan hicbir ekran acilmiyor\n";

$pages = ['home', 'tenants', 'devices', 'backups', 'versions', 'relay', 'audit', 'liste', 'ara',
          'tenant&id=' . $A['id'], 'liste&k=exp30', 'liste&k=silent', 'liste&k=backup',
          'liste&k=outdated', 'liste&k=noinstall', 'liste&k=lapsed', 'liste&k=blocked', 'liste&k=online'];

@unlink($JAR); // anonymous
foreach ($pages as $pg) {
    check("oturumsuz ?p={$pg} girise yonlendiriyor", function () use ($PANEL, $pg) {
        $r = http('GET', $PANEL . '/admin/index.php?p=' . $pg);
        assertSame(302, $r['status'], 'HTTP durumu');
        assertThat(strpos($r['location'], 'p=login') !== false, 'login sayfasina yonlendirmeli, giden: ' . $r['location']);
    });
}
check('oturumsuz istekte veri sizmiyor', function () use ($PANEL, $A) {
    $r = http('GET', $PANEL . '/admin/index.php?p=tenant&id=' . $A['id']);
    assertThat(strpos($r['body'], $A['name']) === false, 'yonlendirme govdesinde isletme adi var');
    assertThat(strpos($r['body'], $A['key']) === false, 'yonlendirme govdesinde lisans anahtari var');
});

/* ------------------------------ 2. rendering ------------------------------ */
echo "\n2. Ekranlar: yonetici olarak her sayfa aciliyor\n";

check('yonetici girisi yapiliyor', function () use ($PANEL, $ADMIN, $ADMIN_PASS) {
    http('GET', $PANEL . '/admin/index.php?p=login');
    $r = http('POST', $PANEL . '/admin/index.php?p=login', ['email' => $ADMIN, 'password' => $ADMIN_PASS]);
    assertSame(302, $r['status'], 'giris HTTP durumu');
    assertThat(strpos($r['location'], 'p=home') !== false, 'girisin ardindan panele gitmeli');
});

$expect = [
    'home' => 'Genel bakış', 'tenants' => 'İşletmeler', 'devices' => 'Kasa bilgisayarları',
    'backups' => 'Bulut yedekleri', 'versions' => 'Sürümler', 'relay' => 'Telefon relay',
    'audit' => 'İşlem kayıtları', 'liste' => 'Listeler',
    'liste&k=exp30' => 'bitecek lisans', 'liste&k=silent' => 'Sessiz kasalar',
    'liste&k=backup' => 'gecikmiş', 'liste&k=outdated' => 'Eski sürümdeki',
    'liste&k=noinstall' => 'Kurulum yapılmamış', 'liste&k=lapsed' => 'Süresi geçmiş',
    'liste&k=blocked' => 'Engellenmiş', 'liste&k=online' => 'çevrimiçi',
];
foreach ($expect as $pg => $needle) {
    check("?p={$pg} aciliyor", function () use ($PANEL, $pg, $needle) {
        $r = http('GET', $PANEL . '/admin/index.php?p=' . $pg);
        assertRendered($r, $pg);
        assertThat(mb_strpos($r['body'], $needle) !== false, "sayfada '{$needle}' bekleniyordu");
    });
}
check('isletme karti aciliyor ve lisansi gosteriyor', function () use ($PANEL, $A) {
    $r = http('GET', $PANEL . '/admin/index.php?p=tenant&id=' . $A['id']);
    assertRendered($r, 'tenant');
    assertThat(mb_strpos($r['body'], $A['name']) !== false, 'isletme adi yok');
    assertThat(strpos($r['body'], $A['key']) !== false, 'lisans anahtari yok');
    assertThat(mb_strpos($r['body'], 'Kasa hakkı') !== false, 'kasa hakki kutusu yok');
});
check('yeni isletme formu aciliyor', function () use ($PANEL) {
    $r = http('GET', $PANEL . '/admin/index.php?p=tenant&id=0');
    assertRendered($r, 'tenant-new');
    assertThat(mb_strpos($r['body'], 'Yeni işletme') !== false, 'baslik yok');
});
check('olmayan isletme id hata vermeden karsilaniyor', function () use ($PANEL) {
    $r = http('GET', $PANEL . '/admin/index.php?p=tenant&id=99999999');
    assertRendered($r, 'tenant-missing');
    assertThat(mb_strpos($r['body'], 'bulunamadı') !== false, 'bulunamadi mesaji yok');
});
check('bilinmeyen sayfa 404 metni veriyor, cokmuyor', function () use ($PANEL) {
    $r = http('GET', $PANEL . '/admin/index.php?p=yokboylebirsey');
    assertRendered($r, '404');
    assertThat(mb_strpos($r['body'], 'Böyle bir sayfa yok') !== false, '404 metni yok');
});

/* ------------------------------- 3. search -------------------------------- */
echo "\n3. Arama: her alandan bulunuyor, kiracilar birbirine karismiyor\n";

function search_ids(string $panel, string $term): array {
    $r = http('POST', $panel . '/admin/index.php?p=ara',
              ['csrf' => csrf_token($panel), 'q' => $term]);
    assertRendered($r, 'ara');
    preg_match_all('/p=tenant&id=(\d+)/', $r['body'], $m);
    return array_values(array_unique(array_map('intval', $m[1])));
}

$fields = [
    'ünvanla'          => fn() => 'Panel Test Bir',
    'e-postayla'       => fn() => 'panel-a@ornek.test',
    'işletme koduyla'  => fn() => 'PTEST_A',
    'vergi numarasıyla'=> fn() => '9911223344',
    'telefonla'        => fn() => '05551110001',
    'lisans anahtarıyla' => fn() => $GLOBALS['A']['key'],
    'cihaz kimliğiyle' => fn() => $GLOBALS['devA'],
];
foreach ($fields as $label => $termFn) {
    check("arama {$label} isletmeyi buluyor", function () use ($PANEL, $termFn, $A) {
        $ids = search_ids($PANEL, $termFn());
        assertThat(in_array($A['id'], $ids, true), 'aranan isletme sonuclarda yok');
    });
}
check('lisans anahtari aramasi baska kiraciya sizmiyor', function () use ($PANEL, $A, $B) {
    $ids = search_ids($PANEL, $A['key']);
    assertSame([$A['id']], $ids, 'yalnizca sahibi donmeliydi');
    assertThat(!in_array($B['id'], $ids, true), 'diger kiraci sonuclarda');
});
check('cihaz kimligi aramasi baska kiraciya sizmiyor', function () use ($PANEL, $A, $B, $devA) {
    $ids = search_ids($PANEL, $devA);
    assertSame([$A['id']], $ids, 'yalnizca cihazin sahibi donmeliydi');
});
check('lisans anahtarinin parcasi eslesmiyor (tam eslesme sarti)', function () use ($PANEL, $A) {
    /* A LIKE on a credential would let it be walked a character at a time. */
    $ids = search_ids($PANEL, substr($A['key'], 0, 10));
    assertThat(!in_array($A['id'], $ids, true), 'lisans anahtarinin parcasi eslesti - LIKE kullanilmis');
});
check('bos arama sonuc dondurmuyor', function () use ($PANEL) {
    $ids = search_ids($PANEL, '');
    assertSame([], $ids, 'bos terim sonuc dondurdu');
});
check('arama kutusu POST kullaniyor - anahtar URL\'e yazilmiyor', function () use ($PANEL) {
    $r = http('GET', $PANEL . '/admin/index.php?p=home');
    /* The box moved from the header into the sidebar when the shell was
       rebuilt, so this looks for the search form by where it goes rather than
       by what it is called. The invariant is the method, not the class. */
    assertThat(preg_match('~<form[^>]*class="side-search"[^>]*method="post"[^>]*action="index\.php\?p=ara"~i',
        $r['body']) === 1,
        'arama formu POST olmali; GET olsaydi lisans anahtari adres cubuguna ve sunucu kayitlarina yazilirdi');
    assertThat(preg_match('~<form[^>]*method="get"[^>]*action="index\.php\?p=ara"~i', $r['body']) === 0,
        'aramanin GET eden bir kopyasi var');
});

/* ---------------------- 4. dashboard numbers are true --------------------- */
echo "\n4. Rakamlar: her gosterge dogrudan sorguyla ayni sonucu veriyor\n";

check('aktif isletme sayisi dogrudan sorguyla ayni', function () {
    assertSame((int) val('SELECT COUNT(*) FROM np_tenants WHERE is_active=1'),
               panel_count_customers(), 'aktif isletme');
});
check('su an cevrimici kasa sayisi dogrudan sorguyla ayni', function () {
    assertSame((int) val('SELECT COUNT(*) FROM np_devices WHERE last_seen_at > DATE_SUB(NOW(), INTERVAL ' . PANEL_ONLINE_MINUTES . ' MINUTE)'),
               panel_count_online_now(), 'cevrimici');
});
check('bugun baglanan kasa sayisi dogrudan sorguyla ayni', function () {
    assertSame((int) val('SELECT COUNT(*) FROM np_devices WHERE last_seen_at >= CURDATE()'),
               panel_count_online_today(), 'bugun baglanan');
});
check('30 gunde bitecek lisans sayisi dogrudan sorguyla ayni', function () {
    $direct = (int) val("SELECT COUNT(*) FROM np_tenants t
        LEFT JOIN np_licences l ON l.id=(SELECT MAX(id) FROM np_licences WHERE tenant_id=t.id)
        WHERE t.is_active=1 AND l.status IN ('active','trial') AND l.expires_at IS NOT NULL
          AND l.expires_at >= NOW() AND l.expires_at < DATE_ADD(NOW(), INTERVAL 30 DAY)");
    assertSame($direct, panel_count_expiring(30), '30 gun');
});
check('90 gunlukler 60 gunlukleri, 60 gunlukler 30 gunlukleri kapsiyor', function () {
    $a = panel_count_expiring(30); $b = panel_count_expiring(60); $c = panel_count_expiring(90);
    assertThat($a <= $b && $b <= $c, "bantlar ic ice olmali: {$a} <= {$b} <= {$c}");
});
check('suresi gecmis lisans sayisi dogrudan sorguyla ayni', function () {
    $direct = (int) val("SELECT COUNT(*) FROM np_tenants t
        LEFT JOIN np_licences l ON l.id=(SELECT MAX(id) FROM np_licences WHERE tenant_id=t.id)
        WHERE t.is_active=1 AND ((l.status IN ('active','trial') AND l.expires_at IS NOT NULL
          AND l.expires_at < NOW()) OR l.status='expired')");
    assertSame($direct, panel_count_lapsed(), 'suresi gecmis');
});
check('sessiz kasa sayisi dogrudan sorguyla ayni', function () {
    $direct = (int) val('SELECT COUNT(*) FROM (
        SELECT t.id FROM np_tenants t JOIN np_devices d ON d.tenant_id=t.id
         WHERE t.is_active=1 GROUP BY t.id
        HAVING MAX(d.last_seen_at) IS NULL OR MAX(d.last_seen_at) < DATE_SUB(NOW(), INTERVAL ' . PANEL_SILENT_DAYS . ' DAY)) x');
    assertSame($direct, panel_count_silent(), 'sessiz');
});
check('kurulum yapilmamis isletme sayisi dogrudan sorguyla ayni', function () {
    $direct = (int) val('SELECT COUNT(*) FROM np_tenants t WHERE t.is_active=1
        AND NOT EXISTS (SELECT 1 FROM np_devices d WHERE d.tenant_id=t.id)');
    assertSame($direct, panel_count_never_installed(), 'kurulumsuz');
});
check('yedegi gecikmis isletme sayisi dogrudan sorguyla ayni', function () {
    $direct = (int) val('SELECT COUNT(*) FROM (
        SELECT t.id FROM np_tenants t LEFT JOIN np_backups b ON b.tenant_id=t.id
         WHERE t.is_active=1 AND EXISTS (SELECT 1 FROM np_devices d WHERE d.tenant_id=t.id)
         GROUP BY t.id
        HAVING MAX(b.created_at) IS NULL OR MAX(b.created_at) < DATE_SUB(NOW(), INTERVAL ' . PANEL_BACKUP_HOURS . ' HOUR)) x');
    assertSame($direct, panel_count_backup_overdue(), 'yedegi gecikmis');
});
check('surum dagilimindaki kasa toplami gercek kasa sayisina esit', function () {
    $a = panel_version_adoption();
    $direct = (int) val('SELECT COUNT(*) FROM np_devices d JOIN np_tenants t ON t.id=d.tenant_id WHERE t.is_active=1');
    assertSame($direct, (int) $a['total'], 'toplam kasa');
    $sum = 0; foreach ($a['rows'] as $r) $sum += (int) $r['devices'];
    assertSame($direct, $sum, 'satirlarin toplami tabloya esit degil');
});
check('surum paylari toplami %100', function () {
    $a = panel_version_adoption();
    if (!$a['total']) return;
    $s = 0.0; foreach ($a['rows'] as $r) $s += $r['share'];
    assertThat(abs($s - 1.0) < 0.0001, 'paylarin toplami 1 olmali, gelen ' . $s);
});
check('yillik sozlesme degeri dogrudan sorguyla ayni', function () {
    $direct = (float) val("SELECT SUM(CASE WHEN l.billing_period='monthly' THEN l.price*12 ELSE l.price END)
        FROM np_tenants t LEFT JOIN np_licences l ON l.id=(SELECT MAX(id) FROM np_licences WHERE tenant_id=t.id)
        WHERE t.is_active=1 AND l.status IN ('active','trial')");
    $v = panel_contract_value();
    assertThat(abs($direct - $v['yearly']) < 0.01, "sozlesme degeri: {$direct} vs {$v['yearly']}");
});

/* Every count must equal the length of the list it links to; that pairing is
   the whole promise the home page makes. */
echo "\n   ... ve her rakam, tikladiginda acilan listenin uzunlugu\n";
$pairs = [
    'sessiz kasa'        => ['panel_count_silent', 'panel_list_silent'],
    'kurulumsuz'         => ['panel_count_never_installed', 'panel_list_never_installed'],
    'yedegi gecikmis'    => ['panel_count_backup_overdue', 'panel_list_backup_overdue'],
    'suresi gecmis'      => ['panel_count_lapsed', 'panel_list_lapsed'],
    'eski surumde'       => ['panel_count_outdated', 'panel_list_outdated'],
];
foreach ($pairs as $label => [$cfn, $lfn]) {
    check("{$label} rakami listesiyle ayni", function () use ($cfn, $lfn) {
        assertSame(count($lfn()), $cfn(), 'rakam ile liste uyusmuyor');
    });
}
check('eski surumdeki + guncel isletme = kasasi olan isletme', function () {
    if (!panel_current_version()) return;
    $withDevices = (int) val('SELECT COUNT(DISTINCT d.tenant_id) FROM np_devices d
                                JOIN np_tenants t ON t.id=d.tenant_id WHERE t.is_active=1');
    assertSame($withDevices, panel_count_outdated() + panel_count_up_to_date(), 'toplam tutmuyor');
});
check('surum bildirmemis kasa guncel sayilmiyor', function () use ($A) {
    /* "Bilinmiyor" is not "up to date": we do not know that till is current. */
    if (!panel_current_version()) return;
    q('UPDATE np_devices SET app_version=NULL WHERE tenant_id=?', [$A['id']]);
    $ids = array_column(panel_list_outdated(), 'id');
    assertThat(in_array($A['id'], $ids, true), 'surum bildirmemis kasa eski listesinde olmali');
    q('UPDATE np_devices SET app_version=? WHERE tenant_id=?', ['1.0.0', $A['id']]);
});

/* ---------------------- 5. actions leave a trace --------------------------- */
echo "\n5. Islemler: lisans ve kasa islemleri denetim kaydi biraliyor\n";

check('lisans uzatma kalan sureyi yakmiyor', function () use ($PANEL, $A) {
    $before = one('SELECT * FROM np_licences WHERE id=?', [$A['licence_id']]);
    $r = http('POST', $PANEL . '/admin/index.php', [
        'csrf' => csrf_token($PANEL), 'action' => 'licence_extend',
        'tenant_id' => $A['id'], 'licence_id' => $A['licence_id'], 'months' => 12]);
    assertSame(302, $r['status'], 'yonlendirme bekleniyordu');
    $after = one('SELECT * FROM np_licences WHERE id=?', [$A['licence_id']]);
    $want = date('Y-m-d', strtotime($before['expires_at'] . ' +12 month'));
    assertSame($want, substr((string) $after['expires_at'], 0, 10),
        'uzatma mevcut bitisin uzerine eklenmeli, bugunden degil');
});
check('lisans uzatma denetim kaydi yaziyor (isletmeye bagli)', function () use ($A) {
    $row = one("SELECT * FROM np_audit WHERE tenant_id=? AND action='licence.extend' ORDER BY id DESC LIMIT 1", [$A['id']]);
    assertThat($row !== null, 'licence.extend kaydi yok');
    assertThat(strpos((string) $row['detail'], '12') !== false, 'kayitta ay sayisi yok');
});
check('kasa sayisi degisikligi kaydediliyor ve denetime dusuyor', function () use ($PANEL, $A) {
    $r = http('POST', $PANEL . '/admin/index.php', [
        'csrf' => csrf_token($PANEL), 'action' => 'seats_save',
        'tenant_id' => $A['id'], 'licence_id' => $A['licence_id'], 'seats' => 9]);
    assertSame(302, $r['status'], 'yonlendirme bekleniyordu');
    assertSame(9, (int) val('SELECT seats FROM np_licences WHERE id=?', [$A['licence_id']]), 'kasa sayisi');
    $row = one("SELECT * FROM np_audit WHERE tenant_id=? AND action='licence.seats' ORDER BY id DESC LIMIT 1", [$A['id']]);
    assertThat($row !== null, 'licence.seats kaydi yok');
});
check('lisans durumu degisikligi denetime dusuyor', function () use ($PANEL, $A) {
    http('POST', $PANEL . '/admin/index.php', [
        'csrf' => csrf_token($PANEL), 'action' => 'licence_status',
        'tenant_id' => $A['id'], 'licence_id' => $A['licence_id'], 'status' => 'suspended']);
    assertSame('suspended', val('SELECT status FROM np_licences WHERE id=?', [$A['licence_id']]), 'durum');
    assertThat(one("SELECT id FROM np_audit WHERE tenant_id=? AND action='licence.status'", [$A['id']]) !== null,
        'licence.status kaydi yok');
    http('POST', $PANEL . '/admin/index.php', [
        'csrf' => csrf_token($PANEL), 'action' => 'licence_status',
        'tenant_id' => $A['id'], 'licence_id' => $A['licence_id'], 'status' => 'active']);
});
check('kasa engelleme denetime dusuyor ve isletme kartina donuyor', function () use ($PANEL, $A, $devAId) {
    $r = http('POST', $PANEL . '/admin/index.php', [
        'csrf' => csrf_token($PANEL), 'action' => 'device_block',
        'id' => $devAId, 'blocked' => 1, 'back_tenant' => $A['id']]);
    assertThat(strpos($r['location'], 'p=tenant&id=' . $A['id']) !== false,
        'basildigi yere donmeli, giden: ' . $r['location']);
    assertSame(1, (int) val('SELECT is_blocked FROM np_devices WHERE id=?', [$devAId]), 'engel');
    assertThat(one("SELECT id FROM np_audit WHERE tenant_id=? AND action='device.block'", [$A['id']]) !== null,
        'device.block kaydi yok');
    http('POST', $PANEL . '/admin/index.php', [
        'csrf' => csrf_token($PANEL), 'action' => 'device_block',
        'id' => $devAId, 'blocked' => 0, 'back_tenant' => $A['id']]);
});
check('sifre sifirlama kaydediliyor - ama sifre kayitlara yazilmiyor', function () use ($PANEL, $A) {
    $pw = 'GizliSifre' . bin2hex(random_bytes(3));
    $before = val('SELECT password_hash FROM np_tenants WHERE id=?', [$A['id']]);
    http('POST', $PANEL . '/admin/index.php', [
        'csrf' => csrf_token($PANEL), 'action' => 'tenant_password',
        'tenant_id' => $A['id'], 'password' => $pw]);
    $after = val('SELECT password_hash FROM np_tenants WHERE id=?', [$A['id']]);
    assertThat($before !== $after, 'sifre degismedi');
    assertThat(password_verify($pw, (string) $after), 'yeni sifre dogrulanmiyor');
    $leak = val('SELECT COUNT(*) FROM np_audit WHERE detail LIKE ? OR subject LIKE ?', ['%' . $pw . '%', '%' . $pw . '%']);
    assertSame(0, (int) $leak, 'sifre denetim kaydina yazilmis');
    assertThat(one("SELECT id FROM np_audit WHERE tenant_id=? AND action='tenant.password_reset'", [$A['id']]) !== null,
        'tenant.password_reset kaydi yok');
});
check('csrf olmadan lisans degistirilemiyor', function () use ($PANEL, $A) {
    $before = (int) val('SELECT seats FROM np_licences WHERE id=?', [$A['licence_id']]);
    $r = http('POST', $PANEL . '/admin/index.php', [
        'csrf' => 'sahte', 'action' => 'seats_save',
        'tenant_id' => $A['id'], 'licence_id' => $A['licence_id'], 'seats' => 77]);
    assertSame(400, $r['status'], 'gecersiz csrf reddedilmeli');
    assertSame($before, (int) val('SELECT seats FROM np_licences WHERE id=?', [$A['licence_id']]), 'kasa sayisi degismis');
});
check('bir isletmenin lisansi baska isletme uzerinden degistirilemiyor', function () use ($PANEL, $A, $B) {
    /* Every licence write is scoped by tenant_id as well as licence id, so a
       forged tenant_id on the form cannot reach another customer's row. */
    $before = (int) val('SELECT seats FROM np_licences WHERE id=?', [$A['licence_id']]);
    http('POST', $PANEL . '/admin/index.php', [
        'csrf' => csrf_token($PANEL), 'action' => 'seats_save',
        'tenant_id' => $B['id'], 'licence_id' => $A['licence_id'], 'seats' => 55]);
    assertSame($before, (int) val('SELECT seats FROM np_licences WHERE id=?', [$A['licence_id']]),
        'baska kiracinin id\'siyle lisans degistirildi');
});

/* --------------------- 6. the chain gate still holds ---------------------- */
echo "\n6. Zincir kapisi: tek subeli musteri zincir ekranlarini gormuyor\n";

check('tek subeli musteride zincir ekranlari kapali', function () use ($PANEL, $A) {
    q('DELETE FROM np_branches WHERE tenant_id=?', [$A['id']]);
    q('INSERT INTO np_branches (tenant_id, code, name, is_active) VALUES (?,?,?,1)', [$A['id'], 'MERKEZ', 'Merkez']);
    foreach (['menu', 'menuversions', 'exceptions', 'rapor'] as $pg) {
        $r = http('GET', $PANEL . '/admin/index.php?p=' . $pg . '&id=' . $A['id']);
        assertRendered($r, $pg);
        assertThat(mb_strpos($r['body'], 'tek şube olarak çalışıyor') !== false,
            "?p={$pg} tek subeli musteride acilmamali");
    }
});
check('tek subeli musterinin kartinda sube raporu baglantisi yok', function () use ($PANEL, $A) {
    $r = http('GET', $PANEL . '/admin/index.php?p=tenant&id=' . $A['id']);
    assertThat(strpos($r['body'], 'p=rapor&id=' . $A['id']) === false,
        'tek subeli musteriye sube raporu baglantisi gosterilmis');
});
check('ikinci sube eklenince zincir ekranlari aciliyor', function () use ($PANEL, $A) {
    q('INSERT INTO np_branches (tenant_id, code, name, is_active) VALUES (?,?,?,1)', [$A['id'], 'SAHIL', 'Sahil']);
    $r = http('GET', $PANEL . '/admin/index.php?p=menu&id=' . $A['id']);
    assertRendered($r, 'menu');
    assertThat(mb_strpos($r['body'], 'tek şube olarak çalışıyor') === false, 'hala kapali');
    assertThat(mb_strpos($r['body'], 'Ana menü') !== false, 'ana menu ekrani gelmedi');
});
check('sube listesi her zaman aciliyor - ikinci sube oradan ekleniyor', function () use ($PANEL, $B) {
    $r = http('GET', $PANEL . '/admin/index.php?p=branches&id=' . $B['id']);
    assertRendered($r, 'branches');
    assertThat(mb_strpos($r['body'], 'Şubeler') !== false, 'sube ekrani gelmedi');
});

/* -------------------- 6a. the login page tells nothing --------------------- */
/*
 * The login screen is the one page on this host that anybody on the internet
 * can read. It used to print how many restaurants were paying, how many tills
 * were installed and which build was published - a vendor's customer count,
 * free to any competitor who found the address, and a version number pointing
 * whoever is looking at exactly which build to go and read about.
 *
 * Nothing that counts the business belongs in front of the password.
 */
echo "\n6a. Giris ekrani: sifreden once hicbir is bilgisi yok\n";

check('giris ekrani musteri ya da kasa sayisi gostermiyor', function () use ($PANEL) {
    $r = anon('GET', $PANEL . '/admin/index.php?p=login');
    assertSame(200, $r['status'], 'giris ekrani acilmadi');
    assertThat(stripos($r['body'], 'Panel girişi') !== false, 'giris ekrani gelmedi');
    foreach (['aktif işletme', 'kayıtlı kasa', 'yayındaki sürüm'] as $leak) {
        assertThat(mb_stripos($r['body'], $leak) === false,
            'giris ekrani "' . $leak . '" bilgisini sifreden once gosteriyor');
    }
});

check('giris ekrani yayindaki surum numarasini sizdirmiyor', function () use ($PANEL) {
    $cur = panel_current_version();
    if (!$cur) return;
    $r = anon('GET', $PANEL . '/admin/index.php?p=login');
    assertThat(strpos($r['body'], 'v' . $cur['version']) === false,
        'giris ekrani yayindaki surum numarasini yaziyor: v' . $cur['version']);
});

check('sayilar girisin obur tarafinda duruyor', function () use ($PANEL) {
    /* Removed from the public page, not from the product: the figures still
       have to be on Genel for the person who has actually logged in - the
       session from section 2 is still in the jar. */
    $r = http('GET', $PANEL . '/admin/index.php?p=home');
    assertRendered($r, 'home');
    assertThat(mb_stripos($r['body'], 'işletme') !== false,
        'giris yapildiktan sonra da isletme sayisi gorunmuyor');
});

/* ------------------------------ 6b. the clock ----------------------------- */
/*
 * A Turkish product on an American hosting account: every absolute time on
 * every screen was seven hours behind the restaurant's own wall clock. Worse
 * than the display, PHP and MariaDB were free to be on DIFFERENT zones, and
 * every relative time ("az önce") and every alert threshold is a difference
 * between the two - correct only while the two clocks agree.
 */
echo "\n6b. Saat: panel ile veritabani ayni saatte\n";

check('PHP ve MariaDB ayni saat diliminde', function () {
    $php = (new DateTime('now'))->format('P');
    $sql = one('SELECT @@session.time_zone tz, NOW() n');
    assertThat($sql !== null, 'veritabani saati okunamadi');
    /* Whatever the zone is called on either side, the wall clocks must match. */
    $dbNow  = strtotime((string) $sql['n']);
    $phpNow = time();
    assertThat(abs($dbNow - $phpNow) < 120,
        'PHP ile veritabani saati ' . round(abs($dbNow - $phpNow) / 60) . ' dakika farkli ('
        . $php . ' / ' . $sql['tz'] . ') - "az once" ve uyari esikleri yanlis hesaplanir');
});

check('panel saati yapilandirilan saat diliminde', function () {
    $want = (string) (cfg('timezone') ?: 'Europe/Istanbul');
    assertSame($want, date_default_timezone_get(), 'PHP saat dilimi ayarlanmamis');
    /* The session's real offset, asked of the server rather than read off its
       name - '+03:00', 'Europe/Istanbul' and 'SYSTEM' can all be the same
       clock, and only one of them is a string we could have compared. */
    $wantMin = (int) round((new DateTimeZone($want))->getOffset(new DateTime('now')) / 60);
    $dbMin = (int) one('SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) o')['o'];
    assertThat(abs($dbMin - $wantMin) <= 1,
        'veritabani oturumu ' . $want . ' saatinde degil (beklenen ' . $wantMin
        . ' dk, gelen ' . $dbMin . ' dk)');
});

check('kaydedilen zaman geri okundugunda ayni zaman', function () {
    /* The round trip is what the screens actually do: MariaDB writes NOW(),
       PHP reads the string back and subtracts it from time(). If the two are
       on different clocks this lands hours away from zero and every "az önce"
       on the panel is a lie. */
    q("INSERT INTO np_audit (actor, action, subject) VALUES ('tz-test', 'tz.probe', 'saat')");
    $row = one("SELECT created_at FROM np_audit WHERE action='tz.probe' ORDER BY id DESC LIMIT 1");
    $drift = time() - strtotime((string) $row['created_at']);
    q("DELETE FROM np_audit WHERE action='tz.probe'");
    assertThat(abs($drift) < 120, 'yeni yazilan kayit ' . $drift . ' saniye kaymis gorunuyor');
});

/* ---------------------- 7. version distribution --------------------------- */
echo "\n7. Surum dagitimi\n";

check('yayindaki surum ekrani kurulum dosyasinin varligini bildiriyor', function () use ($PANEL) {
    $r = http('GET', $PANEL . '/admin/index.php?p=versions');
    assertRendered($r, 'versions');
    $cur = panel_current_version();
    if ($cur) {
        assertThat(strpos($r['body'], (string) $cur['filename']) !== false, 'kurulum dosyasi adi ekranda yok');
    }
});
check('dosyasi yuklenmemis surum uyari veriyor', function () {
    $cur = panel_current_version();
    if (!$cur) return;
    $fi = panel_release_file($cur);
    assertThat(is_array($fi) && array_key_exists('present', $fi), 'dosya kontrolu calismiyor');
    /* A published row whose installer is not on disk must be reported, because
       latest.yml keeps advertising it and every till that tries to take it fails. */
    $rows = all('SELECT * FROM np_versions');
    foreach ($rows as $v) {
        $x = panel_release_file($v);
        assertThat(is_bool($x['present']), 'dosya durumu bool olmali');
    }
});
/*
 * Seven endpoints call touch_device and they do not all send app_version. The
 * relay poller runs every few seconds and sends none, so for one whole release
 * it overwrote the version the half-hourly heartbeat had just written - the
 * Surum column read "—" on every screen and the "eski surum" alert rule could
 * never fire. The till was never at fault.
 */
check('surum bildiren cagri sonrasi bildirmeyen cagri surumu silmiyor', function () use ($PANEL, $A, $devA) {
    $hb = api_post($PANEL . '/api/desktop/heartbeat.php', [
        'client_id' => $A['id'], 'licence_key' => $A['key'],
        'device_id' => $devA, 'app_version' => '9.9.9',
    ]);
    assertSame(200, $hb['status'], 'heartbeat HTTP durumu');
    $v = one('SELECT app_version FROM np_devices WHERE tenant_id=? AND device_id=?', [$A['id'], $devA]);
    assertSame('9.9.9', (string) $v['app_version'], 'heartbeat surumu yazmadi');

    /* the relay poll: identifies the device, says nothing about the version */
    api_post($PANEL . '/api/desktop/relay_poll.php', [
        'client_id' => $A['id'], 'licence_key' => $A['key'],
        'device_id' => $devA, 'after_id' => 0, 'wait' => 0,
    ]);
    $after = one('SELECT app_version, last_seen_at FROM np_devices WHERE tenant_id=? AND device_id=?',
        [$A['id'], $devA]);
    assertSame('9.9.9', (string) $after['app_version'],
        'surum bildirmeyen bir cagri kayitli surumu sildi');
    assertThat(!empty($after['last_seen_at']), 'son baglanti guncellenmedi');
});

/*
 * The alarm on this page is for the current build only. An old version whose
 * installer has been rotated out of indir/ is ordinary housekeeping, and a red
 * banner that fires on housekeeping is one people stop reading.
 */
check('eski surumun dosyasi yoksa kirmizi alarm verilmiyor', function () use ($PANEL) {
    q("INSERT INTO np_versions (version, channel, filename, size_bytes, is_current)
       VALUES ('0.0.9-test', 'stable', 'HicVarOlmayan-0.0.9.exe', 123, 0)
       ON DUPLICATE KEY UPDATE filename=VALUES(filename), is_current=0");
    $r = http('GET', $PANEL . '/admin/index.php?p=versions');
    assertRendered($r, 'versions');
    $cur = panel_current_version();
    $curOk = !$cur || panel_release_file($cur)['present'];
    if ($curOk) {
        assertThat(strpos($r['body'], 'flash bad') === false,
            'dosyasi olmayan ESKI surum kirmizi alarm veriyor');
    }
    assertThat(strpos($r['body'], 'dosya yok') !== false, 'eski surum listede isaretlenmemis');
});

check('guncel surum silinemez, eski surum kaydi silinebilir', function () use ($PANEL) {
    $row = one("SELECT * FROM np_versions WHERE version='0.0.9-test'");
    assertThat((bool) $row, 'test surumu bulunamadi');
    $csrf = csrf_token($PANEL);
    http('POST', $PANEL . '/admin/index.php?p=versions',
        ['csrf' => $csrf, 'action' => 'version_delete', 'version_id' => $row['id']]);
    assertThat(!one("SELECT id FROM np_versions WHERE version='0.0.9-test'"),
        'eski surum kaydi silinmedi');

    $cur = panel_current_version();
    if ($cur) {
        http('POST', $PANEL . '/admin/index.php?p=versions',
            ['csrf' => $csrf, 'action' => 'version_delete', 'version_id' => $cur['id']]);
        assertThat((bool) one('SELECT id FROM np_versions WHERE id=?', [$cur['id']]),
            'GUNCEL surum silindi - latest.yml artik hicbir seyi gostermiyor');
    }
});

check('dosyasi olmayan bir kayit guncel yapilamaz', function () use ($PANEL) {
    q("INSERT INTO np_versions (version, channel, filename, size_bytes, is_current)
       VALUES ('0.0.8-test', 'stable', 'HicVarOlmayan-0.0.8.exe', 123, 0)
       ON DUPLICATE KEY UPDATE filename=VALUES(filename), is_current=0");
    $row = one("SELECT * FROM np_versions WHERE version='0.0.8-test'");
    $csrf = csrf_token($PANEL);
    http('POST', $PANEL . '/admin/index.php?p=versions',
        ['csrf' => $csrf, 'action' => 'version_current', 'version_id' => $row['id']]);
    $after = one('SELECT is_current FROM np_versions WHERE id=?', [$row['id']]);
    assertSame(0, (int) $after['is_current'],
        'kurulum dosyasi olmayan bir surum guncel yapildi - kasalar 404 indirmeye calisir');
    q('DELETE FROM np_versions WHERE id=?', [$row['id']]);
});

check('latest.yml guncel surumu veriyor', function () use ($PANEL) {
    $cur = panel_current_version();
    if (!$cur) return;
    $r = http('GET', $PANEL . '/indir/latest.yml.php');
    assertSame(200, $r['status'], 'latest.yml HTTP durumu');
    assertThat(strpos($r['body'], 'version: ' . $cur['version']) !== false,
        'latest.yml guncel surumu bildirmiyor');
});

/*
 * A feed is either complete or it is not published. Half of one is worse than
 * none: a real till logged
 *
 *   Update info doesn't contain nor sha256 neither sha512 checksum:
 *   { "url": "...3.5.6.exe", "sha512": null, "size": 0 }
 *
 * on every start for a week, because a row was current while its installer had
 * never been uploaded. electron-updater does not shrug at an empty checksum, it
 * errors - so no till on the estate could ever have updated itself, and the
 * message blamed a checksum rather than the missing file.
 */
check('latest.yml yarim bir akis yayinlamaz', function () use ($PANEL) {
    q("INSERT INTO np_versions (version, channel, filename, size_bytes, sha512, is_current)
       VALUES ('0.0.9-test', 'stable', 'HicYuklenmemis-0.0.9.exe', 0, NULL, 1)
       ON DUPLICATE KEY UPDATE size_bytes=0, sha512=NULL, is_current=1");
    $body = http('GET', $PANEL . '/indir/latest.yml.php')['body'];
    q("DELETE FROM np_versions WHERE version='0.0.9-test'");

    assertThat(!preg_match('/sha512:\s*$/m', $body),
        'latest.yml bos bir sha512 yayinladi - her kasa her aciliste hata verir');
    assertThat(!preg_match('/size:\s*0\s*$/m', $body),
        'latest.yml size: 0 yayinladi');
    assertThat(strpos($body, '#') === 0,
        'dosyasi olmayan surum icin akis yayinlanmamali, yorum donmeli: ' . substr($body, 0, 80));
});

/* A version the updater's semver parser cannot read is the same failure with a
   different message ("3.5.1." - one stray keystroke in the publish form). */
check('latest.yml gecersiz surum numarasini yayinlamaz', function () use ($PANEL) {
    q("INSERT INTO np_versions (version, channel, filename, size_bytes, sha512, is_current)
       VALUES ('9.9.9.', 'stable', 'Bozuk-9.9.9.exe', 100, 'AAAA', 1)
       ON DUPLICATE KEY UPDATE size_bytes=100, sha512='AAAA', is_current=1");
    $body = http('GET', $PANEL . '/indir/latest.yml.php')['body'];
    q("DELETE FROM np_versions WHERE version='9.9.9.'");
    assertThat(strpos($body, '#') === 0,
        'gecersiz surum numarasi yayinlandi: ' . substr($body, 0, 80));
});

/* ---------------------------- 8. the shell -------------------------------- */
/*
 * The sidebar is a promise: every line in it opens something, and the panel
 * tells you which line you are on. Both halves are checked here against the
 * one definition in admin/nav.php, so a new area added to the sidebar is
 * covered the moment it is listed - there is no second list to remember.
 *
 * The third check is the one that protects everybody else's links: every ?p=
 * the panel answered before the shell was rebuilt still has to answer. A URL
 * in somebody's bookmarks, in an e-mail or in a support note is part of the
 * product.
 */
echo "\n8. Kabuk: kenar cubugu, aktif isaret ve eski adresler\n";

require_once __DIR__ . '/../admin/nav.php';

/** The sidebar entry the page says it is on: [href, label]. */
function marked_item(string $html): array {
    if (!preg_match('~<a href="([^"]+)"\s+class="on"\s+aria-current="page"\s*>([^<]*)</a>~u', $html, $m)) {
        throw new RuntimeException('hicbir menu ogesi isaretlenmemis');
    }
    if (substr_count($html, 'aria-current="page"') !== 1) {
        throw new RuntimeException(substr_count($html, 'aria-current="page"') . ' menu ogesi birden isaretli');
    }
    return [html_entity_decode($m[1], ENT_QUOTES, 'UTF-8'), trim($m[2])];
}

/** The group the sidebar shows as open, and whether the marked item is in it. */
function open_group_holds_marked(string $html): bool {
    if (substr_count($html, '<div class="nav-group on">') !== 1) return false;
    $start = strpos($html, '<div class="nav-group on">');
    $rest = substr($html, $start + 6);
    $end = strpos($rest, '<div class="nav-group');   // the next group, or the end of the nav
    $block = $end === false ? $rest : substr($rest, 0, $end);
    return strpos($block, 'aria-current="page"') !== false;
}

/* Every entry the sidebar offers - the built ones and the ones still to come. */
foreach (nav_items() as $key => $it) {
    $url = $it['href'] ?? ('index.php?p=' . $key);

    check("menu girisi '{$it['label']}' yonetici icin aciliyor", function () use ($PANEL, $url, $it) {
        $r = http('GET', $PANEL . '/admin/' . $url);
        assertRendered($r, $it['label']);
        /* A nav entry may be a finished screen or a "hazirlaniyor" notice.
           What it may never be is the 404 - a dead link in the chrome reads
           as a broken product, not as unfinished work. */
        assertThat(mb_strpos($r['body'], 'Böyle bir sayfa yok') === false,
            "menudeki '{$it['label']}' 404 veriyor");
    });

    check("menu girisi '{$it['label']}' kendini isaretliyor", function () use ($PANEL, $url, $key, $it) {
        $r = http('GET', $PANEL . '/admin/' . $url);
        [$href, $label] = marked_item($r['body']);
        $want = $it['href'] ?? ('index.php?p=' . $key);
        assertSame($want, $href, "isaretli menu ogesinin adresi");
        assertSame($it['label'], $label, 'isaretli menu ogesinin etiketi');
        assertThat(open_group_holds_marked($r['body']),
            "'{$it['label']}' icin acik grup isaretlenmemis ya da ogeyi icermiyor");
    });
}

/* An alias - a detail screen, a filtered list - marks its parent, not itself. */
check('alt ekranlar ust menu ogesini isaretliyor', function () use ($PANEL, $A) {
    foreach (['tenant&id=' . $A['id'] => 'İşletmeler',
              'liste&k=exp30' => 'İşletmeler',
              'branches&id=' . $A['id'] => 'İşletmeler'] as $pg => $parent) {
        $r = http('GET', $PANEL . '/admin/index.php?p=' . $pg);
        [, $label] = marked_item($r['body']);
        assertSame($parent, $label, "?p={$pg} yanlis menu ogesini isaretliyor");
    }
});

/* Nothing that answered before may 404 now. */
$legacy = ['home', 'tenants', 'devices', 'backups', 'relay', 'versions', 'audit', 'liste',
           'tenant&id=' . $A['id'], 'liste&k=exp30', 'liste&k=silent', 'liste&k=backup',
           'liste&k=outdated', 'liste&k=noinstall', 'liste&k=lapsed', 'liste&k=blocked',
           'liste&k=online', 'branches&id=' . $A['id'], 'menu&id=' . $A['id'],
           'menuversions&id=' . $A['id'], 'exceptions&id=' . $A['id'], 'rapor&id=' . $A['id']];
foreach ($legacy as $pg) {
    check("eski adres ?p={$pg} hala calisiyor", function () use ($PANEL, $pg) {
        $r = http('GET', $PANEL . '/admin/index.php?p=' . $pg);
        assertRendered($r, $pg);
        assertThat(mb_strpos($r['body'], 'Böyle bir sayfa yok') === false, 'artik 404 veriyor');
    });
}

check('bilinmeyen adres hala 404, hazirlaniyor notu degil', function () use ($PANEL) {
    $r = http('GET', $PANEL . '/admin/index.php?p=hicbiryerdeyok');
    assertRendered($r, '404');
    assertThat(mb_strpos($r['body'], 'Böyle bir sayfa yok') !== false, '404 metni yok');
    assertThat(mb_strpos($r['body'], 'Hazırlanıyor') === false, 'bilinmeyen adrese hazirlaniyor notu verilmis');
});

/* And none of it is visible without a session - including the new areas, which
   is the point at which "not built yet" would otherwise leak a door. */
$saved = $JAR . '.saved';
@copy($JAR, $saved);
@unlink($JAR);
foreach (array_keys(nav_items()) as $key) {
    $it = nav_items()[$key];
    $url = $it['href'] ?? ('index.php?p=' . $key);
    check("menu girisi '{$it['label']}' oturumsuz girise yonlendiriyor", function () use ($PANEL, $url) {
        $r = http('GET', $PANEL . '/admin/' . $url);
        assertSame(302, $r['status'], 'HTTP durumu');
        assertThat(strpos($r['location'], 'p=login') !== false,
            'login sayfasina yonlendirmeli, giden: ' . $r['location']);
    });
}
@unlink($JAR);
@rename($saved, $JAR);

/* --------------------- 9. giving a cloud backup back ---------------------- */
/*
 * The nightly upload has worked since the first release and nothing ever gave
 * a file back, so this is the half that has never been exercised: a till that
 * has lost its disk asking for last night, and the vendor pulling a copy for
 * somebody who is on the phone.
 *
 * What is actually being tested is not "does a file arrive" - that is one
 * check. It is the four ways this feature could hand a restaurant's entire
 * database to the wrong person:
 *
 *   - by id. np_backups.id is a plain incrementing integer, so anybody with
 *     one valid licence key can count. Asking for somebody else's number must
 *     give back exactly what asking for a number nobody has gives back; a
 *     different message is a yes/no oracle over the whole customer base.
 *   - by URL. The files sit outside public_html, and no link, alias or
 *     traversal may reach one without a licence key or an admin session.
 *   - by path. np_backups.path is a column, and a column is data. A row whose
 *     path was pointed somewhere else must not turn this into a file reader.
 *   - by silence. Every copy that leaves has to be on the record.
 *
 * And one correctness check with the same weight as the isolation ones: the
 * sha256 in the header has to describe the bytes in the body, because the till
 * uses it to decide whether to overwrite a live database.
 */
echo "\n9. Bulut yedegi geri verme: kendi yedegin, yalniz kendi yedegin\n";

/* Same rules the endpoints use for finding the file behind a row, so the
   fixture cannot "find" a file the panel itself would refuse to serve. */
require_once __DIR__ . '/../lib/backup.php';

/** A desktop-API call that may answer with a FILE: headers kept, body raw. */
function api_fetch(string $url, array $payload): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_HEADER => true, CURLOPT_TIMEOUT => 60,
    ]);
    $raw = (string) curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hsize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);
    $head = substr($raw, 0, $hsize);
    $body = substr($raw, $hsize);
    return ['status' => $status, 'head' => $head, 'body' => $body, 'json' => json_decode($body, true)];
}

/** One named response header, lower-cased, or '' when it was not sent. */
function head_val(string $head, string $name): string {
    return preg_match('/^' . preg_quote($name, '/') . ':\s*(.+)$/mi', $head, $m) ? trim($m[1]) : '';
}

/* The real upload endpoint puts the files where the panel expects them - a
   fixture that wrote them itself would prove the download works against a
   layout nothing else uses. */
function upload_backup(string $panel, array $t, string $device, string $name, string $bin): array {
    return api_post($panel . '/api/desktop/backup.php', [
        'client_id' => $t['id'], 'licence_key' => $t['key'], 'device_id' => $device,
        'filename' => $name, 'data' => base64_encode($bin), 'sha256' => hash('sha256', $bin),
    ]);
}

$binA = gzencode("-- NOKTApp POS A yedegi\n" . str_repeat("INSERT INTO siparis VALUES (1,'masa 4');\n", 3000));
$binB = gzencode("-- NOKTApp POS B yedegi\n" . str_repeat("INSERT INTO siparis VALUES (9,'masa 1');\n", 3000));
$nameA = 'ptest-a-' . bin2hex(random_bytes(4)) . '.sql.gz';
$nameB = 'ptest-b-' . bin2hex(random_bytes(4)) . '.sql.gz';

$upA = upload_backup($PANEL, $A, $devA, $nameA, $binA);
$upB = upload_backup($PANEL, $B, $devB, $nameB, $binB);
$bkA = one('SELECT * FROM np_backups WHERE tenant_id=? ORDER BY id DESC LIMIT 1', [$A['id']]);
$bkB = one('SELECT * FROM np_backups WHERE tenant_id=? ORDER BY id DESC LIMIT 1', [$B['id']]);

check('yedek yuklemesi kaydediliyor (bu bolumun on sarti)', function () use ($upA, $upB, $bkA, $bkB, $nameA, $nameB) {
    assertSame(200, $upA['status'], 'A yuklemesi HTTP durumu');
    assertSame(200, $upB['status'], 'B yuklemesi HTTP durumu');
    assertThat($bkA !== null && $bkA['filename'] === $nameA, 'A yedegi kaydedilmedi');
    assertThat($bkB !== null && $bkB['filename'] === $nameB, 'B yedegi kaydedilmedi');
});

/* ---- the till gets its own ---- */
check('kasa kendi yedeklerini listeleyebiliyor', function () use ($PANEL, $A, $devA, $bkA, $binA) {
    $r = api_fetch($PANEL . '/api/desktop/backup_list.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA]);
    assertSame(200, $r['status'], 'HTTP durumu');
    assertThat(!empty($r['json']['ok']), 'ok gelmedi: ' . substr($r['body'], 0, 200));
    $ids = array_column($r['json']['backups'] ?? [], 'id');
    assertThat(in_array((int) $bkA['id'], $ids, true), 'kendi yedegi listede yok');
    $row = null;
    foreach ($r['json']['backups'] as $b) if ((int) $b['id'] === (int) $bkA['id']) $row = $b;
    /* The shape the till is written against - a missing key here is a till
       that cannot tell which night it is looking at. */
    foreach (['id', 'filename', 'size_bytes', 'sha256', 'created_at'] as $k) {
        assertThat(array_key_exists($k, $row), "listede '{$k}' alani yok");
    }
    assertSame(strlen($binA), (int) $row['size_bytes'], 'boyut');
    assertSame(hash('sha256', $binA), (string) $row['sha256'], 'sha256');
});

check('yedek listesi sunucudaki dosya yolunu sizdirmiyor', function () use ($PANEL, $A, $devA) {
    /* Where a file sits on our disk is not the till's business, and it is the
       first thing anybody poking at this endpoint would like to be told. */
    $r = api_fetch($PANEL . '/api/desktop/backup_list.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA]);
    foreach ($r['json']['backups'] ?? [] as $b) {
        assertThat(!array_key_exists('path', $b), 'listede dosya yolu var');
    }
    $dir = rtrim((string) cfg('backup_dir'), '/');
    assertThat(strpos($r['body'], $dir) === false, 'cevapta sunucu klasoru yaziyor: ' . $dir);
});

check('kasa kendi yedegini indirebiliyor', function () use ($PANEL, $A, $devA, $bkA, $binA) {
    $r = api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA, 'id' => (int) $bkA['id']]);
    assertSame(200, $r['status'], 'HTTP durumu');
    assertSame(strlen($binA), strlen($r['body']), 'gelen dosya boyutu');
    assertThat($r['body'] === $binA, 'gelen dosya yuklenenle ayni degil');
});

check('indirilen yedegin sha256 basligi govdedeki baytlarin aynisi', function () use ($PANEL, $A, $devA, $bkA) {
    /* The till verifies this before it overwrites a live database. A header
       that describes what arrived MONTHS ago rather than what is going out
       now would pass every day except the one that matters. */
    $r = api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA, 'id' => (int) $bkA['id']]);
    $sha = head_val($r['head'], 'X-Backup-Sha256');
    assertThat($sha !== '', 'X-Backup-Sha256 basligi yok');
    assertSame(hash('sha256', $r['body']), $sha, 'baslikta yazan sha256 govdeyle tutmuyor');
    assertSame((string) strlen($r['body']), head_val($r['head'], 'Content-Length'), 'Content-Length govdeyle tutmuyor');
});

check('yedek JSON icine base64 edilmeden akitiliyor', function () use ($PANEL, $A, $devA, $bkA, $binA) {
    /* Base64 in this direction means holding the whole dump plus a third again
       in PHP's memory on shared hosting: the request dies at memory_limit and
       the restaurant is told nothing useful. */
    $r = api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA, 'id' => (int) $bkA['id']]);
    assertThat(strpos(strtolower(head_val($r['head'], 'Content-Type')), 'json') === false,
        'dosya JSON olarak donuyor');
    assertThat(substr($r['body'], 0, 2) === "\x1f\x8b", 'govde ham gzip degil');
    assertThat(strpos($r['body'], base64_encode(substr($binA, 0, 60))) === false, 'govde base64 edilmis');
});

/* ---- and nobody else's ---- */
check('kasa baska kiracinin yedegini listede gormuyor', function () use ($PANEL, $A, $devA, $bkB, $nameB) {
    $r = api_fetch($PANEL . '/api/desktop/backup_list.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA]);
    $ids = array_column($r['json']['backups'] ?? [], 'id');
    assertThat(!in_array((int) $bkB['id'], $ids, true), 'baska kiracinin yedegi listede');
    assertThat(strpos($r['body'], $nameB) === false, 'baska kiracinin dosya adi listede');
});

check('baska kiracinin yedegi, hic olmayan yedekle AYNI cevabi aliyor', function () use ($PANEL, $A, $devA, $bkB, $binB) {
    /* The refusals are compared byte for byte on purpose. A different status,
       or the same status with a different message, turns np_backups.id into a
       yes/no oracle: count the integers and you learn which restaurants back
       up and how often. */
    $foreign = api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA, 'id' => (int) $bkB['id']]);
    $ghost = api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA, 'id' => 2000000000]);
    assertThat($foreign['body'] !== $binB, 'baska kiracinin yedegi teslim edildi');
    assertSame($ghost['status'], $foreign['status'],
        'baskasinin id\'si ile olmayan id farkli HTTP durumu veriyor');
    assertSame($ghost['body'], $foreign['body'],
        'baskasinin id\'si ile olmayan id farkli cevap veriyor - id oracle');
    assertThat($foreign['status'] === 404, 'reddetme 404 olmali, gelen ' . $foreign['status']);
});

check('kendi anahtariyla baska kiracinin dosya adini isteyen bir sey alamiyor', function () use ($PANEL, $B, $devB, $bkA, $binA) {
    $r = api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $B['id'], 'licence_key' => $B['key'], 'device_id' => $devB, 'id' => (int) $bkA['id']]);
    assertSame(404, $r['status'], 'HTTP durumu');
    assertThat($r['body'] !== $binA, 'diger kiracinin yedegi teslim edildi');
});

check('yanlis lisans anahtari ne liste ne dosya aliyor', function () use ($PANEL, $A, $devA, $bkA, $binA, $nameA) {
    $l = api_fetch($PANEL . '/api/desktop/backup_list.php',
        ['client_id' => $A['id'], 'licence_key' => 'YANLIS-ANAHTAR', 'device_id' => $devA]);
    assertSame(401, $l['status'], 'liste HTTP durumu');
    assertThat(strpos($l['body'], $nameA) === false, 'yanlis anahtara dosya adi verildi');
    $g = api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $A['id'], 'licence_key' => 'YANLIS-ANAHTAR', 'device_id' => $devA, 'id' => (int) $bkA['id']]);
    assertSame(401, $g['status'], 'indirme HTTP durumu');
    assertThat($g['body'] !== $binA, 'yanlis anahtara dosya verildi');
});

check('lisans anahtari olmadan ne liste ne dosya aliniyor', function () use ($PANEL, $A, $devA, $bkA, $binA) {
    $l = api_fetch($PANEL . '/api/desktop/backup_list.php', ['client_id' => $A['id'], 'device_id' => $devA]);
    assertSame(401, $l['status'], 'liste HTTP durumu');
    $g = api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $A['id'], 'device_id' => $devA, 'id' => (int) $bkA['id']]);
    assertSame(401, $g['status'], 'indirme HTTP durumu');
    assertThat($g['body'] !== $binA, 'anahtarsiz istege dosya verildi');
});

check('askiya alinmis lisans yedegini geri alamiyor', function () use ($PANEL, $A, $devA, $bkA, $binA) {
    /* A suspended licence is suspended for the whole product, not just for the
       screens: a customer who has stopped paying does not get to pull his
       database out on the way to a competitor's till software. */
    q("UPDATE np_licences SET status='suspended' WHERE tenant_id=?", [$A['id']]);
    $g = api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA, 'id' => (int) $bkA['id']]);
    q("UPDATE np_licences SET status='active' WHERE tenant_id=?", [$A['id']]);
    assertSame(403, $g['status'], 'HTTP durumu');
    assertThat($g['body'] !== $binA, 'askiya alinmis lisansa dosya verildi');
});

/* ---- the file itself, and the row that points at it ---- */
check('kayitli sha256 ile diskteki dosya tutmuyorsa yedek geri verilmiyor', function () use ($PANEL, $A, $devA, $bkA) {
    /* A dump that rotted on our disk - a half-written file from a disk that
       filled up - looks exactly like a good one until it is hashed, and the
       day it is restored from is the day somebody has already lost the
       original. Serving it with a freshly computed hash would make the till's
       own verification pass on a broken file. */
    $path = backup_path($bkA);
    assertThat($path !== null, 'yedek dosyasi diskte bulunamadi');
    $good = file_get_contents($path);
    file_put_contents($path, $good . 'bozuk');
    $g = api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA, 'id' => (int) $bkA['id']]);
    file_put_contents($path, $good);
    assertSame(500, $g['status'], 'bozuk dosya icin HTTP durumu');
    assertThat(strpos($g['body'], 'bozul') !== false, 'bozukluk soylenmedi: ' . substr($g['body'], 0, 120));
});

check('dosyasi diskte olmayan kayit listelenmiyor ve indirilemiyor', function () use ($PANEL, $A, $devA, $binA) {
    /* A listing is an offer. Offering a night we cannot hand over sends the
       till - and the person waiting on it - down a road that ends in a 404. */
    q('INSERT INTO np_backups (tenant_id, device_id, filename, path, size_bytes, sha256)
       VALUES (?,?,?,?,?,?)',
      [$A['id'], $devA, 'ptest-hayalet.sql.gz',
       rtrim((string) cfg('backup_dir'), '/') . '/' . $A['id'] . '/ptest-hayalet.sql.gz', 123, null]);
    $ghostId = lastId();
    $l = api_fetch($PANEL . '/api/desktop/backup_list.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA]);
    $ids = array_column($l['json']['backups'] ?? [], 'id');
    $g = api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA, 'id' => $ghostId]);
    q('DELETE FROM np_backups WHERE id=?', [$ghostId]);
    assertThat(!in_array($ghostId, $ids, true), 'dosyasi olmayan kayit listeye girmis');
    assertThat($g['status'] !== 200, 'dosyasi olmayan kayit 200 dondu');
    assertThat($g['body'] !== $binA, 'baska bir dosya teslim edildi');
});

check('kaydin path sutunu sunucudaki baska bir dosyayi okutamiyor', function () use ($PANEL, $A, $devA) {
    /* np_backups.path is a column, and a column is data. If this endpoint
       followed it wherever it pointed, one edited row - a migration, an
       import, an injection anywhere else in the panel - would turn the backup
       download into a "read any file on the server" service. */
    q('INSERT INTO np_backups (tenant_id, device_id, filename, path, size_bytes, sha256)
       VALUES (?,?,?,?,?,?)', [$A['id'], $devA, 'passwd', '/etc/passwd', 100, null]);
    $evilId = lastId();
    $g = api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA, 'id' => $evilId]);
    $adm = http('GET', $PANEL . '/admin/index.php?p=backups&download=' . $evilId);
    q('DELETE FROM np_backups WHERE id=?', [$evilId]);
    foreach (['kasa' => $g['body'], 'yonetici' => $adm['body']] as $who => $body) {
        assertThat(strpos($body, 'root:') === false, $who . ' istegi /etc/passwd icerigini dondurdu');
    }
    assertThat($g['status'] !== 200, 'kasa istegi 200 dondu');
    assertThat($adm['status'] !== 200, 'yonetici istegi 200 dondu');
});

/* ---- the vendor's own copy ---- */
check('yonetici yedek ekraninda her satir icin indirme baglantisi var', function () use ($PANEL, $bkA) {
    $r = http('GET', $PANEL . '/admin/index.php?p=backups');
    assertRendered($r, 'backups');
    assertThat(strpos($r['body'], 'p=backups&download=' . (int) $bkA['id']) !== false,
        'yedek satirinda indirme baglantisi yok');
    /* Never a link at the file: the backups live outside public_html and the
       only way to one is through a checked session. */
    assertThat(strpos($r['body'], rtrim((string) cfg('backup_dir'), '/')) === false,
        'ekranda sunucudaki dosya yolu yaziyor');
});

check('yonetici indirmesi oturum istiyor', function () use ($PANEL, $bkA, $binA) {
    $r = anon('GET', $PANEL . '/admin/index.php?p=backups&download=' . (int) $bkA['id']);
    assertSame(302, $r['status'], 'HTTP durumu');
    assertThat(strpos($r['head'], 'p=login') !== false, 'girise yonlendirmeli');
    assertThat($r['body'] !== $binA, 'oturumsuz istege yedek verildi');
    assertThat(strlen($r['body']) < 400, 'oturumsuz istege govde gonderilmis');
});

check('yonetici indirmesi dosyayi veriyor ve denetim kaydi biraliyor', function () use ($PANEL, $A, $bkA, $binA) {
    $before = (int) val("SELECT COUNT(*) FROM np_audit WHERE action='backup.download'");
    $r = http('GET', $PANEL . '/admin/index.php?p=backups&download=' . (int) $bkA['id']);
    assertSame(200, $r['status'], 'HTTP durumu');
    assertThat($r['body'] === $binA, 'yoneticiye gelen dosya yuklenenle ayni degil');
    assertSame(hash('sha256', $r['body']), head_val($r['head'], 'X-Backup-Sha256'), 'sha256 basligi');
    assertSame($before + 1, (int) val("SELECT COUNT(*) FROM np_audit WHERE action='backup.download'"),
        'indirme denetim kaydi yazmadi');
    $row = one("SELECT * FROM np_audit WHERE action='backup.download' ORDER BY id DESC LIMIT 1");
    assertSame((int) $A['id'], (int) $row['tenant_id'], 'denetim kaydi isletmeye baglanmamis');
    assertThat(strpos((string) $row['detail'], (string) $bkA['id']) !== false, 'kayitta hangi yedek oldugu yok');
    assertThat($row['actor'] !== 'system', 'denetim kaydinda kimin indirdigi yok');
});

check('kasanin kendi indirmesi de denetim kaydi biraliyor', function () use ($PANEL, $A, $devA, $bkA) {
    $before = (int) val("SELECT COUNT(*) FROM np_audit WHERE action='desktop.backup_download' AND tenant_id=?", [$A['id']]);
    api_fetch($PANEL . '/api/desktop/backup_get.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $devA, 'id' => (int) $bkA['id']]);
    assertSame($before + 1,
        (int) val("SELECT COUNT(*) FROM np_audit WHERE action='desktop.backup_download' AND tenant_id=?", [$A['id']]),
        'kasa indirmesi iz birakmadi');
});

/* ---- and none of it by URL ---- */
check('yedek dosyasi duz URL ile alinamiyor', function () use ($PANEL, $A, $bkA, $binA, $nameA) {
    /* The files are outside public_html by design. These are the addresses
       somebody would try after seeing a filename on a screen or in a listing:
       the folder as if it were served, and the same thing walked into from a
       path the web server does answer. %2e%2e is deliberate - curl would
       flatten a literal '..' before the request ever left. */
    $rel = $A['id'] . '/' . $nameA;
    $urls = [
        $PANEL . '/noktapp-backups/' . $rel,
        $PANEL . '/../noktapp-backups/' . $rel,
        $PANEL . '/api/desktop/%2e%2e/%2e%2e/%2e%2e/noktapp-backups/' . $rel,
        $PANEL . '/admin/%2e%2e/%2e%2e/noktapp-backups/' . $rel,
        $PANEL . '/indir/' . $nameA,
    ];
    foreach ($urls as $u) {
        $r = anon('GET', $u);
        assertThat($r['body'] !== $binA, 'yedek su adresten alinabiliyor: ' . $u);
        assertThat(strpos($r['body'], "\x1f\x8b") !== 0, 'gzip govde geldi: ' . $u);
        assertThat($r['status'] !== 200, $u . ' 200 dondu');
    }
    /* And the endpoints themselves answer nothing to a GET without a body. */
    foreach (['backup_list', 'backup_get'] as $ep) {
        $r = anon('GET', $PANEL . '/api/desktop/' . $ep . '.php?client_id=' . $A['id']
                  . '&licence_key=' . rawurlencode($A['key']) . '&id=' . (int) $bkA['id']);
        assertThat($r['body'] !== $binA, $ep . ' lisansi adres cubugundan kabul etti');
        assertThat(strpos($r['body'], $nameA) === false, $ep . ' GET ile dosya adi verdi');
    }
});

/* The uploads are real files on disk; the row teardown below does not remove
   them, so they are cleaned up here rather than left to pile up in a sandbox
   that other suites also run against. */
foreach ([$A['id'], $B['id']] as $tid) {
    $dir = rtrim((string) cfg('backup_dir'), '/') . '/' . $tid;
    foreach (@glob($dir . '/*') ?: [] as $f) @unlink($f);
    @rmdir($dir);
}

/* ------------------------------ teardown ---------------------------------- */
drop_tenant($A['email']);
drop_tenant($B['email']);
@unlink($JAR);

echo "\n" . str_repeat('-', 62) . "\n";
if ($failures) {
    echo "BASARISIZ:\n";
    foreach ($failures as $f) echo "  - $f\n";
}
echo "\n{$pass}/{$total} checks passed\n";
exit($pass === $total ? 0 : 1);
