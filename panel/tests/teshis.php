<?php
/**
 * NOKTApp POS - kasa teşhis, panel tarafı.
 *
 * Everything runs against the real MariaDB and the real HTTP endpoints, in the
 * order it happens in life: a till checks its licence, hangs a health document
 * on the heartbeat, does it again an hour later, and somebody opens the screen
 * during a support call. Nothing is mocked - the failures this exists to catch
 * (one customer's till showing under another customer's name, a history that
 * grows for ever, a silent till reading as healthy, a guest's e-mail address
 * arriving in a "health" document) are exactly the kind a mock hides.
 *
 * Two throwaway tenants are created and destroyed by the run.
 *
 * Run:  php panel/tests/teshis.php
 * Env:  NP_DB_PORT (3399) NP_DB_USER (noktapp) NP_DB_PASS (nokpass)
 *       NP_DB_NAME (nokpos_panel)  PANEL (http://127.0.0.1:8090)
 *       PANEL_ADMIN / PANEL_ADMIN_PASS for the two screen checks
 */
foreach ([
    'NP_DB_HOST' => '127.0.0.1', 'NP_DB_PORT' => '3399', 'NP_DB_NAME' => 'nokpos_panel',
    'NP_DB_USER' => 'noktapp',   'NP_DB_PASS' => 'nokpass',
] as $k => $v) { if (getenv($k) === false) putenv("$k=$v"); }

require_once __DIR__ . '/../lib/teshis.php';

$PANEL = getenv('PANEL') ?: 'http://127.0.0.1:8090';
$ADMIN = getenv('PANEL_ADMIN') ?: 'erik@noktapp.com';
$APASS = getenv('PANEL_ADMIN_PASS') ?: 'ChainTest123';

$pass = 0; $total = 0; $failures = [];

function check(string $name, callable $fn): void {
    global $pass, $total, $failures;
    $total++;
    try { $fn(); $pass++; echo "  PASS  $name\n"; }
    catch (Throwable $e) {
        $failures[] = $name . ' -> ' . $e->getMessage();
        echo "  FAIL  $name  -> " . $e->getMessage() . "\n";
    }
}
function assertThat($cond, string $msg): void { if (!$cond) throw new RuntimeException($msg); }
function assertSame2($a, $b, string $msg): void {
    if ($a !== $b) throw new RuntimeException($msg . ' (beklenen ' . var_export($a, true) . ', gelen ' . var_export($b, true) . ')');
}

/** POST JSON against the panel exactly as a till would. */
function api(string $url, array $body): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_UNICODE),
        CURLOPT_TIMEOUT => 30,
    ]);
    $raw = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($raw === false) throw new RuntimeException('panel yanit vermedi');
    $j = json_decode($raw, true);
    if (!is_array($j)) throw new RuntimeException('gecersiz JSON (' . $status . '): ' . substr($raw, 0, 200));
    return ['status' => $status] + $j;
}

/** A browser: log in once, keep the cookie, fetch pages. */
function browser_login(string $panel, string $email, string $pass): string {
    $jar = tempnam(sys_get_temp_dir(), 'nokjar');
    $ch = curl_init($panel . '/admin/index.php?p=login');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query(['email' => $email, 'password' => $pass]),
        CURLOPT_COOKIEJAR => $jar, CURLOPT_COOKIEFILE => $jar,
        CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 30,
    ]);
    curl_exec($ch);
    curl_close($ch);
    return $jar;
}
function browser_get(string $url, ?string $jar): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_HEADER => true, CURLOPT_TIMEOUT => 30,
    ]);
    if ($jar) { curl_setopt($ch, CURLOPT_COOKIEFILE, $jar); curl_setopt($ch, CURLOPT_COOKIEJAR, $jar); }
    $raw = (string) curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hlen = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);
    return ['status' => $status, 'headers' => substr($raw, 0, $hlen), 'body' => substr($raw, $hlen)];
}

