<?php
/**
 * NOKTApp POS - uyarılar (alerts).
 *
 * The whole feature is a judgement about WHEN to speak, so that is what this
 * suite measures. Four customers are built, each in exactly one kind of
 * trouble, plus one in none at all, and then:
 *
 *   - every rule has to fire for its own customer and stay silent about the
 *     other four (a rule that warns about everybody is noise, and noise gets
 *     switched off);
 *   - the same alert must never go out twice, however often the cron runs;
 *   - and a condition that clears and comes BACK has to alert again, which is
 *     the half of de-duplication that a naive "have I told him about this
 *     customer" check gets wrong - it goes quiet for ever after the first
 *     time and the second outage is never reported.
 *
 * Then the door: the cron endpoint has to refuse a missing key, a wrong key,
 * and a correct key carried in the URL, where it would have been written into
 * the access log, the cron listing and the browser history on its way in.
 *
 * Nothing is mocked except the mail transport itself ($GLOBALS['np_mailer']),
 * which exists precisely so that "was this sent twice" is a question with a
 * countable answer.
 *
 * Run:  php panel/tests/uyari.php
 * Env:  NP_DB_PORT (3399) NP_DB_USER (noktapp) NP_DB_PASS (nokpass)
 *       NP_DB_NAME (nokpos_panel)  PANEL (http://127.0.0.1:8090)
 */
foreach ([
    'NP_DB_HOST' => '127.0.0.1', 'NP_DB_PORT' => '3399', 'NP_DB_NAME' => 'nokpos_panel',
    'NP_DB_USER' => 'noktapp',   'NP_DB_PASS' => 'nokpass',
] as $k => $v) { if (getenv($k) === false) putenv("$k=$v"); }

require_once __DIR__ . '/../lib/uyari.php';

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

/** A GET with whatever headers, without following redirects. */
function http_get(string $url, array $headers = [], ?string $jar = null): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true,
        CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 60,
        CURLOPT_HTTPHEADER => $headers,
    ]);
    if ($jar) { curl_setopt($ch, CURLOPT_COOKIEFILE, $jar); curl_setopt($ch, CURLOPT_COOKIEJAR, $jar); }
    $raw = (string) curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hlen = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);
    $body = substr($raw, $hlen);
    return ['status' => $status, 'headers' => substr($raw, 0, $hlen), 'body' => $body,
            'json' => json_decode($body, true)];
}
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

/* ------------------------- fixture ------------------------- */
function drop_tenant_u(string $email): void {
    $t = one('SELECT id FROM np_tenants WHERE email=?', [$email]);
    if (!$t) return;
    $id = (int) $t['id'];
    foreach (['np_alert_sent', 'np_diagnostics', 'np_diagnostics_log', 'np_devices',
              'np_licences', 'np_reports', 'np_backups'] as $tab) {
        try { q("DELETE FROM {$tab} WHERE tenant_id=?", [$id]); } catch (Throwable $e) {}
    }
    q('DELETE FROM np_tenants WHERE id=?', [$id]);
}

/**
 * One customer, in exactly one kind of trouble.
 *
 * $o: expires (days from now), seen (days ago or null for no till),
 *     backup (days ago or null), dayend (days ago or null)
 */
