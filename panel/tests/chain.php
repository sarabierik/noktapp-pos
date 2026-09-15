<?php
/**
 * NOKTApp POS - chain (multi-branch) layer, panel side.
 *
 * Everything here runs against the real MariaDB and the real HTTP endpoints,
 * in the order head office would actually do it: create the branches, build
 * the master menu, publish it, let a till pull, edit, publish again, grant an
 * exception. Nothing is mocked - the failures this exists to catch (a branch
 * seeing another branch's price, an unpublished edit leaking to a till, an
 * incremental pull that quietly sends nothing) are exactly the kind a mock
 * hides.
 *
 * Two throwaway tenants are created and destroyed by the run, so the suite
 * never touches the tenant the desktop tests use.
 *
 * Run:  php panel/tests/chain.php
 * Env:  NP_DB_PORT (3399) NP_DB_USER (noktapp) NP_DB_PASS (nokpass)
 *       NP_DB_NAME (nokpos_panel)  PANEL (http://127.0.0.1:8090)
 */
foreach ([
    'NP_DB_HOST' => '127.0.0.1', 'NP_DB_PORT' => '3399', 'NP_DB_NAME' => 'nokpos_panel',
    'NP_DB_USER' => 'noktapp',   'NP_DB_PASS' => 'nokpass',
] as $k => $v) { if (getenv($k) === false) putenv("$k=$v"); }

require_once __DIR__ . '/../lib/chain.php';

$PANEL = getenv('PANEL') ?: 'http://127.0.0.1:8090';
$pass = 0; $total = 0; $failures = [];

function check(string $name, callable $fn): void {
    global $pass, $total, $failures;
    $total++;
    try {
        $fn();
        $pass++;
        echo "  PASS  $name\n";
    } catch (Throwable $e) {
        $failures[] = $name . ' -> ' . $e->getMessage();
        echo "  FAIL  $name  -> " . $e->getMessage() . "\n";
    }
}
function assertThat($cond, string $msg): void { if (!$cond) throw new RuntimeException($msg); }
function assertSame($a, $b, string $msg): void {
    if ($a !== $b) throw new RuntimeException($msg . ' (beklenen ' . var_export($a, true) . ', gelen ' . var_export($b, true) . ')');
}

/** POST/GET against the panel exactly as a till would. */
function http_call(string $method, string $url, array $body = [], array $headers = []): array {
    $h = array_merge(['Content-Type: application/json'], $headers);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $h, CURLOPT_TIMEOUT => 30,
    ]);
    if ($body) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($raw === false) throw new RuntimeException('panel yanit vermedi: ' . $err);
    $j = json_decode($raw, true);
    if (!is_array($j)) throw new RuntimeException('gecersiz JSON (' . $status . '): ' . substr($raw, 0, 200));
    return ['status' => $status] + $j;
}

/* ------------------------- fixture ------------------------- */
function drop_tenant(string $email): void {
    $t = one('SELECT id FROM np_tenants WHERE email=?', [$email]);
    if (!$t) return;
    $id = (int) $t['id'];
    foreach (['np_branch_overrides', 'np_menu_version_items', 'np_menu_versions', 'np_menu_products',
              'np_menu_categories', 'np_branches', 'np_devices', 'np_licences', 'np_reports'] as $tab) {
        q("DELETE FROM {$tab} WHERE tenant_id=?", [$id]);
    }
    q('DELETE FROM np_tenants WHERE id=?', [$id]);
}