/* ------------------------- fixture ------------------------- */
function drop_tenant_t(string $email): void {
    $t = one('SELECT id FROM np_tenants WHERE email=?', [$email]);
    if (!$t) return;
    $id = (int) $t['id'];
    foreach (['np_diagnostics', 'np_diagnostics_log', 'np_devices', 'np_licences',
              'np_reports', 'np_backups', 'np_alert_sent'] as $tab) {
        try { q("DELETE FROM {$tab} WHERE tenant_id=?", [$id]); } catch (Throwable $e) {}
    }
    q('DELETE FROM np_tenants WHERE id=?', [$id]);
}
function make_tenant_t(string $code, string $name, string $email): array {
    drop_tenant_t($email);
    q('INSERT INTO np_tenants (code, company_name, owner_name, email, password_hash, is_active)
       VALUES (?,?,?,?,?,1)', [$code, $name, 'Test', $email, password_hash('x', PASSWORD_BCRYPT)]);
    $id = lastId();
    $key = strtoupper(bin2hex(random_bytes(12)));
    q("INSERT INTO np_licences (tenant_id, licence_key, plan, status, seats, starts_at, expires_at, grace_days)
       VALUES (?,?,'standart','active',9,CURDATE(), DATE_ADD(NOW(), INTERVAL 365 DAY), 7)", [$id, $key]);
    return ['id' => $id, 'key' => $key];
}

/** A believable health document, with whatever the caller wants changed. */
function doc(array $over = []): array {
    return array_merge([
        'at' => date('c'),
        'app_version' => '2.1.1',
        'engine' => '10.11.6-MariaDB',
        'os' => 'Windows_NT 10.0.19045 x64',
        'node' => '22.0.0',
        'uptime_h' => 51,
        'disk_free_mb' => 41231,
        'disk_total_mb' => 476000,
        'db_size_mb' => 318,
        'stations' => 3,
        'print_pending' => 0,
        'print_failed' => 0,
        'open_bills' => 4,
        'last_close' => date('Y-m-d', strtotime('-1 day')),
        'last_close_seq' => 1,
        'okc' => 1,
        'okc_provider' => 'hugin',
        'okc_status' => 'READY',
        'okc_devices' => 1,
        'errors_24h' => 2,
        'backup_at' => date('c', strtotime('-8 hours')),
        'backup_mb' => 96,
        'printers' => [
            ['name' => 'Kasa Yazıcı', 'type' => 'thermal', 'target' => '192.168.1.50',
             'station' => 'Kasa', 'last' => 'done', 'last_at' => date('Y-m-d H:i:s')],
            ['name' => 'Mutfak Yazıcı', 'type' => 'thermal', 'target' => '192.168.1.51',
             'station' => 'Mutfak', 'last' => 'failed', 'last_at' => date('Y-m-d H:i:s')],
        ],
        'log' => ['2026-09-08 11:02:11 print Yazici cevap vermiyor: 192.168.1.51:9100'],
    ], $over);
}

echo "\nNOKTApp POS - kasa teşhis (panel tarafı)\n\n";

if (!teshis_ready()) {
    echo "  ! np_diagnostics yok - once sql/teshis_schema.sql uygulanmali\n";
    echo "\n0/1 checks passed\n";
    exit(1);
}

$A = make_tenant_t('TTESTA', 'Teşhis Test A', 'teshis-a@ornek.test');
$B = make_tenant_t('TTESTB', 'Teşhis Test B', 'teshis-b@ornek.test');
$DEV = 'dev-teshis-1';          // deliberately the SAME string at both tenants
$DEV2 = 'dev-teshis-2';

$beat = function (array $t, string $device, ?array $d, array $extra = []) use ($PANEL) {
    $body = ['client_id' => $t['id'], 'licence_key' => $t['key'], 'device_id' => $device,
             'device_name' => 'Kasa ' . $device, 'app_version' => '2.1.1'] + $extra;
    if ($d !== null) $body['diag'] = $d;
    return api($PANEL . '/api/desktop/heartbeat.php', $body);
};

/* =================== 1. STORING =================== */

check('teşhis belgesi olmayan heartbeat eskisi gibi çalışıyor', function () use ($beat, $A, $DEV) {
    $r = $beat($A, $DEV, null);
    assertSame2(200, $r['status'], 'heartbeat reddedildi');
    assertThat(!empty($r['ok']), 'ok gelmedi');
    /* The response shape is the licence lifeline for every installed till and
       must not have changed by one field. */
    assertThat(isset($r['licence']['key'], $r['licence']['status'], $r['licence']['expires_at'],
                     $r['licence']['grace_days'], $r['server_time']),
        'heartbeat cevabının şekli değişmiş: ' . json_encode(array_keys($r)));
});

check('teşhis belgesi gönderilince saklanıyor', function () use ($beat, $A, $DEV) {
    $r = $beat($A, $DEV, doc());
    assertSame2(200, $r['status'], 'heartbeat reddedildi');
    $g = teshis_one($A['id'], $DEV);
    assertThat($g !== null, 'kasa bulunamadı');
    assertThat(!empty($g['received_at']), 'belge saklanmadı');
    assertSame2('10.11.6-MariaDB', $g['engine_version'], 'motor sürümü');
    assertSame2(41231, (int) $g['disk_free_mb'], 'boş disk');
    assertSame2(318, (int) $g['db_size_mb'], 'veritabanı boyutu');
    assertSame2(4, (int) $g['open_bills'], 'açık adisyon');
    assertSame2(2, (int) $g['printers'], 'yazıcı sayısı');
    assertSame2(1, (int) $g['printers_bad'], 'hatalı yazıcı sayısı');
    assertSame2(1, (int) $g['okc'], 'ÖKC');
    assertSame2(2, count($g['doc']['printers']), 'yazıcı listesi');
});

check('belge doğru kasaya yazılıyor, ikinci gönderim üzerine yazıyor', function () use ($beat, $A, $DEV) {
    $beat($A, $DEV, doc(['disk_free_mb' => 900, 'app_version' => '2.1.2']));
    $g = teshis_one($A['id'], $DEV);
    assertSame2(900, (int) $g['disk_free_mb'], 'güncel belge yazılmadı');
    assertSame2('2.1.2', $g['doc']['app_version'], 'belgedeki sürüm güncellenmedi');
    assertSame2('2.1.2', (string) val('SELECT app_version FROM np_diagnostics
                                        WHERE tenant_id=? AND device_id=?', [$A['id'], $DEV]),
        'sütundaki sürüm güncellenmedi');
    $n = (int) val('SELECT COUNT(*) FROM np_diagnostics WHERE tenant_id=? AND device_id=?', [$A['id'], $DEV]);
    assertSame2(1, $n, 'kasa başına bir satır olmalı');
});

/* =================== 2. TENANT SCOPING =================== */

check('aynı kasa kimliği başka işletmede ayrı bir kasadır', function () use ($beat, $A, $B, $DEV) {
    $beat($B, $DEV, doc(['disk_free_mb' => 111, 'os' => 'Windows_NT 6.1.7601 x64']));
    $a = teshis_one($A['id'], $DEV);
    $b = teshis_one($B['id'], $DEV);
    assertSame2(900, (int) $a['disk_free_mb'], "B'nin belgesi A'nın üstüne yazıldı");
    assertSame2(111, (int) $b['disk_free_mb'], "B'nin belgesi kaydedilmedi");
    assertSame2('Teşhis Test A', $a['company_name'], 'A yanlış işletmeye bağlı');
    assertSame2('Teşhis Test B', $b['company_name'], 'B yanlış işletmeye bağlı');
});

check('bir işletmenin listesinde diğerinin kasası görünmüyor', function () use ($A, $B, $DEV) {
    $la = teshis_list($A['id']);
    $lb = teshis_list($B['id']);
    foreach ($la as $r) assertSame2($A['id'], (int) $r['tenant_id'], "A listesinde başka işletmenin kasası");
    foreach ($lb as $r) assertSame2($B['id'], (int) $r['tenant_id'], "B listesinde başka işletmenin kasası");
    assertThat(count($la) >= 1 && count($lb) >= 1, 'listeler boş');
});

check('başka işletmenin kasa kimliği o işletmenin belgesini getirmiyor', function () use ($A, $B, $DEV) {
    $h = teshis_history($B['id'], $DEV);
    foreach ($h as $row) {
        assertThat(($row['doc']['os'] ?? '') !== 'Windows_NT 10.0.19045 x64'
                   || ($row['doc']['disk_free_mb'] ?? 0) !== 41231,
            "A'nın belgesi B'nin geçmişinde");
    }
    assertThat(teshis_one($A['id'], 'olmayan-kasa') === null, 'olmayan kasa için satır döndü');
});

check('yanlış lisans anahtarıyla belge yazılamıyor', function () use ($PANEL, $A, $B, $DEV2) {
    $r = api($PANEL . '/api/desktop/heartbeat.php',
        ['client_id' => $A['id'], 'licence_key' => $B['key'], 'device_id' => $DEV2,
         'diag' => doc(['disk_free_mb' => 7])]);
    assertSame2(401, $r['status'], 'başka işletmenin anahtarı kabul edildi');
    assertThat(teshis_one($A['id'], $DEV2) === null, 'reddedilen istekte belge yazıldı');
});

/* =================== 3. HISTORY =================== */

check('geçmiş tutuluyor', function () use ($beat, $A, $DEV) {
    $before = count(teshis_history($A['id'], $DEV));
    $beat($A, $DEV, doc(['disk_free_mb' => 5000]));
    $beat($A, $DEV, doc(['disk_free_mb' => 4000]));
    $after = teshis_history($A['id'], $DEV);
    assertSame2($before + 2, count($after), 'geçmişe yazılmadı');
    assertSame2(4000, (int) $after[0]['doc']['disk_free_mb'], 'en yeni belge başta değil');
});

check('geçmiş NP_DIAG_KEEP kadar kırpılıyor', function () use ($beat, $A, $DEV) {
    for ($i = 0; $i < NP_DIAG_KEEP + 6; $i++) $beat($A, $DEV, doc(['disk_free_mb' => 1000 + $i]));
    $n = (int) val('SELECT COUNT(*) FROM np_diagnostics_log WHERE tenant_id=? AND device_id=?',
                   [$A['id'], $DEV]);
    assertSame2(NP_DIAG_KEEP, $n, 'geçmiş kırpılmadı');
    $h = teshis_history($A['id'], $DEV);
    assertSame2(1000 + NP_DIAG_KEEP + 5, (int) $h[0]['doc']['disk_free_mb'], 'en yenisi silinmiş');
});

check('kırpma bir kasanın geçmişini diğerine dokunmadan yapıyor', function () use ($B, $DEV) {
    $n = (int) val('SELECT COUNT(*) FROM np_diagnostics_log WHERE tenant_id=? AND device_id=?',
                   [$B['id'], $DEV]);
    assertSame2(1, $n, "A'nın kırpması B'nin geçmişini de sildi");
});

/* =================== 4. UNKNOWN IS NOT HEALTHY =================== */

check('hiç belge göndermemiş kasa "bilinmiyor" okunuyor, "sorunsuz" değil', function () use ($beat, $A) {
    $beat($A, 'dev-teshis-sessiz', null);      // heartbeat only, no document
    $g = teshis_one($A['id'], 'dev-teshis-sessiz');
    assertThat($g !== null, 'kasa kaydolmadı');
    assertSame2(null, $g['received_at'], 'belge yokken received_at dolu');
    assertSame2('unknown', $g['health'][0], 'sessiz kasa ' . $g['health'][0] . ' okundu');
    assertThat($g['health'][1] !== 'sorunsuz görünmüyor', 'sessiz kasa sağlıklı sayıldı');
    assertThat(mb_strpos($g['health'][2], 'göndermedi') !== false,
        'neden açıklanmamış: ' . $g['health'][2]);
});

check('eski belge "eski bilgi" okunuyor', function () use ($A, $DEV) {
    q('UPDATE np_diagnostics SET received_at = DATE_SUB(NOW(), INTERVAL 5 DAY)
        WHERE tenant_id=? AND device_id=?', [$A['id'], $DEV]);
    $g = teshis_one($A['id'], $DEV);
    assertSame2('stale', $g['health'][0], 'eski belge ' . $g['health'][0] . ' okundu');
});

check('yazıcısı hata veren kasa "ilgi bekliyor" okunuyor', function () use ($beat, $A, $DEV) {
    $beat($A, $DEV, doc());
    $g = teshis_one($A['id'], $DEV);
    assertSame2('bad', $g['health'][0], 'hatalı yazıcıya rağmen ' . $g['health'][0]);
    assertThat(mb_strpos($g['health'][2], 'yazıcı') !== false, 'neden yazıcıyı söylemiyor');
});

check('sorunsuz kasa "ok" okunuyor', function () use ($beat, $A, $DEV2) {
    $beat($A, $DEV2, doc(['printers' => [
        ['name' => 'Tek Yazıcı', 'type' => 'thermal', 'target' => '192.168.1.9',
         'station' => 'Kasa', 'last' => 'done', 'last_at' => date('Y-m-d H:i:s')]],
        'last_close' => date('Y-m-d')]));
    $g = teshis_one($A['id'], $DEV2);
    assertSame2('ok', $g['health'][0], 'sağlıklı kasa ' . $g['health'][0] . ' okundu');
});

/* =================== 5. NOTHING PERSONAL SURVIVES =================== */

check('kasa yine de kişisel veri gönderirse panel temizliyor', function () use ($beat, $A, $DEV2) {
    /* An older till, or a tampered one. The panel is the second of two locks
       and must not depend on the field being up to date. */
    $beat($A, $DEV2, doc(['log' => [
        'siparis maili gonderilemedi: aysegul.karadeniz@ornek.com',
        'sadakat sorgusu: 05321234567 tckn 12345678901',
        'iade reddedildi TR33 0006 1005 1978 6457 8413 26',
    ]]));
    $g = teshis_one($A['id'], $DEV2);
    $json = json_encode($g['doc'], JSON_UNESCAPED_UNICODE);
    assertThat(mb_strpos($json, 'aysegul.karadeniz@ornek.com') === false, 'e-posta adresi saklandı');
    assertThat(mb_strpos($json, '05321234567') === false, 'telefon numarası saklandı');
    assertThat(mb_strpos($json, '12345678901') === false, 'kimlik numarası saklandı');
    assertThat(mb_strpos($json, '6457 8413 26') === false, 'IBAN saklandı');
    assertThat(mb_strpos($json, '[e-posta]') !== false, 'satır silinmiş, işaretlenmemiş');
});

check('temizlik günlük satırının tarihini yemiyor', function () use ($beat, $A, $DEV2) {
    /* A date is ten digits and identifies nobody. An over-eager number rule
       turns every line into "[numara]:22:17" and the support screen loses the
       only field that says when the error happened. */
    $stamp = date('Y-m-d H:i:s');
    $beat($A, $DEV2, doc(['log' => [$stamp . ' print Yazici cevap vermiyor: 192.168.1.51:9100']]));
    $g = teshis_one($A['id'], $DEV2);
    $line = $g['doc']['log'][0] ?? '';
    assertThat(mb_strpos($line, substr($stamp, 0, 10)) === 0, 'tarih silinmiş: ' . $line);
    assertThat(mb_strpos($line, '192.168.1.51') !== false, 'yazıcı adresi silinmiş: ' . $line);
});

check('belgede istenmeyen alanlar hiç saklanmıyor', function () use ($beat, $A, $DEV2) {
    $beat($A, $DEV2, doc([
        'customers' => [['name' => 'Ayşegül Karadeniz', 'phone' => '05321234567']],
        'orders' => [['id' => 4, 'total' => 480.0, 'items' => ['Adana', 'Ayran']]],
        'sifre' => 'gizli-sey',
    ]));
    $g = teshis_one($A['id'], $DEV2);
    $json = json_encode($g['doc'], JSON_UNESCAPED_UNICODE);
    assertThat(mb_strpos($json, 'Karadeniz') === false, 'müşteri adı saklandı');
    assertThat(mb_strpos($json, 'Adana') === false, 'adisyon içeriği saklandı');
    assertThat(mb_strpos($json, 'gizli-sey') === false, 'beyaz listede olmayan alan saklandı');
    assertThat(!isset($g['doc']['customers']) && !isset($g['doc']['orders']),
        'beyaz liste dışı anahtarlar geçti: ' . implode(',', array_keys($g['doc'])));
});

check('devasa bir belge kırpılıyor', function () use ($beat, $A, $DEV2) {
    $lines = [];
    for ($i = 0; $i < 400; $i++) $lines[] = str_repeat('X', 900) . ' satir ' . $i;
    $printers = [];
    for ($i = 0; $i < 300; $i++) {
        $printers[] = ['name' => str_repeat('Y', 400) . $i, 'type' => str_repeat('t', 300),
                       'target' => str_repeat('9', 200), 'station' => str_repeat('s', 300),
                       'last' => 'done', 'last_at' => date('Y-m-d H:i:s')];
    }
    $beat($A, $DEV2, doc(['log' => $lines, 'printers' => $printers]));
    $g = teshis_one($A['id'], $DEV2);
    assertThat(count($g['doc']['log']) <= NP_DIAG_LINES,
        'günlük satırı sınırlanmadı: ' . count($g['doc']['log']));
    assertThat(count($g['doc']['printers']) <= NP_DIAG_PRINTERS,
        'yazıcı listesi sınırlanmadı: ' . count($g['doc']['printers']));
    $bytes = strlen((string) val('SELECT payload FROM np_diagnostics WHERE tenant_id=? AND device_id=?',
                                 [$A['id'], $DEV2]));
    assertThat($bytes < 20000, 'saklanan belge ' . $bytes . ' bayt');
});

check('çöp bir belge kayıt yazmıyor ve heartbeat’i bozmuyor', function () use ($PANEL, $A, $DEV2) {
    $r = api($PANEL . '/api/desktop/heartbeat.php',
        ['client_id' => $A['id'], 'licence_key' => $A['key'], 'device_id' => $DEV2,
         'diag' => ['sadece' => 'sacma']]);
    assertSame2(200, $r['status'], 'çöp belge heartbeat’i düşürdü');
    assertThat(!empty($r['ok']), 'heartbeat ok dönmedi');
});

/* =================== 6. THE SCREEN =================== */

check('teşhis ekranı yönetici için açılıyor', function () use ($PANEL, $ADMIN, $APASS, $A, $DEV) {
    $jar = browser_login($PANEL, $ADMIN, $APASS);
    $r = browser_get($PANEL . '/admin/index.php?p=teshis', $jar);
    assertSame2(200, $r['status'], 'liste açılmadı');
    assertThat(mb_strpos($r['body'], 'Kasa teşhis') !== false, 'başlık yok');
    assertThat(mb_strpos($r['body'], 'Sayfa bulunamadı') === false, '404 ekranı geldi');
    assertThat(mb_strpos($r['body'], 'hazırlanıyor') === false
               && mb_strpos($r['body'], 'Hazırlanıyor') === false, 'hâlâ placeholder');
    assertThat(mb_strpos($r['body'], 'Teşhis Test A') !== false, 'kasalar listelenmiyor');

    $d = browser_get($PANEL . '/admin/index.php?p=teshis&tenant=' . $A['id']
                     . '&device=' . rawurlencode($DEV), $jar);
    assertSame2(200, $d['status'], 'kasa sayfası açılmadı');
    assertThat(mb_strpos($d['body'], 'Teşhis Test A') !== false, 'işletme adı yok');
    assertThat(mb_strpos($d['body'], '10.11.6-MariaDB') !== false, 'motor sürümü ekranda yok');
    assertThat(mb_strpos($d['body'], 'Mutfak Yazıcı') !== false, 'yazıcı listesi ekranda yok');
    assertThat(mb_strpos($d['body'], 'Geçmiş') !== false, 'geçmiş bölümü yok');
    assertThat(mb_strpos($d['body'], 'Fatal error') === false
               && mb_strpos($d['body'], 'Panel bir hata') === false, 'PHP hatası');
    @unlink($jar);
});

check('teşhis ekranı oturumsuz ziyaretçiyi girişe yolluyor', function () use ($PANEL, $A, $DEV) {
    foreach (['?p=teshis', '?p=teshis&tenant=' . $A['id'] . '&device=' . rawurlencode($DEV)] as $qs) {
        $r = browser_get($PANEL . '/admin/index.php' . $qs, null);
        assertThat($r['status'] === 302 || $r['status'] === 301,
            $qs . ' için ' . $r['status'] . ' döndü, yönlendirme bekleniyordu');
        assertThat(stripos($r['headers'], 'Location:') !== false
                   && stripos($r['headers'], 'p=login') !== false,
            $qs . ' girişe yönlendirmiyor');
        assertThat(mb_strpos($r['body'], 'Teşhis Test A') === false,
            $qs . ' oturumsuz ziyaretçiye müşteri adı gösterdi');
    }
});

check('müşteri sayfasından teşhise bağlantı var', function () use ($PANEL, $ADMIN, $APASS, $A) {
    $jar = browser_login($PANEL, $ADMIN, $APASS);
    $r = browser_get($PANEL . '/admin/index.php?p=tenant&id=' . $A['id'], $jar);
    assertSame2(200, $r['status'], 'işletme sayfası açılmadı');
    assertThat(mb_strpos($r['body'], 'p=teshis&tenant=' . $A['id']) !== false,
        'işletme sayfasında teşhis bağlantısı yok');
    @unlink($jar);
});

/* ------------------------- teardown ------------------------- */
drop_tenant_t('teshis-a@ornek.test');
drop_tenant_t('teshis-b@ornek.test');

echo "\n$pass/$total checks passed\n";
if ($failures) {
    foreach ($failures as $f) echo "  ! $f\n";
    exit(1);
}
exit(0);