function make_u(string $code, string $name, string $email, array $o): int {
    drop_tenant_u($email);
    q('INSERT INTO np_tenants (code, company_name, owner_name, email, password_hash, is_active)
       VALUES (?,?,?,?,?,1)', [$code, $name, 'Test', $email, password_hash('x', PASSWORD_BCRYPT)]);
    $id = lastId();
    q("INSERT INTO np_licences (tenant_id, licence_key, plan, status, seats, starts_at, expires_at, grace_days)
       VALUES (?,?,'standart','active',3,CURDATE(), DATE_ADD(NOW(), INTERVAL ? DAY), 7)",
      [$id, strtoupper(bin2hex(random_bytes(12))), (int) $o['expires']]);
    if ($o['seen'] !== null) {
        q('INSERT INTO np_devices (tenant_id, device_id, device_name, app_version, last_seen_at)
           VALUES (?,?,?,?, DATE_SUB(NOW(), INTERVAL ? DAY))',
          [$id, 'dev-' . strtolower($code), 'Kasa', '2.1.1', (int) $o['seen']]);
    }
    if ($o['backup'] !== null) {
        q('INSERT INTO np_backups (tenant_id, device_id, filename, path, size_bytes, created_at)
           VALUES (?,?,?,?,?, DATE_SUB(NOW(), INTERVAL ? DAY))',
          [$id, 'dev-' . strtolower($code), 'yedek.sql.gz', '/tmp/yedek.sql.gz', 1024, (int) $o['backup']]);
    }
    if ($o['dayend'] !== null) {
        q("INSERT INTO np_reports (tenant_id, entity, entity_id, payload, created_at)
           VALUES (?, 'daily_closing', ?, '{}', DATE_SUB(NOW(), INTERVAL ? DAY))",
          [$id, $id . ':' . date('Y-m-d', strtotime('-' . (int) $o['dayend'] . ' days')) . ':1', (int) $o['dayend']]);
    }
    return $id;
}

/* The captured outbox. Every uyari_run() below writes here instead of the wire. */
$OUT = [];
$GLOBALS['np_mailer'] = function ($to, $subject, $body) use (&$OUT) {
    $OUT[] = ['to' => $to, 'subject' => $subject, 'body' => $body];
    return true;
};
/** How many captured mails are about this customer. */
function about(array $out, int $tenantId): int {
    $n = 0;
    foreach ($out as $m) if (strpos($m['body'], 'p=tenant&id=' . $tenantId) !== false) $n++;
    return $n;
}

echo "\nNOKTApp POS - uyarılar\n\n";

if (!uyari_ready()) {
    echo "  ! np_alert_rules yok - once sql/uyari_schema.sql uygulanmali\n";
    echo "\n0/1 checks passed\n";
    exit(1);
}

/*  expires  seen  backup  dayend                         which rule should fire  */
$T_OK     = make_u('UOK',  'Uyarı Sağlam',  'uyari-ok@ornek.test',
                   ['expires' => 200, 'seen' => 0, 'backup' => 0, 'dayend' => 0]);        // none
$T_EXP    = make_u('UEXP', 'Uyarı Lisans',  'uyari-exp@ornek.test',
                   ['expires' => 3,   'seen' => 0, 'backup' => 0, 'dayend' => 0]);        // licence_expiring
$T_SIL    = make_u('USIL', 'Uyarı Sessiz',  'uyari-sil@ornek.test',
                   ['expires' => 200, 'seen' => 9, 'backup' => 0, 'dayend' => 0]);        // till_silent
$T_BAK    = make_u('UBAK', 'Uyarı Yedeksiz','uyari-bak@ornek.test',
                   ['expires' => 200, 'seen' => 0, 'backup' => null, 'dayend' => 0]);     // backup_missing
$T_DAY    = make_u('UDAY', 'Uyarı Günsüz',  'uyari-day@ornek.test',
                   ['expires' => 200, 'seen' => 0, 'backup' => 0, 'dayend' => 30]);       // day_not_closed
/* No till at all. Nothing about a backup or a day-end can be expected of a
   customer who has not installed the program, and warning about them weekly is
   how an owner learns to ignore the whole feature. */
$T_NEW    = make_u('UNEW', 'Uyarı Kurulmamış', 'uyari-new@ornek.test',
                   ['expires' => 200, 'seen' => null, 'backup' => null, 'dayend' => null]);

$MINE = [$T_OK, $T_EXP, $T_SIL, $T_BAK, $T_DAY, $T_NEW];

/** The candidates of one rule kind, as a set of tenant ids. */
function ids_for(string $kind): array {
    $r = one('SELECT * FROM np_alert_rules WHERE kind=? ORDER BY id LIMIT 1', [$kind]);
    if (!$r) throw new RuntimeException($kind . ' kuralı yok');
    return array_map(fn($c) => (int) $c['tenant_id'], uyari_candidates($r));
}

/* =================== 1. EACH RULE FIRES, AND ONLY IT =================== */

check('lisans bitiyor kuralı yalnızca süresi dolmak üzere olanı buluyor',
    function () use ($T_EXP, $T_OK, $T_SIL, $T_BAK, $T_DAY, $T_NEW) {
        $ids = ids_for('licence_expiring');
        assertThat(in_array($T_EXP, $ids, true), '3 gün kalan lisans bulunamadı');
        foreach ([$T_OK, $T_SIL, $T_BAK, $T_DAY, $T_NEW] as $x) {
            assertThat(!in_array($x, $ids, true), '200 gün kalan lisans için uyarı üretildi');
        }
    });

check('süresi çoktan geçmiş lisans için "bitiyor" uyarısı üretilmiyor',
    function () use ($T_OK) {
        /* Expiry is a warning about the future. Once it HAS expired the licence
           is dead and the panel says so everywhere else; a "bitiyor" mail the
           week after is a mail about something that already happened. */
        q('UPDATE np_licences SET expires_at = DATE_SUB(NOW(), INTERVAL 4 DAY) WHERE tenant_id=?', [$T_OK]);
        $ids = ids_for('licence_expiring');
        assertThat(!in_array($T_OK, $ids, true), 'geçmiş tarih için uyarı üretildi');
        q('UPDATE np_licences SET expires_at = DATE_ADD(NOW(), INTERVAL 200 DAY) WHERE tenant_id=?', [$T_OK]);
    });

check('kasa sessiz kuralı yalnızca susan kasayı buluyor',
    function () use ($T_SIL, $T_OK, $T_EXP, $T_NEW) {
        $ids = ids_for('till_silent');
        assertThat(in_array($T_SIL, $ids, true), '9 gündür susan kasa bulunamadı');
        assertThat(!in_array($T_OK, $ids, true), 'bugün bağlanan kasa için uyarı üretildi');
        assertThat(!in_array($T_EXP, $ids, true), 'bugün bağlanan kasa için uyarı üretildi');
        assertThat(!in_array($T_NEW, $ids, true), 'hiç kasası olmayan işletme sessiz sayıldı');
    });

check('yedek kuralı yalnızca kasası olup yedek göndermeyeni buluyor',
    function () use ($T_BAK, $T_OK, $T_NEW) {
        $ids = ids_for('backup_missing');
        assertThat(in_array($T_BAK, $ids, true), 'hiç yedek göndermeyen bulunamadı');
        assertThat(!in_array($T_OK, $ids, true), 'bugün yedek gönderen için uyarı üretildi');
        assertThat(!in_array($T_NEW, $ids, true), 'kasası olmayan işletme için yedek uyarısı üretildi');
    });

check('gün sonu kuralı yalnızca kasası çalışıp gün sonu göndermeyeni buluyor',
    function () use ($T_DAY, $T_OK, $T_SIL, $T_NEW) {
        $ids = ids_for('day_not_closed');
        assertThat(in_array($T_DAY, $ids, true), '30 gündür gün sonu göndermeyen bulunamadı');
        assertThat(!in_array($T_OK, $ids, true), 'bugün gün sonu gönderen için uyarı üretildi');
        assertThat(!in_array($T_SIL, $ids, true),
            'kasası zaten sessiz olan işletme için ikinci bir uyarı üretildi');
        assertThat(!in_array($T_NEW, $ids, true), 'kasası olmayan işletme için gün sonu uyarısı üretildi');
    });

check('eşiğin altındaki durum uyarı üretmiyor', function () use ($T_SIL) {
    $r = one("SELECT * FROM np_alert_rules WHERE kind='till_silent' ORDER BY id LIMIT 1");
    $wide = $r; $wide['threshold'] = 30;      // 9 days silent, threshold 30
    $ids = array_map(fn($c) => (int) $c['tenant_id'], uyari_candidates($wide));
    assertThat(!in_array($T_SIL, $ids, true), '9 günlük sessizlik 30 gün eşiğini geçti');
    $tight = $r; $tight['threshold'] = 3;
    $ids2 = array_map(fn($c) => (int) $c['tenant_id'], uyari_candidates($tight));
    assertThat(in_array($T_SIL, $ids2, true), '9 günlük sessizlik 3 gün eşiğini geçmedi');
});

check('kapalı bir kural hiç değerlendirilmiyor', function () use (&$OUT, $MINE) {
    /* All four off, so this check consumes none of the alerts the next one is
       about to count - a rule that fired here would be de-duplicated there and
       the failure would look like "the alert never fires". */
    q('UPDATE np_alert_rules SET is_active=0');
    $OUT = [];
    $rep = uyari_run(['force' => true]);
    foreach ($MINE as $t) assertSame2(0, about($OUT, $t), 'kapalı kural uyarı gönderdi');
    assertSame2(0, (int) $rep['candidates'], 'kapalı kurallar için aday hesaplandı');
    q('UPDATE np_alert_rules SET is_active=1');
});

/* =================== 2. SENT ONCE, AND ONLY ONCE =================== */

check('uyarı gönderiliyor', function () use (&$OUT, $T_EXP, $T_SIL, $T_BAK, $T_DAY, $T_OK, $T_NEW) {
    $OUT = [];
    $rep = uyari_run(['force' => true]);
    assertThat(!empty($rep['ok']), 'çalıştırma başarısız: ' . json_encode($rep));
    assertSame2(1, about($OUT, $T_EXP), 'lisans uyarısı gitmedi');
    assertSame2(1, about($OUT, $T_SIL), 'sessiz kasa uyarısı gitmedi');
    assertSame2(1, about($OUT, $T_BAK), 'yedek uyarısı gitmedi');
    assertSame2(1, about($OUT, $T_DAY), 'gün sonu uyarısı gitmedi');
    assertSame2(0, about($OUT, $T_OK), 'sorunsuz müşteri için uyarı gitti');
    assertSame2(0, about($OUT, $T_NEW), 'kasası olmayan müşteri için uyarı gitti');
});

check('uyarının içinde ne olduğu ve nereye bakılacağı yazıyor', function () use (&$OUT, $T_EXP) {
    $m = null;
    foreach ($OUT as $x) if (strpos($x['body'], 'p=tenant&id=' . $T_EXP) !== false) $m = $x;
    assertThat($m !== null, 'lisans uyarısı yakalanmadı');
    assertThat(strpos($m['subject'], 'Uyarı Lisans') !== false, 'konuda işletme adı yok: ' . $m['subject']);
    assertThat(strpos($m['body'], 'Bitiş tarihi') !== false, 'gövdede bitiş tarihi yok');
    assertThat(strpos($m['body'], 'p=teshis') !== false, 'gövdede kasa teşhis bağlantısı yok');
    assertThat(strpos($m['body'], 'yalnızca bir kez') !== false,
        'gövde tekrar etmeyeceğini söylemiyor');
});

check('aynı uyarı ikinci çalıştırmada gönderilmiyor',
    function () use (&$OUT, $T_EXP, $T_SIL, $T_BAK, $T_DAY) {
        $OUT = [];
        $rep = uyari_run(['force' => true]);
        foreach ([$T_EXP, $T_SIL, $T_BAK, $T_DAY] as $t) {
            assertSame2(0, about($OUT, $t), 'aynı uyarı ikinci kez gönderildi (' . $t . ')');
        }
        assertThat($rep['skipped'] >= 4, 'atlananlar sayılmadı: ' . json_encode($rep));
    });

check('on kez çalıştırmak da bir şey göndermiyor', function () use (&$OUT, $T_EXP, $T_SIL) {
    $OUT = [];
    for ($i = 0; $i < 10; $i++) uyari_run(['force' => true]);
    assertSame2(0, about($OUT, $T_EXP), 'tekrar tekrar gönderildi');
    assertSame2(0, about($OUT, $T_SIL), 'tekrar tekrar gönderildi');
});

check('kayıt satırı olay anahtarıyla tutuluyor', function () use ($T_EXP) {
    $rows = all('SELECT s.*, r.kind FROM np_alert_sent s JOIN np_alert_rules r ON r.id=s.rule_id
                  WHERE s.tenant_id=?', [$T_EXP]);
    assertSame2(1, count($rows), 'lisans uyarısı için tek satır bekleniyordu');
    assertThat(strpos($rows[0]['subject_key'], 'exp:') === 0,
        'olay anahtarı bitiş tarihini taşımıyor: ' . $rows[0]['subject_key']);
});

/* =================== 3. RECURRENCE =================== */

check('düzelip tekrarlayan durum yeniden uyarabiliyor', function () use (&$OUT, $T_SIL) {
    /* The till comes back. Nothing to warn about. */
    q('UPDATE np_devices SET last_seen_at = NOW() WHERE tenant_id=?', [$T_SIL]);
    $OUT = [];
    uyari_run(['force' => true]);
    assertSame2(0, about($OUT, $T_SIL), 'geri dönen kasa için uyarı gitti');

    /* And a fortnight later it goes quiet again - a NEW episode, and the owner
       has to hear about it. This is the check a naive "already told him about
       this customer" de-duplication fails: it would stay silent for ever. */
    q('UPDATE np_devices SET last_seen_at = DATE_SUB(NOW(), INTERVAL 6 DAY) WHERE tenant_id=?', [$T_SIL]);
    $OUT = [];
    uyari_run(['force' => true]);
    assertSame2(1, about($OUT, $T_SIL), 'ikinci sessizlik dönemi için uyarı gitmedi');

    /* ...and that second warning is itself said only once. */
    $OUT = [];
    uyari_run(['force' => true]);
    assertSame2(0, about($OUT, $T_SIL), 'ikinci uyarı da tekrarlandı');

    $n = (int) val('SELECT COUNT(*) FROM np_alert_sent s JOIN np_alert_rules r ON r.id=s.rule_id
                     WHERE s.tenant_id=? AND r.kind=?', [$T_SIL, 'till_silent']);
    assertSame2(2, $n, 'iki ayrı olay iki satır olmalıydı');
});

check('lisans yenilenip yine yaklaşınca yeniden uyarıyor', function () use (&$OUT, $T_EXP) {
    q('UPDATE np_licences SET expires_at = DATE_ADD(NOW(), INTERVAL 400 DAY) WHERE tenant_id=?', [$T_EXP]);
    $OUT = [];
    uyari_run(['force' => true]);
    assertSame2(0, about($OUT, $T_EXP), 'yenilenmiş lisans için uyarı gitti');

    q('UPDATE np_licences SET expires_at = DATE_ADD(NOW(), INTERVAL 5 DAY) WHERE tenant_id=?', [$T_EXP]);
    $OUT = [];
    uyari_run(['force' => true]);
    assertSame2(1, about($OUT, $T_EXP), 'yeni dönemin bitişi için uyarı gitmedi');
});

check('yedek gelince olay kapanıyor, sonraki boşluk yeniden uyarıyor',
    function () use (&$OUT, $T_BAK) {
        q("INSERT INTO np_backups (tenant_id, device_id, filename, path, size_bytes, created_at)
           VALUES (?,?,?,?,?, NOW())", [$T_BAK, 'dev-ubak', 'y.sql.gz', '/tmp/y.sql.gz', 2048]);
        $OUT = [];
        uyari_run(['force' => true]);
        assertSame2(0, about($OUT, $T_BAK), 'yedek geldiği hâlde uyarı gitti');

        q('UPDATE np_backups SET created_at = DATE_SUB(NOW(), INTERVAL 6 DAY) WHERE tenant_id=?', [$T_BAK]);
        $OUT = [];
        uyari_run(['force' => true]);
        assertSame2(1, about($OUT, $T_BAK), 'yeni yedek boşluğu için uyarı gitmedi');
    });

check('gönderim başarısız olursa kayıt geri alınıyor ve sonra tekrar denenir',
    function () use (&$OUT, $T_DAY) {
        /* A mail server that was down for an hour must cost a delay, not a
           warning nobody ever gets. */
        q("DELETE s FROM np_alert_sent s JOIN np_alert_rules r ON r.id=s.rule_id
            WHERE s.tenant_id=? AND r.kind='day_not_closed'", [$T_DAY]);
        $GLOBALS['np_mailer'] = fn($to, $s, $b) => false;
        uyari_run(['force' => true]);
        $n = (int) val("SELECT COUNT(*) FROM np_alert_sent s JOIN np_alert_rules r ON r.id=s.rule_id
                         WHERE s.tenant_id=? AND r.kind='day_not_closed'", [$T_DAY]);
        assertSame2(0, $n, 'gönderilemeyen uyarı gönderilmiş sayıldı');

        $GLOBALS['np_mailer'] = function ($to, $subject, $body) use (&$OUT) {
            $OUT[] = ['to' => $to, 'subject' => $subject, 'body' => $body]; return true;
        };
        $OUT = [];
        uyari_run(['force' => true]);
        assertSame2(1, about($OUT, $T_DAY), 'posta düzelince uyarı yeniden denenmedi');
    });

check('prova hiçbir şey göndermiyor ve hiçbir şey yazmıyor', function () use (&$OUT) {
    $before = (int) val('SELECT COUNT(*) FROM np_alert_sent');
    $OUT = [];
    $rep = uyari_run(['dry' => true]);
    assertSame2(0, count($OUT), 'prova e-posta gönderdi');
    assertSame2($before, (int) val('SELECT COUNT(*) FROM np_alert_sent'), 'prova kayıt yazdı');
    assertThat(isset($rep['rules']) && count($rep['rules']) >= 4, 'prova rapor üretmedi');
});

/* =================== 4. THE CRON DOOR =================== */

/* The rules are switched off for the HTTP checks: what is being measured here
   is the door, and a run that actually posts mail through the real transport
   would make the answers depend on whether this machine has one. */
q('UPDATE np_alert_rules SET is_active=0');
$SECRET = uyari_secret();

check('gizli anahtar olmadan reddediliyor', function () use ($PANEL) {
    $r = http_get($PANEL . '/cron/uyari.php');
    assertSame2(401, $r['status'], 'anahtarsız çağrı kabul edildi');
    assertThat(empty($r['json']['ok']), 'anahtarsız çağrı ok döndü');
});

check('yanlış anahtar reddediliyor', function () use ($PANEL) {
    $r = http_get($PANEL . '/cron/uyari.php', ['X-NP-Alert-Key: yanlis-anahtar']);
    assertSame2(401, $r['status'], 'yanlış anahtar kabul edildi');
    $r2 = http_get($PANEL . '/cron/uyari.php', ['X-NP-Alert-Key: ']);
    assertSame2(401, $r2['status'], 'boş anahtar kabul edildi');
});

check('doğru anahtar başlıkla kabul ediliyor', function () use ($PANEL, $SECRET) {
    np_setting_set('alert_last_run', date('Y-m-d H:i:s', strtotime('-2 hours')));
    $r = http_get($PANEL . '/cron/uyari.php', ['X-NP-Alert-Key: ' . $SECRET]);
    assertSame2(200, $r['status'], 'doğru anahtar reddedildi: ' . substr($r['body'], 0, 200));
    assertThat(!empty($r['json']['ok']), 'ok gelmedi: ' . substr($r['body'], 0, 200));
    assertThat(isset($r['json']['rules']), 'rapor gelmedi');
});

check('anahtar adres satırında kabul edilmiyor', function () use ($PANEL, $SECRET) {
    foreach (['key', 'secret', 'token', 'anahtar', 'apikey'] as $name) {
        $r = http_get($PANEL . '/cron/uyari.php?' . $name . '=' . urlencode($SECRET));
        assertSame2(400, $r['status'], $name . '= ile anahtar kabul edildi');
        assertSame2('secret_in_url', $r['json']['error'] ?? '', $name . '= için yanlış hata');
    }
});

check('anahtarı taşıyan herhangi bir parametre de reddediliyor', function () use ($PANEL, $SECRET) {
    /* Not just the obvious names: the value itself is recognised, because a
       leaked URL is leaked whatever the parameter was called. */
    $r = http_get($PANEL . '/cron/uyari.php?filan=' . urlencode($SECRET));
    assertSame2(400, $r['status'], 'anahtarı taşıyan parametre kabul edildi');
    assertSame2('secret_in_url', $r['json']['error'] ?? '', 'yanlış hata');
});

check('adreste anahtar varken başlık doğru olsa bile reddediliyor', function () use ($PANEL, $SECRET) {
    $r = http_get($PANEL . '/cron/uyari.php?key=' . urlencode($SECRET),
                  ['X-NP-Alert-Key: ' . $SECRET]);
    assertSame2(400, $r['status'], 'adresteki anahtar başlık doğru diye affedildi');
});

check('gerekenden sık çağrılmak zararsız', function () use ($PANEL, $SECRET) {
    np_setting_set('alert_min_gap_sec', '300');
    $first = http_get($PANEL . '/cron/uyari.php', ['X-NP-Alert-Key: ' . $SECRET]);
    assertSame2(200, $first['status'], 'ilk çağrı');
    $second = http_get($PANEL . '/cron/uyari.php', ['X-NP-Alert-Key: ' . $SECRET]);
    assertSame2(200, $second['status'], 'ikinci çağrı hata verdi');
    assertThat(!empty($second['json']['throttled']),
        'kısa aralıklı ikinci çağrı yeniden tüm müşterileri taradı');
    assertSame2(0, (int) ($second['json']['sent'] ?? -1), 'kısılan çağrı uyarı gönderdi');
});

check('cron çağrısı son çalışma zamanını yazıyor', function () use ($PANEL, $SECRET) {
    $last = uyari_last_run();
    assertThat($last !== null, 'son çalışma zamanı yazılmadı');
    assertThat(abs(time() - strtotime($last)) < 300, 'son çalışma zamanı eski: ' . $last);
});

check('anahtar yenilenince eski anahtar geçersiz', function () use ($PANEL, $SECRET) {
    $new = uyari_roll_secret();
    assertThat($new !== $SECRET, 'yeni anahtar eskisiyle aynı');
    $old = http_get($PANEL . '/cron/uyari.php', ['X-NP-Alert-Key: ' . $SECRET]);
    assertSame2(401, $old['status'], 'eski anahtar hâlâ çalışıyor');
    np_setting_set('alert_last_run', date('Y-m-d H:i:s', strtotime('-2 hours')));
    $now = http_get($PANEL . '/cron/uyari.php', ['X-NP-Alert-Key: ' . $new]);
    assertSame2(200, $now['status'], 'yeni anahtar çalışmıyor');
});

check('cron satırında anahtar başlıkta, adreste değil', function () {
    $line = uyari_cron_line();
    assertThat(strpos($line, 'X-NP-Alert-Key:') !== false, 'cron satırında başlık yok: ' . $line);
    assertThat(strpos($line, '/cron/uyari.php') !== false, 'cron satırında adres yok');
    $url = null;
    if (preg_match('~(https?://\S+)~', $line, $m)) $url = $m[1];
    assertThat($url !== null, 'cron satırında URL bulunamadı');
    assertThat(strpos($url, '?') === false, 'cron satırındaki adres sorgu taşıyor: ' . $url);
    assertThat(strpos($url, np_setting('alert_cron_secret')) === false,
        'anahtar cron satırının adresinde');
});

q('UPDATE np_alert_rules SET is_active=1');

/* =================== 5. THE SCREEN =================== */

check('uyarılar ekranı yönetici için açılıyor', function () use ($PANEL, $ADMIN, $APASS) {
    $jar = browser_login($PANEL, $ADMIN, $APASS);
    $r = http_get($PANEL . '/admin/index.php?p=uyarilar', [], $jar);
    assertSame2(200, $r['status'], 'ekran açılmadı');
    assertThat(mb_strpos($r['body'], 'Uyarılar') !== false, 'başlık yok');
    assertThat(mb_strpos($r['body'], 'Sayfa bulunamadı') === false, '404 ekranı geldi');
    assertThat(mb_strpos($r['body'], 'Hazırlanıyor') === false, 'hâlâ placeholder');
    assertThat(mb_strpos($r['body'], 'Lisans bitiyor') !== false, 'kurallar listelenmiyor');
    assertThat(mb_strpos($r['body'], 'X-NP-Alert-Key') !== false, 'cron satırı ekranda yok');
    assertThat(mb_strpos($r['body'], 'Fatal error') === false
               && mb_strpos($r['body'], 'Panel bir hata') === false, 'PHP hatası');
    @unlink($jar);
});

check('uyarılar ekranı oturumsuz ziyaretçiyi girişe yolluyor', function () use ($PANEL) {
    $r = http_get($PANEL . '/admin/index.php?p=uyarilar');
    assertThat($r['status'] === 302 || $r['status'] === 301,
        $r['status'] . ' döndü, yönlendirme bekleniyordu');
    assertThat(stripos($r['headers'], 'p=login') !== false, 'girişe yönlendirmiyor');
    assertThat(mb_strpos($r['body'], 'X-NP-Alert-Key') === false,
        'oturumsuz ziyaretçiye cron anahtarı gösterildi');
});

check('eşik ekrandan kaydedilebiliyor ve sınırlanıyor', function () use ($PANEL, $ADMIN, $APASS) {
    $jar = browser_login($PANEL, $ADMIN, $APASS);
    $page = http_get($PANEL . '/admin/index.php?p=uyarilar', [], $jar);
    preg_match('/name="csrf" value="([a-f0-9]+)"/', $page['body'], $m);
    assertThat(!empty($m[1]), 'csrf alınamadı');
    $rule = one("SELECT * FROM np_alert_rules WHERE kind='licence_expiring' ORDER BY id LIMIT 1");

    $ch = curl_init($PANEL . '/admin/index.php?p=uyarilar');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_COOKIEFILE => $jar, CURLOPT_COOKIEJAR => $jar, CURLOPT_TIMEOUT => 30,
        CURLOPT_POSTFIELDS => http_build_query(['csrf' => $m[1], 'action' => 'uyari_rule_save',
            'id' => $rule['id'], 'threshold' => 9999, 'target' => '', 'is_active' => 1]),
    ]);
    curl_exec($ch); curl_close($ch);
    $after = one('SELECT * FROM np_alert_rules WHERE id=?', [$rule['id']]);
    assertSame2(365, (int) $after['threshold'], 'eşik sınırlanmadı');

    q('UPDATE np_alert_rules SET threshold=? WHERE id=?', [(int) $rule['threshold'], $rule['id']]);
    @unlink($jar);
});

/* ------------------------- teardown ------------------------- */
foreach (['uyari-ok@ornek.test', 'uyari-exp@ornek.test', 'uyari-sil@ornek.test',
          'uyari-bak@ornek.test', 'uyari-day@ornek.test', 'uyari-new@ornek.test'] as $e) {
    drop_tenant_u($e);
}

echo "\n$pass/$total checks passed\n";
if ($failures) {
    foreach ($failures as $f) echo "  ! $f\n";
    exit(1);
}
exit(0);