function make_tenant(string $code, string $name, string $email): array {
    drop_tenant($email);
    q('INSERT INTO np_tenants (code, company_name, owner_name, email, password_hash, is_active)
       VALUES (?,?,?,?,?,1)', [$code, $name, 'Test', $email, password_hash('x', PASSWORD_BCRYPT)]);
    $id = lastId();
    $key = strtoupper(bin2hex(random_bytes(12)));
    q("INSERT INTO np_licences (tenant_id, licence_key, plan, status, seats, starts_at, expires_at, grace_days)
       VALUES (?,?,'standart','active',9,CURDATE(), DATE_ADD(NOW(), INTERVAL 365 DAY), 7)", [$id, $key]);
    return ['id' => $id, 'key' => $key];
}

function make_cat(int $tid, string $code, string $name, int $sort = 1, int $locked = 1): int {
    q('INSERT INTO np_menu_categories (tenant_id, master_code, name, sort_order, price_locked) VALUES (?,?,?,?,?)',
      [$tid, $code, $name, $sort, $locked]);
    return lastId();
}
function make_prod(int $tid, int $catId, string $code, string $name, float $price, int $locked = 1): int {
    q('INSERT INTO np_menu_products (tenant_id, master_code, category_id, name, price, vat_rate, price_locked)
       VALUES (?,?,?,?,?,10.00,?)', [$tid, $code, $catId, $name, $price, $locked]);
    return lastId();
}

echo "\nNOKTApp POS - zincir (çok şubeli) katmanı, panel tarafı\n\n";

$A = make_tenant('ZTESTA', 'Zincir Test A', 'zincir-a@ornek.test');
$B = make_tenant('ZTESTB', 'Zincir Test B', 'zincir-b@ornek.test');
$tidA = $A['id']; $tidB = $B['id'];

/* Two tills at tenant A deliberately share a device_id string with tenant B's
   till: device identity is only ever meaningful inside a tenant. */
$DEV1 = 'dev-chain-1'; $DEV2 = 'dev-chain-2'; $DEVB = 'dev-chain-1';

$pullA = function (array $cred, int $since, string $device, ?string $branchCode = null) use ($PANEL) {
    $body = ['client_id' => $cred['id'], 'licence_key' => $cred['key'], 'device_id' => $device, 'since' => $since];
    if ($branchCode) $body['branch_code'] = $branchCode;
    return http_call('POST', $PANEL . '/api/desktop/menu.php', $body);
};

/* ------------------------- 1. branches ------------------------- */
check('şube oluşturuluyor ve tenant içinde kodu tekil', function () use ($tidA) {
    q('INSERT INTO np_branches (tenant_id, code, name, city) VALUES (?,?,?,?)', [$tidA, 'MERKEZ', 'Merkez', 'Antalya']);
    q('INSERT INTO np_branches (tenant_id, code, name, city) VALUES (?,?,?,?)', [$tidA, 'KALEICI', 'Kaleiçi', 'Antalya']);
    assertSame(2, chain_branch_count($tidA), 'şube sayısı');
    $dup = false;
    try { q('INSERT INTO np_branches (tenant_id, code, name) VALUES (?,?,?)', [$tidA, 'MERKEZ', 'İkinci']); }
    catch (Throwable $e) { $dup = true; }
    assertThat($dup, 'aynı kod ikinci kez eklenebildi');
});

check('tek şubeli işletmede zincir ekranları kapalı, ikinci şubede açılıyor', function () use ($tidA, $tidB) {
    q('INSERT INTO np_branches (tenant_id, code, name) VALUES (?,?,?)', [$tidB, 'TEK', 'Tek şube']);
    assertSame(false, chain_enabled($tidB), 'tek şubeli işletmede zincir açık görünüyor');
    assertSame(true, chain_enabled($tidA), 'iki şubeli işletmede zincir kapalı görünüyor');
});

$branchMerkez = (int) val('SELECT id FROM np_branches WHERE tenant_id=? AND code=?', [$tidA, 'MERKEZ']);
$branchKale   = (int) val('SELECT id FROM np_branches WHERE tenant_id=? AND code=?', [$tidA, 'KALEICI']);
$branchB      = (int) val('SELECT id FROM np_branches WHERE tenant_id=? AND code=?', [$tidB, 'TEK']);

check('kasa menü çekişinde şube koduyla şubeye bağlanıyor', function () use ($pullA, $A, $DEV1, $tidA, $branchMerkez) {
    $r = $pullA($A, 0, $DEV1, 'MERKEZ');
    assertSame(true, $r['ok'], 'çekiş başarısız: ' . ($r['error'] ?? ''));
    assertSame('MERKEZ', $r['branch']['code'] ?? null, 'yanıt şubeyi bildirmedi');
    $bound = (int) val('SELECT branch_id FROM np_devices WHERE tenant_id=? AND device_id=?', [$tidA, $DEV1]);
    assertSame($branchMerkez, $bound, 'cihaz şubeye bağlanmadı');
});

check('ikinci kasa ikinci şubeye bağlanıyor, ilki yerinde kalıyor', function () use ($pullA, $A, $DEV2, $DEV1, $tidA, $branchKale, $branchMerkez) {
    $r = $pullA($A, 0, $DEV2, 'KALEICI');
    assertSame($branchKale, (int) val('SELECT branch_id FROM np_devices WHERE tenant_id=? AND device_id=?', [$tidA, $DEV2]), 'ikinci cihaz bağlanmadı');
    assertSame($branchMerkez, (int) val('SELECT branch_id FROM np_devices WHERE tenant_id=? AND device_id=?', [$tidA, $DEV1]), 'ilk cihazın şubesi değişti');
});

check('bilinmeyen şube kodu bağlamıyor ve hata da vermiyor', function () use ($pullA, $A, $tidA) {
    $r = $pullA($A, 0, 'dev-chain-yok', 'OLMAYAN');
    assertSame(true, $r['ok'], 'çekiş hata verdi');
    assertSame(null, $r['branch'], 'olmayan koda bağlandı');
});

/* ------------------------- 2. master menu + publish ------------------------- */
$catYemek = make_cat($tidA, 'KAT_YEMEK', 'Yemekler', 1);
$catIcecek = make_cat($tidA, 'KAT_ICECEK', 'İçecekler', 2);
$pKofte = make_prod($tidA, $catYemek, 'URN_KOFTE', 'Köfte', 180.00);
$pPide  = make_prod($tidA, $catYemek, 'URN_PIDE', 'Pide', 150.00);
$pCay   = make_prod($tidA, $catIcecek, 'URN_CAY', 'Çay', 20.00, 0);   // kilidi açık

check('yayın yokken kasa boş ve sürüm 0 alıyor', function () use ($pullA, $A, $DEV1) {
    $r = $pullA($A, 0, $DEV1);
    assertSame(0, $r['version'], 'sürüm 0 değil');
    assertSame(0, count($r['products']), 'yayınlanmamış ürün gönderildi');
});

check('Yayınla bir sonraki sürümü üretiyor', function () use ($tidA) {
    $v = chain_publish($tidA, 'ilk menü', 'test@panel');
    assertSame(1, $v, 'ilk sürüm 1 değil');
    $row = one('SELECT * FROM np_menu_versions WHERE tenant_id=? AND version=1', [$tidA]);
    assertSame(3, (int) $row['product_count'], 'ürün sayısı');
    assertSame(2, (int) $row['category_count'], 'kategori sayısı');
});

check('since=0 her şeyi full:true olarak veriyor', function () use ($pullA, $A, $DEV1) {
    $r = $pullA($A, 0, $DEV1);
    assertSame(1, $r['version'], 'sürüm');
    assertSame(true, $r['full'], 'full bayrağı');
    assertSame(2, count($r['categories']), 'kategori sayısı');
    assertSame(3, count($r['products']), 'ürün sayısı');
    $codes = array_column($r['products'], 'master_code');
    sort($codes);
    assertSame(['URN_CAY', 'URN_KOFTE', 'URN_PIDE'], $codes, 'ürün kodları');
    $kofte = null;
    foreach ($r['products'] as $p) if ($p['master_code'] === 'URN_KOFTE') $kofte = $p;
    assertSame('180.00', $kofte['price'], 'fiyat');
    assertSame('KAT_YEMEK', $kofte['category_code'], 'ürün kategori koduyla geliyor');
});

check('yayından sonra yapılan düzenleme şubeye gitmiyor', function () use ($pullA, $A, $DEV1, $tidA, $pKofte) {
    q('UPDATE np_menu_products SET price=999.00, name=? WHERE id=? AND tenant_id=?', ['Köfte porsiyon', $pKofte, $tidA]);
    assertSame('999.00', (string) val('SELECT price FROM np_menu_products WHERE id=?', [$pKofte]), 'ana kayıt güncellenmedi');
    $r = $pullA($A, 0, $DEV1);
    assertSame(1, $r['version'], 'sürüm ilerledi');
    $kofte = null;
    foreach ($r['products'] as $p) if ($p['master_code'] === 'URN_KOFTE') $kofte = $p;
    assertSame('180.00', $kofte['price'], 'yayınlanmamış fiyat kasaya sızdı');
    assertSame('Köfte', $kofte['name'], 'yayınlanmamış isim kasaya sızdı');
});

check('aynı sürüm yeniden çekilince hiçbir satır gönderilmiyor', function () use ($pullA, $A, $DEV1) {
    $r = $pullA($A, 1, $DEV1);
    assertSame(1, $r['version'], 'sürüm');
    assertSame(false, $r['full'], 'güncel kasaya full gönderildi');
    assertSame(0, count($r['products']), 'ürün gönderildi');
    assertSame(0, count($r['categories']), 'kategori gönderildi');
    assertSame(0, count($r['withdrawn']), 'kaldırma gönderildi');
});

check('since=<n> yalnızca değişeni veriyor', function () use ($pullA, $A, $DEV1, $tidA) {
    $v = chain_publish($tidA, 'köfte zammı', 'test@panel');
    assertSame(2, $v, 'ikinci sürüm');
    $r = $pullA($A, 1, $DEV1);
    assertSame(2, $r['version'], 'sürüm');
    assertSame(false, $r['full'], 'artımlı çekiş full geldi');
    assertSame(1, count($r['products']), 'değişmeyen ürünler de gönderildi');
    assertSame('URN_KOFTE', $r['products'][0]['master_code'], 'yanlış ürün');
    assertSame('999.00', $r['products'][0]['price'], 'yeni fiyat gelmedi');
    assertSame(0, count($r['categories']), 'değişmeyen kategoriler gönderildi');
});

check('panelin artık tutmadığı bir sürüm full cevap üretiyor', function () use ($pullA, $A, $DEV1) {
    $r = $pullA($A, 99, $DEV1);
    assertSame(true, $r['full'], 'full bayrağı');
    assertSame(3, count($r['products']), 'ürün sayısı');
    assertSame(2, $r['version'], 'sürüm');
});

check('kaldırılan ürün withdrawn olarak bildiriliyor, satır silinmiyor', function () use ($pullA, $A, $DEV1, $tidA, $pPide) {
    q('UPDATE np_menu_products SET is_active=0 WHERE id=? AND tenant_id=?', [$pPide, $tidA]);
    $v = chain_publish($tidA, 'pide kaldırıldı', 'test@panel');
    assertSame(3, $v, 'üçüncü sürüm');
    $r = $pullA($A, 2, $DEV1);
    assertSame(['URN_PIDE'], $r['withdrawn'], 'kaldırılan ürün bildirilmedi');
    assertSame(0, count($r['products']), 'kaldırılan ürün ayrıca gönderildi');
    assertThat(one('SELECT id FROM np_menu_products WHERE id=?', [$pPide]) !== null, 'ana kayıt silindi');
});

check('sıfırdan çeken kasa da kaldırılmış ürünü öğreniyor', function () use ($pullA, $A, $DEV1) {
    $r = $pullA($A, 0, $DEV1);
    assertSame(true, $r['full'], 'full bayrağı');
    assertSame(2, count($r['products']), 'aktif ürün sayısı');
    assertSame(['URN_PIDE'], $r['withdrawn'], 'geçmişte kaldırılan ürün bildirilmedi');
});

/* ------------------------- 4. exceptions ------------------------- */
check('kilitli fiyat şubede değiştirilemiyor', function () use ($tidA, $branchMerkez) {
    $err = chain_save_override($tidA, $branchMerkez, 'product', 'URN_KOFTE', null, '150.00', 'test@panel');
    assertThat($err !== null, 'kilitli fiyat kabul edildi');
    assertThat(mb_strpos($err, 'kilitli') !== false, 'hata mesajı kilidi anlatmıyor: ' . $err);
    $n = (int) val('SELECT COUNT(*) FROM np_branch_overrides WHERE tenant_id=? AND master_code=?', [$tidA, 'URN_KOFTE']);
    assertSame(0, $n, 'reddedilen istisna yine de yazıldı');
});

check('yanlış türle verilen istisna reddediliyor', function () use ($tidA, $branchMerkez) {
    $err = chain_save_override($tidA, $branchMerkez, 'category', 'URN_KOFTE', 0, null, 'test@panel');
    assertThat($err !== null, 'ürün kodu kategori istisnası olarak kabul edildi');
    assertSame(0, (int) val('SELECT COUNT(*) FROM np_branch_overrides WHERE tenant_id=? AND entity=?', [$tidA, 'category']),
        'reddedilen istisna yine de yazıldı');
});

check('başka işletmenin ürün kodu istisna olarak kabul edilmiyor', function () use ($tidA, $tidB, $branchB) {
    $err = chain_save_override($tidB, $branchB, 'product', 'URN_CAY', 0, null, 'test@panel');
    assertThat($err !== null, 'A işletmesinin ürünü B şubesine istisna olarak yazıldı');
});

check('kilidi açık ürünün fiyatı şubede değiştirilebiliyor', function () use ($tidA, $branchMerkez) {
    $err = chain_save_override($tidA, $branchMerkez, 'product', 'URN_CAY', null, '25.00', 'test@panel');
    assertSame(null, $err, 'istisna reddedildi: ' . (string) $err);
    $row = one('SELECT * FROM np_branch_overrides WHERE tenant_id=? AND branch_id=? AND master_code=?',
               [$tidA, $branchMerkez, 'URN_CAY']);
    assertSame('25.00', $row['price'], 'şube fiyatı');
});

check('istisna yalnızca kendi şubesine gidiyor', function () use ($pullA, $A, $DEV1, $DEV2, $tidA, $branchKale) {
    chain_save_override($tidA, $branchKale, 'product', 'URN_KOFTE', 0, null, 'test@panel');
    $merkez = $pullA($A, 3, $DEV1);
    $kale   = $pullA($A, 3, $DEV2);
    $mc = array_column($merkez['overrides'], 'master_code');
    $kc = array_column($kale['overrides'], 'master_code');
    assertSame(['URN_CAY'], $mc, 'merkez yanlış istisna aldı');
    assertSame(['URN_KOFTE'], $kc, 'kaleiçi yanlış istisna aldı');
    assertSame(0, $kale['overrides'][0]['available'], 'satışta kapatma gitmedi');
    assertSame('25.00', $merkez['overrides'][0]['price'], 'şube fiyatı gitmedi');
});

check('kilit sonradan kapatılınca şube fiyatı kasaya gitmiyor', function () use ($pullA, $A, $DEV1, $tidA, $branchMerkez) {
    chain_save_override($tidA, $branchMerkez, 'product', 'URN_CAY', 1, '25.00', 'test@panel');
    q('UPDATE np_menu_products SET price_locked=1 WHERE tenant_id=? AND master_code=?', [$tidA, 'URN_CAY']);
    $r = $pullA($A, 3, $DEV1);
    $ov = null;
    foreach ($r['overrides'] as $o) if ($o['master_code'] === 'URN_CAY') $ov = $o;
    assertThat($ov !== null, 'satışta bilgisi de kayboldu');
    assertSame(null, $ov['price'], 'kilitli olmasına rağmen fiyat gönderildi');
    q('UPDATE np_menu_products SET price_locked=0 WHERE tenant_id=? AND master_code=?', [$tidA, 'URN_CAY']);
});

/* ------------------------- 5. ack ------------------------- */
check('ack şubenin uyguladığı sürümü kaydediyor', function () use ($PANEL, $A, $DEV1, $tidA, $branchMerkez) {
    $r = http_call('POST', $PANEL . '/api/desktop/menu-ack.php', [
        'client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $DEV1,
        'version' => 3, 'applied_at' => date('c'), 'counts' => ['inserted' => 2, 'updated' => 1, 'deactivated' => 1],
    ]);
    assertSame(true, $r['ok'], 'ack başarısız: ' . ($r['error'] ?? ''));
    assertSame($branchMerkez, (int) $r['branch_id'], 'ack yanlış şubeye yazıldı');
    $b = one('SELECT * FROM np_branches WHERE id=? AND tenant_id=?', [$branchMerkez, $tidA]);
    assertSame(3, (int) $b['menu_version'], 'kaydedilen sürüm');
    assertThat($b['menu_applied_at'] !== null, 'uygulama zamanı boş');
    assertSame('+2 ~1 -1', $b['menu_counts'], 'sayaçlar');
});

check('geç kalan ikinci kasanın acki şubeyi geriye almıyor', function () use ($PANEL, $A, $DEV1, $tidA, $branchMerkez) {
    http_call('POST', $PANEL . '/api/desktop/menu-ack.php', [
        'client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $DEV1, 'version' => 1,
    ]);
    assertSame(3, (int) val('SELECT menu_version FROM np_branches WHERE id=?', [$branchMerkez]), 'sürüm geriye alındı');
});

check('şubesi olmayan kasanın acki kabul ediliyor ama hiçbir şubeye yazılmıyor', function () use ($PANEL, $A) {
    $r = http_call('POST', $PANEL . '/api/desktop/menu-ack.php', [
        'client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => 'dev-chain-tek', 'version' => 3,
    ]);
    assertSame(true, $r['ok'], 'ack reddedildi');
    assertSame(false, $r['recorded'], 'şubesiz kasa bir şubeye yazıldı');
});

/* ------------------------- tenant isolation ------------------------- */
check('başka bir işletmenin menüsü hiçbir şekilde sızmıyor', function () use ($pullA, $A, $B, $tidB, $DEVB, $DEV1) {
    $cb = make_cat($tidB, 'KAT_YEMEK', 'B Yemekler', 1);   // aynı master_code, başka tenant
    make_prod($tidB, $cb, 'URN_KOFTE', 'B Köfte', 500.00);
    chain_publish($tidB, 'B menüsü', 'test@panel');

    $rb = $pullA($B, 0, $DEVB, 'TEK');
    $codesB = array_column($rb['products'], 'master_code');
    assertSame(['URN_KOFTE'], $codesB, 'B işletmesi A ürünlerini gördü');
    assertSame('500.00', $rb['products'][0]['price'], 'B kendi fiyatını almadı');
    assertSame('B Köfte', $rb['products'][0]['name'], 'B kendi adını almadı');

    $ra = $pullA($A, 0, $DEV1);
    foreach ($ra['products'] as $p) assertThat($p['name'] !== 'B Köfte', 'A işletmesi B ürününü gördü');
    assertSame(1, $rb['version'], 'B sürümü A ile karıştı');
});

check('başka bir işletmenin istisnaları hiçbir şekilde sızmıyor', function () use ($pullA, $B, $DEVB) {
    $r = $pullA($B, 0, $DEVB);
    assertSame(0, count($r['overrides']), 'B işletmesi A istisnalarını gördü');
    assertSame('TEK', $r['branch']['code'], 'B yanlış şubeye bağlandı');
});

check('bir işletmenin şubeleri diğerinin sorgusunda görünmüyor', function () use ($tidA, $tidB) {
    assertSame(2, chain_branch_count($tidA), 'A şube sayısı');
    assertSame(1, chain_branch_count($tidB), 'B şube sayısı');
    $x = one('SELECT id FROM np_branches WHERE tenant_id=? AND code=?', [$tidB, 'MERKEZ']);
    assertSame(null, $x, 'A şubesi B altında bulundu');
});

check('bir işletmenin şube koduyla diğerinin cihazı bağlanamıyor', function () use ($pullA, $B, $DEVB) {
    $r = $pullA($B, 0, $DEVB, 'MERKEZ');   // A'nın şube kodu
    assertSame('TEK', $r['branch']['code'] ?? null, 'başka işletmenin şubesine bağlandı');
});

check('yanlış lisans anahtarı reddediliyor', function () use ($PANEL, $A, $B, $DEV1) {
    $r = http_call('POST', $PANEL . '/api/desktop/menu.php',
        ['client_id' => $A['id'], 'licence_key' => $B['key'], 'device_id' => $DEV1, 'since' => 0]);
    assertSame(401, $r['status'], 'başka işletmenin anahtarı kabul edildi');
    assertThat(empty($r['products']), 'reddedilen istekte menü döndü');
});

check('lisans anahtarı URL üzerinden kabul edilmiyor', function () use ($PANEL, $A) {
    $r = http_call('GET', $PANEL . '/api/desktop/menu.php?since=0&client_id=' . $A['id']
        . '&licence_key=' . urlencode($A['key']));
    assertSame(401, $r['status'], 'anahtar URL üzerinden kabul edildi');
});

check('GET ?since= ve başlıkla kimlik doğrulama çalışıyor', function () use ($PANEL, $A, $DEV1) {
    $r = http_call('GET', $PANEL . '/api/desktop/menu.php?since=2', [],
        ['X-Client-Id: ' . $A['id'], 'X-Licence-Key: ' . $A['key'], 'X-Device-Id: ' . $DEV1]);
    assertSame(200, $r['status'], 'GET reddedildi');
    assertSame(3, $r['version'], 'sürüm');
    assertSame(2, $r['since'], 'since yankılanmadı');
    assertSame(false, $r['full'], 'artımlı olması gerekirken full geldi');
});

/* ------------------------- teardown ------------------------- */
drop_tenant('zincir-a@ornek.test');
drop_tenant('zincir-b@ornek.test');

echo "\n$pass/$total checks passed\n";
if ($failures) {
    foreach ($failures as $f) echo "  ! $f\n";
    exit(1);
}
exit(0);
