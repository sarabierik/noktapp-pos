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
 * NOKTApp POS - the guest API, the half the NOKTA phone app talks to.
 *
 * Everything runs against the real MariaDB and the real HTTP endpoints. Nothing
 * is mocked, because the failures worth catching here are all failures of
 * authorisation and of joining, and a mock hides both: one guest seeing
 * another's balances, a card losing its campaign, a till-enrolled account taken
 * over by anyone who can type a phone number.
 *
 * The suite creates its own tenants and its own guests in the shared registry
 * and deletes them again, so it never touches the tenant the desktop suites use.
 *
 * Run:  php panel/tests/guest.php
 * Env:  NP_DB_*    the panel database    (nokpos_panel on 3399)
 *       NP_PASS_*  the shared registry   (nokpos_shared on 3399)
 *       PANEL      panel base URL        (http://127.0.0.1:8090)
 */
foreach ([
    'NP_DB_HOST' => '127.0.0.1', 'NP_DB_PORT' => '3399', 'NP_DB_NAME' => 'nokpos_panel',
    'NP_DB_USER' => 'noktapp',   'NP_DB_PASS' => 'nokpass',
    'NP_PASS_HOST' => '127.0.0.1', 'NP_PASS_PORT' => '3399', 'NP_PASS_NAME' => 'nokpos_shared',
    'NP_PASS_USER' => 'noktapp',   'NP_PASS_PASS' => 'nokpass',
] as $k => $v) { if (getenv($k) === false) putenv("$k=$v"); }

require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/pass_tables.php';

$PANEL = getenv('PANEL') ?: 'http://127.0.0.1:8090';
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
    if ($a !== $b) throw new RuntimeException($msg . ' (beklenen ' . var_export($a, true)
        . ', gelen ' . var_export($b, true) . ')');
}

function call(string $method, string $url, array $body = [], ?string $token = null): array {
    $h = ['Content-Type: application/json'];
    if ($token !== null) $h[] = 'Authorization: Bearer ' . $token;
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $method,
                            CURLOPT_HTTPHEADER => $h, CURLOPT_TIMEOUT => 30]);
    if ($body) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($raw === false) throw new RuntimeException('panel yanit vermedi: ' . $err);
    $j = json_decode($raw, true);
    if (!is_array($j)) throw new RuntimeException('gecersiz JSON (' . $status . '): ' . substr($raw, 0, 300));
    return ['status' => $status] + $j;
}

$P = pass_db();
if (!$P) { echo "\npass_db yapilandirilmamis - suite calistirilamaz\n"; exit(1); }
pass_ensure_tables($P);

/* ------------------------- fixture ------------------------- */
$PHONE_NEW   = '5550000101';   // nobody, until the suite registers them
$PHONE_TILL  = '5550000102';   // enrolled at a counter, no password
$PHONE_OTHER = '5550000103';   // a second guest, whose cards must stay invisible
$ALL_PHONES  = [$PHONE_NEW, $PHONE_TILL, $PHONE_OTHER];

function wipe_guests(PDO $P, array $phones): void {
    $ids = [];
    foreach ($phones as $ph) {
        $st = $P->prepare("SELECT id FROM customers WHERE phone IN (?,?,?,?)");
        $st->execute([$ph, '0' . $ph, '90' . $ph, '+90' . $ph]);
        foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $id) $ids[] = (int)$id;
    }
    /* Rows the suite itself marked, so a previous run's anonymised leftovers
       (phone NULLed by the delete test) go too. */
    foreach ($P->query("SELECT id FROM customers WHERE email LIKE 'guest-suite-%@ornek.test'")
                ->fetchAll(PDO::FETCH_COLUMN) as $id) $ids[] = (int)$id;
    $ids = array_values(array_unique($ids));
    if (!$ids) return;
    $in = implode(',', array_fill(0, count($ids), '?'));
    foreach (['np_guest_sessions', 'np_guest_events', 'loyalty_qr_tokens', 'loyalty_cards'] as $t) {
        try { $P->prepare("DELETE FROM $t WHERE customer_id IN ($in)")->execute($ids); }
        catch (Throwable $e) {}
    }
    $P->prepare("DELETE FROM customers WHERE id IN ($in)")->execute($ids);
}

function drop_tenant_by_email(string $email): void {
    $t = one('SELECT id FROM np_tenants WHERE email=?', [$email]);
    if (!$t) return;
    $id = (int)$t['id'];
    foreach (['np_devices', 'np_licences', 'np_reports'] as $tab) q("DELETE FROM $tab WHERE tenant_id=?", [$id]);
    q('DELETE FROM np_tenants WHERE id=?', [$id]);
    $P = pass_db();
    foreach (['np_tenant_programs', 'np_guest_events'] as $tab) {
        try { $P->prepare("DELETE FROM $tab WHERE tenant_id=?")->execute([$id]); } catch (Throwable $e) {}
    }
    try { $P->prepare("DELETE FROM loyalty_cards WHERE client_id=?")->execute([$id]); } catch (Throwable $e) {}
    try { $P->prepare("DELETE FROM loyalty_programs WHERE client_id=?")->execute([$id]); } catch (Throwable $e) {}
}

function make_tenant(string $code, string $name, string $email, string $city,
                     string $status = 'active', int $active = 1): int {
    drop_tenant_by_email($email);
    q('INSERT INTO np_tenants (code, company_name, owner_name, email, password_hash, city, is_active)
       VALUES (?,?,?,?,?,?,?)', [$code, $name, 'Test', $email, password_hash('x', PASSWORD_BCRYPT), $city, $active]);
    $id = lastId();
    q("INSERT INTO np_licences (tenant_id, licence_key, plan, status, seats, starts_at, expires_at, grace_days)
       VALUES (?,?,'standart',?,5,CURDATE(), DATE_ADD(NOW(), INTERVAL 365 DAY), 7)",
      [$id, strtoupper(bin2hex(random_bytes(12))), $status]);
    return $id;
}

wipe_guests($P, $ALL_PHONES);
$TA = make_tenant('GTESTA', 'Pizza Test A', 'guest-a@ornek.test', 'Antalya');
$TB = make_tenant('GTESTB', 'Bar Test B',   'guest-b@ornek.test', 'Alanya');
$TS = make_tenant('GTESTS', 'Kapali Test',  'guest-c@ornek.test', 'Izmir', 'suspended');
/* A legacy web-POS tenant: its campaign lives in pass_db.loyalty_programs, as
   the old system wrote it, and never came through the desktop mirror at all.
   Those guests must keep working - this is the half of the join that is not
   new. */
$TL = make_tenant('GTESTL', 'Eski Web Test', 'guest-d@ornek.test', 'Bursa');

/* The collision this whole mirror exists for: BOTH tenants have a programme
   they call number 3, because loyalty_programs auto-increments per till. */
$prog = $P->prepare("INSERT INTO np_tenant_programs
    (tenant_id, program_id, product_id, title, target_count, reward_text, product_name, product_price, is_active)
    VALUES (?,?,?,?,?,?,?,?,?)");
$prog->execute([$TA, 3, 11, '4 pizza 1 bizden', 4, 'Bir pizza bizden', 'Margarita', 250.00, 1]);
$prog->execute([$TB, 3, 22, '6 bira 1 bizden',  6, 'Bir bira bizden',  'Efes',       90.00, 1]);
$prog->execute([$TB, 9, 23, 'Kapali kampanya',  5, 'Hicbir sey',       'Kola',       40.00, 0]);
$prog->execute([$TS, 3, 31, 'Kapali restoran',  4, 'Hicbir sey',       'Lahmacun',   60.00, 1]);

/* The legacy web-POS campaign table. It belongs to the old product and a
   sandbox registry may not carry it, but this suite needs it present in order
   to prove the legacy join still works - so it is created here rather than
   assumed, exactly as the real pass_db has it. */
$P->exec("CREATE TABLE IF NOT EXISTS `loyalty_programs` (
    `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
    `client_id` int(11) NOT NULL,
    `product_id` int(10) UNSIGNED DEFAULT NULL,
    `title` varchar(190) NOT NULL,
    `target_count` int(10) UNSIGNED NOT NULL DEFAULT 10,
    `reward_text` varchar(190) NOT NULL,
    `is_active` tinyint(1) NOT NULL DEFAULT 1,
    `created_at` datetime NOT NULL DEFAULT current_timestamp(),
    PRIMARY KEY (`id`),
    KEY `idx_lp_client` (`client_id`,`is_active`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
$P->prepare("DELETE FROM loyalty_programs WHERE client_id=?")->execute([$TL]);
$P->prepare("INSERT INTO loyalty_programs (client_id, product_id, title, target_count, reward_text, is_active)
             VALUES (?,?,?,?,?,1)")->execute([$TL, 44, '8 kahve 1 bizden', 8, 'Bir kahve bizden']);
$LEGACY_PROG = (int)$P->lastInsertId();

function make_guest(PDO $P, string $phone, string $first, ?string $pw, string $qr): int {
    $P->prepare("INSERT INTO customers (first_name, phone, email, password_hash, qr_uid,
                     is_verified, is_active, created_at, updated_at)
                 VALUES (?,?,?,?,?,0,1,NOW(),NOW())")
      ->execute([$first, $phone, 'guest-suite-' . $phone . '@ornek.test',
                 $pw === null ? null : password_hash($pw, PASSWORD_DEFAULT), $qr]);
    return (int)$P->lastInsertId();
}
$CARD_CODE = bin2hex(random_bytes(16));
$tillGuest = make_guest($P, $PHONE_TILL,  'Mehmet', null,       $CARD_CODE);
$other     = make_guest($P, $PHONE_OTHER, 'Baskasi', 'Baska123', bin2hex(random_bytes(16)));

/* Mehmet's cards, as a till would have mirrored them: four pizza stamps at A,
   two beers at B, and one card at a restaurant whose campaign never synced. */
$card = $P->prepare("INSERT INTO loyalty_cards (client_id, customer_id, program_id, progress_count,
            rewards_available, rewards_used, created_at, updated_at) VALUES (?,?,?,?,?,?,NOW(),NOW())");
$card->execute([$TA, $tillGuest, 3, 3, 1, 0]);
$card->execute([$TB, $tillGuest, 3, 2, 0, 0]);
$card->execute([$TB, $tillGuest, 77, 4, 0, 0]);          // campaign missing on purpose
$card->execute([$TA, $other,     3, 3, 2, 1]);           // somebody else's card
$card->execute([$TL, $tillGuest, $LEGACY_PROG, 5, 0, 0]);   // the legacy web-POS card

/* Movement history, as the tills mirror it. Event id 41 at BOTH tenants - the
   collision again, one table down. */
$ev = $P->prepare("INSERT INTO np_guest_events (tenant_id, event_id, customer_id, program_id, card_id,
            kind, qty, order_id, product_name, program_title, happened_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)");
$ev->execute([$TA, 41, $tillGuest, 3, 1, 'stamp',  3, 900, 'Margarita', '4 pizza 1 bizden', '2026-09-10 12:00:00']);
$ev->execute([$TB, 41, $tillGuest, 3, 2, 'stamp',  2, 901, 'Efes',      '6 bira 1 bizden',  '2026-09-12 21:30:00']);
$ev->execute([$TA, 42, $tillGuest, 3, 1, 'reward', 1, 902, 'Margarita', '4 pizza 1 bizden', '2026-09-14 13:15:00']);
$ev->execute([$TA, 43, $other,     3, 4, 'stamp',  1, 903, 'Margarita', '4 pizza 1 bizden', '2026-09-15 13:15:00']);

$G = "$PANEL/api/guest";
function untangle(PDO $P): void { $P->exec("DELETE FROM np_guest_attempts"); }

echo "\nNOKTApp POS - misafir API (NOKTA telefon uygulamasi)\n\n";

/* ------------------------- registration ------------------------- */
$newToken = null;
check('a phone nobody has used registers and is logged straight in', function () use ($G, $PHONE_NEW, $P, &$newToken) {
    untangle($P);
    $r = call('POST', "$G/register.php", ['phone' => $PHONE_NEW, 'first_name' => 'Yeni',
        'password' => 'Sifre1234', 'email' => 'guest-suite-' . $PHONE_NEW . '@ornek.test']);
    assertSame2(200, $r['status'], 'HTTP');
    assertThat(!empty($r['ok']), 'ok degil: ' . json_encode($r));
    assertThat(preg_match('/^[a-f0-9]{64}$/', (string)($r['token'] ?? '')) === 1, 'token 64 hex olmali');
    assertSame2('Yeni', $r['guest']['first_name'], 'ad');
    assertThat(!empty($r['guest']['qr_uid']), 'kart kodu uretilmedi');
    $newToken = $r['token'];
});

check('the session token is stored hashed, never in the clear', function () use ($P, &$newToken) {
    $n = (int)$P->query("SELECT COUNT(*) FROM np_guest_sessions")->fetchColumn();
    assertThat($n > 0, 'oturum yazilmadi');
    $st = $P->prepare("SELECT COUNT(*) FROM np_guest_sessions WHERE token_hash=?");
    $st->execute([$newToken]);
    assertSame2(0, (int)$st->fetchColumn(), 'token duz metin olarak saklanmis');
    $st = $P->prepare("SELECT COUNT(*) FROM np_guest_sessions WHERE token_hash=?");
    $st->execute([hash('sha256', $newToken)]);
    assertSame2(1, (int)$st->fetchColumn(), 'sha256 satiri yok');
});

check('registering a number that already has a password is refused', function () use ($G, $PHONE_NEW, $P) {
    untangle($P);
    $r = call('POST', "$G/register.php", ['phone' => $PHONE_NEW, 'first_name' => 'Yeni', 'password' => 'Sifre1234']);
    assertSame2(409, $r['status'], 'HTTP');
    assertSame2('ALREADY_REGISTERED', $r['code'] ?? null, 'kod');
});

check('a till-enrolled account cannot be taken over with the phone number alone',
    function () use ($G, $PHONE_TILL, $P) {
    untangle($P);
    $r = call('POST', "$G/register.php", ['phone' => $PHONE_TILL, 'first_name' => 'Hirsiz', 'password' => 'Sifre1234']);
    assertSame2(409, $r['status'], 'HTTP');
    assertSame2('NEEDS_PROOF', $r['code'] ?? null, 'kod');
});

check('a wrong card code does not take it over either', function () use ($G, $PHONE_TILL, $P) {
    untangle($P);
    $r = call('POST', "$G/register.php", ['phone' => $PHONE_TILL, 'first_name' => 'Hirsiz',
        'password' => 'Sifre1234', 'card_code' => bin2hex(random_bytes(16))]);
    assertSame2(409, $r['status'], 'HTTP');
    assertSame2('NEEDS_PROOF', $r['code'] ?? null, 'kod');
});

$tillToken = null;
check('the real card code claims the account and keeps its stamps',
    function () use ($G, $PHONE_TILL, $CARD_CODE, $P, &$tillToken, $tillGuest) {
    untangle($P);
    $r = call('POST', "$G/register.php", ['phone' => $PHONE_TILL, 'first_name' => 'Mehmet',
        'password' => 'Mehmet123', 'card_code' => $CARD_CODE]);
    assertSame2(200, $r['status'], 'HTTP: ' . json_encode($r));
    assertSame2($tillGuest, (int)$r['guest']['id'], 'ayni musteri satiri olmali, yenisi degil');
    $tillToken = $r['token'];
});

/* ------------------------- login ------------------------- */
check('a wrong password and an unknown number give the same answer', function () use ($G, $PHONE_TILL, $P) {
    untangle($P);
    $wrong   = call('POST', "$G/login.php", ['phone' => $PHONE_TILL, 'password' => 'yanlis']);
    untangle($P);
    $unknown = call('POST', "$G/login.php", ['phone' => '5559998877', 'password' => 'yanlis']);
    assertSame2(401, $wrong['status'], 'yanlis sifre HTTP');
    assertSame2(401, $unknown['status'], 'bilinmeyen numara HTTP');
    assertSame2($wrong['error'], $unknown['error'], 'iki mesaj ayni olmali - yoksa bu bir uye rehberi');
});

check('the right password logs in', function () use ($G, $PHONE_TILL, $P) {
    untangle($P);
    $r = call('POST', "$G/login.php", ['phone' => $PHONE_TILL, 'password' => 'Mehmet123']);
    assertSame2(200, $r['status'], 'HTTP: ' . json_encode($r));
    assertThat(preg_match('/^[a-f0-9]{64}$/', (string)($r['token'] ?? '')) === 1, 'token');
});

check('a guest with no password is sent to the claim flow, not left guessing',
    function () use ($G, $P, $PHONE_OTHER) {
    untangle($P);
    $P->prepare("UPDATE customers SET password_hash=NULL WHERE phone=?")->execute([$PHONE_OTHER]);
    $r = call('POST', "$G/login.php", ['phone' => $PHONE_OTHER, 'password' => 'Baska123']);
    assertSame2(409, $r['status'], 'HTTP');
    assertSame2('NEEDS_REGISTER', $r['code'] ?? null, 'kod');
    $P->prepare("UPDATE customers SET password_hash=? WHERE phone=?")
      ->execute([password_hash('Baska123', PASSWORD_DEFAULT), $PHONE_OTHER]);
});

check('the various shapes of the same number are one account',
    function () use ($G, $PHONE_TILL, $P) {
    foreach (['0' . $PHONE_TILL, '+90' . $PHONE_TILL, '90 ' . $PHONE_TILL] as $shape) {
        untangle($P);
        $r = call('POST', "$G/login.php", ['phone' => $shape, 'password' => 'Mehmet123']);
        assertSame2(200, $r['status'], $shape . ' ile giris');
    }
});

/* ------------------------- cards ------------------------- */
check('no token, no cards', function () use ($G) {
    $r = call('GET', "$G/cards.php");
    assertSame2(401, $r['status'], 'HTTP');
});

check('a token in the query string is not a token', function () use ($G, &$tillToken) {
    $r = call('GET', "$G/cards.php?token=" . $tillToken);
    assertSame2(401, $r['status'], 'URL uzerinden oturum kabul edilmemeli');
});

check('a made-up token is refused', function () use ($G) {
    $r = call('GET', "$G/cards.php", [], bin2hex(random_bytes(32)));
    assertSame2(401, $r['status'], 'HTTP');
});

check('the guest sees their own two cards, each with its own campaign',
    function () use ($G, &$tillToken, $TA, $TB) {
    $r = call('GET', "$G/cards.php", [], $tillToken);
    assertSame2(200, $r['status'], 'HTTP: ' . json_encode($r));
    $by = [];
    foreach ($r['cards'] as $c) $by[$c['tenant_id'] . ':' . $c['program_id']] = $c;
    assertSame2('4 pizza 1 bizden', $by["$TA:3"]['title'] ?? null, 'A kampanyasi');
    assertSame2('6 bira 1 bizden',  $by["$TB:3"]['title'] ?? null, 'B kampanyasi');
    assertSame2(4, $by["$TA:3"]['target_count'], 'A hedefi');
    assertSame2(6, $by["$TB:3"]['target_count'], 'B hedefi');
    assertSame2('Pizza Test A', $by["$TA:3"]['restaurant'], 'A restoran adi');
    assertSame2('Bar Test B',   $by["$TB:3"]['restaurant'], 'B restoran adi');
});

check('restaurants that all call their campaign number 3 do not overwrite each other',
    function () use ($G, &$tillToken, $TA, $TB) {
    /* Three tenants in this fixture happen to have a programme 3 - two desktop
       tills and, because loyalty_programs auto-increments, the legacy web-POS
       one as well. That is not a coincidence to work around, it is the whole
       reason the mirror is keyed by the pair: every restaurant has a 3. */
    $r = call('GET', "$G/cards.php", [], $tillToken);
    $titles = [];
    foreach ($r['cards'] as $c) if ((int)$c['program_id'] === 3) $titles[$c['tenant_id']] = $c['title'];
    assertThat(count($titles) >= 2, '3 numarali kampanyalarin hepsi gorunmeli');
    assertSame2(count($titles), count(array_unique($titles)),
        'iki restoranin kampanyasi ayni metni gosteriyor - anahtar cakismis');
    assertSame2('4 pizza 1 bizden', $titles[$TA] ?? null, 'A kampanyasi');
    assertSame2('6 bira 1 bizden',  $titles[$TB] ?? null, 'B kampanyasi');
});

check('a legacy web-POS card still resolves through loyalty_programs',
    function () use ($G, &$tillToken, $TL, $LEGACY_PROG) {
    $r = call('GET', "$G/cards.php", [], $tillToken);
    $hit = null;
    foreach ($r['cards'] as $c) {
        if ((int)$c['tenant_id'] === $TL && (int)$c['program_id'] === $LEGACY_PROG) { $hit = $c; break; }
    }
    assertThat($hit !== null, 'eski web-POS karti kaybolmus');
    assertSame2('8 kahve 1 bizden', $hit['title'], 'eski kampanya basligi');
    assertSame2(8, $hit['target_count'], 'eski kampanya hedefi');
    assertSame2(3, $hit['remaining'], 'kalan (8 hedef, 5 pul)');
});

check('remaining and rewards are the numbers the till wrote', function () use ($G, &$tillToken, $TA, $TB) {
    $r = call('GET', "$G/cards.php", [], $tillToken);
    foreach ($r['cards'] as $c) {
        if ((int)$c['tenant_id'] === $TA && (int)$c['program_id'] === 3) {
            assertSame2(3, $c['progress_count'], 'A ilerleme');
            assertSame2(1, $c['remaining'], 'A kalan (4 hedef, 3 pul)');
            assertSame2(1, $c['rewards_available'], 'A odul');
        }
        if ((int)$c['tenant_id'] === $TB && (int)$c['program_id'] === 3) {
            assertSame2(4, $c['remaining'], 'B kalan (6 hedef, 2 pul)');
        }
    }
    assertSame2(1, $r['rewards_ready'], 'toplam hazir odul');
});

check('a card whose campaign never synced is left out, not shown broken',
    function () use ($G, &$tillToken) {
    $r = call('GET', "$G/cards.php", [], $tillToken);
    assertSame2(200, $r['status'], 'HTTP: ' . json_encode($r));
    assertThat(count($r['cards']) > 0, 'liste bos - bu kontrol bos listede hicbir sey kanitlamaz');
    foreach ($r['cards'] as $c) {
        assertThat((int)$c['program_id'] !== 77, '77 numarali kampanyasiz kart gosterilmis');
        assertThat(trim((string)$c['title']) !== '', 'basligi bos bir kart var');
    }
});

check('one guest cannot see another guest\'s card', function () use ($G, &$tillToken, $tillGuest) {
    $r = call('GET', "$G/cards.php", [], $tillToken);
    assertSame2($tillGuest, (int)$r['guest']['id'], 'oturum sahibi');
    foreach ($r['cards'] as $c) {
        assertThat((int)$c['rewards_used'] === 0, 'baska misafirin karti sizmis (rewards_used=1 onun)');
    }
});

check('cards are grouped by restaurant', function () use ($G, &$tillToken) {
    $r = call('GET', "$G/cards.php", [], $tillToken);
    assertSame2(3, count($r['restaurants']), 'uc restoran bekleniyor');
    foreach ($r['restaurants'] as $g) assertThat(count($g['cards']) >= 1, 'bos restoran grubu');
});

/* ------------------------- one card, and history ------------------------- */
check('a card detail carries only that card\'s movements', function () use ($G, &$tillToken, $TA) {
    $r = call('POST', "$G/card.php", ['tenant_id' => $TA, 'program_id' => 3], $tillToken);
    assertSame2(200, $r['status'], 'HTTP: ' . json_encode($r));
    assertSame2('4 pizza 1 bizden', $r['card']['title'], 'kampanya');
    assertSame2(2, count($r['events']), 'A restoraninda iki hareket');
    foreach ($r['events'] as $e) assertSame2('4 pizza 1 bizden', $e['program_title'], 'yabanci hareket');
});

check('asking for a card at a restaurant you have never visited returns nothing, not someone else\'s',
    function () use ($G, &$tillToken, $TS) {
    $r = call('POST', "$G/card.php", ['tenant_id' => $TS, 'program_id' => 3], $tillToken);
    assertSame2(404, $r['status'], 'HTTP');
});

check('history is every restaurant, newest first, and only mine',
    function () use ($G, &$tillToken) {
    $r = call('GET', "$G/history.php", [], $tillToken);
    assertSame2(200, $r['status'], 'HTTP: ' . json_encode($r));
    assertSame2(3, count($r['events']), 'uc hareket bekleniyor');
    $times = array_column($r['events'], 'happened_at');
    $sorted = $times; rsort($sorted);
    assertSame2($sorted, $times, 'en yeni ustte olmali');
    assertSame2('reward', $r['events'][0]['kind'], 'en yeni hareket odul kullanimi');
    foreach ($r['events'] as $e) assertThat((int)$e['qty'] !== 1 || $e['kind'] !== 'stamp'
        || $e['product_name'] === 'Margarita' || $e['product_name'] === 'Efes', 'yabanci satir');
});

check('the same event id at two restaurants stays two events', function () use ($G, &$tillToken, $TA, $TB) {
    $r = call('GET', "$G/history.php", [], $tillToken);
    $t = [];
    foreach ($r['events'] as $e) $t[] = $e['tenant_id'];
    assertThat(in_array($TA, $t, true) && in_array($TB, $t, true), 'iki restoranin 41 numarali olayi cakismis');
});

/* ------------------------- the QR code ------------------------- */
check('a one-time code is minted and the till would accept it',
    function () use ($G, &$tillToken, $P, $tillGuest) {
    untangle($P);
    $r = call('POST', "$G/qr.php", [], $tillToken);
    assertSame2(200, $r['status'], 'HTTP: ' . json_encode($r));
    assertThat(preg_match('/^[a-f0-9]{64}$/', (string)$r['token']) === 1, '64 hex olmali');
    assertThat((int)$r['expires_in'] <= 600, 'sure cok uzun');
    $st = $P->prepare("SELECT customer_id, used_at FROM loyalty_qr_tokens WHERE token=?");
    $st->execute([$r['token']]);
    $row = $st->fetch();
    assertSame2($tillGuest, (int)$row['customer_id'], 'kodun sahibi');
    assertThat($row['used_at'] === null, 'kod dogdugu anda harcanmis');
});

check('every tap makes a different code', function () use ($G, &$tillToken, $P) {
    untangle($P);
    $a = call('POST', "$G/qr.php", [], $tillToken);
    $b = call('POST', "$G/qr.php", [], $tillToken);
    assertThat($a['token'] !== $b['token'], 'ayni kod iki kere verilmis');
});

/* ------------------------- discover ------------------------- */
check('kesfet lists live campaigns and skips closed ones', function () use ($G, &$tillToken, $TA, $TB, $TS) {
    $r = call('GET', "$G/restaurants.php", [], $tillToken);
    assertSame2(200, $r['status'], 'HTTP: ' . json_encode($r));
    $ids = array_column($r['restaurants'], 'tenant_id');
    assertThat(in_array($TA, $ids, true), 'A listede olmali');
    assertThat(!in_array($TS, $ids, true), 'lisansi askiya alinmis restoran listelenmis');
    foreach ($r['restaurants'] as $t) {
        foreach ($t['programs'] as $p) assertThat((int)$p['program_id'] !== 9, 'kapali kampanya listelenmis');
    }
});

check('a campaign the guest is already collecting is marked', function () use ($G, &$tillToken, $TA) {
    $r = call('GET', "$G/restaurants.php", [], $tillToken);
    foreach ($r['restaurants'] as $t) {
        if ((int)$t['tenant_id'] !== $TA) continue;
        foreach ($t['programs'] as $p) {
            if ((int)$p['program_id'] === 3) assertSame2(1, (int)$p['already_mine'], 'isaretlenmemis');
        }
    }
});

/* ------------------------- profile ------------------------- */
check('a guest can fix their own name', function () use ($G, &$tillToken) {
    $r = call('POST', "$G/profile.php", ['first_name' => 'Mehmet Ali'], $tillToken);
    assertSame2(200, $r['status'], 'HTTP: ' . json_encode($r));
    assertSame2('Mehmet Ali', $r['guest']['first_name'], 'ad');
});

check('a guest cannot move their account onto someone else\'s number',
    function () use ($G, &$tillToken, $PHONE_TILL, $PHONE_OTHER) {
    $r = call('POST', "$G/profile.php", ['phone' => $PHONE_OTHER, 'first_name' => 'Mehmet Ali'], $tillToken);
    assertSame2(200, $r['status'], 'HTTP');
    assertSame2($PHONE_TILL, $r['guest']['phone'], 'telefon degismis olmamali');
});

check('changing the password needs the old one', function () use ($G, &$tillToken, $P) {
    untangle($P);
    $r = call('POST', "$G/profile.php", ['new_password' => 'Yeni12345', 'current_password' => 'yanlis'], $tillToken);
    assertSame2(403, $r['status'], 'HTTP');
});

check('a password change signs the other phones out but not this one',
    function () use ($G, &$tillToken, $PHONE_TILL, $P, $tillGuest) {
    untangle($P);
    $second = call('POST', "$G/login.php", ['phone' => $PHONE_TILL, 'password' => 'Mehmet123']);
    assertSame2(200, $second['status'], 'ikinci telefon giremedi');
    $r = call('POST', "$G/profile.php",
        ['new_password' => 'Yeni12345', 'current_password' => 'Mehmet123'], $tillToken);
    assertSame2(200, $r['status'], 'HTTP: ' . json_encode($r));
    $mine  = call('GET', "$G/cards.php", [], $tillToken);
    $other = call('GET', "$G/cards.php", [], $second['token']);
    assertSame2(200, $mine['status'], 'kendi oturumum dusmus');
    assertSame2(401, $other['status'], 'diger telefonun oturumu hala acik');
    untangle($P);
    $back = call('POST', "$G/login.php", ['phone' => $PHONE_TILL, 'password' => 'Yeni12345']);
    assertSame2(200, $back['status'], 'yeni sifreyle girilemiyor');
    $tillToken = $back['token'];
});

check('logout kills this session', function () use ($G, $PHONE_TILL, $P) {
    untangle($P);
    $s = call('POST', "$G/login.php", ['phone' => $PHONE_TILL, 'password' => 'Yeni12345']);
    $r = call('POST', "$G/logout.php", [], $s['token']);
    assertSame2(200, $r['status'], 'HTTP');
    assertSame2(401, call('GET', "$G/cards.php", [], $s['token'])['status'], 'oturum hala acik');
});

/* ------------------------- throttle ------------------------- */
check('five wrong passwords lock the number for a while', function () use ($G, $PHONE_TILL, $P) {
    untangle($P);
    $last = null;
    for ($i = 0; $i < 7; $i++) {
        $last = call('POST', "$G/login.php", ['phone' => $PHONE_TILL, 'password' => 'yanlis' . $i]);
    }
    assertSame2(429, $last['status'], 'sinirsiz deneme yapilabiliyor');
});

check('the lock does not stop a different number', function () use ($G, $PHONE_OTHER) {
    $r = call('POST', "$G/login.php", ['phone' => $PHONE_OTHER, 'password' => 'Baska123']);
    assertSame2(200, $r['status'], 'baska numara da kilitlenmis: ' . json_encode($r));
});

/* ------------------------- delete ------------------------- */
check('deleting an account needs the password', function () use ($G, $PHONE_OTHER, $P) {
    untangle($P);
    $s = call('POST', "$G/login.php", ['phone' => $PHONE_OTHER, 'password' => 'Baska123']);
    $r = call('POST', "$G/delete.php", ['password' => 'yanlis'], $s['token']);
    assertSame2(403, $r['status'], 'HTTP');
});

check('delete erases the person, keeps the restaurant\'s ledger, and says so',
    function () use ($G, $PHONE_OTHER, $P, $other) {
    untangle($P);
    $s = call('POST', "$G/login.php", ['phone' => $PHONE_OTHER, 'password' => 'Baska123']);
    $r = call('POST', "$G/delete.php", ['password' => 'Baska123'], $s['token']);
    assertSame2(200, $r['status'], 'HTTP: ' . json_encode($r));
    assertThat(!empty($r['note']), 'yerel kayitlar hakkinda uyari yok');

    $st = $P->prepare("SELECT phone, email, password_hash, qr_uid, is_active FROM customers WHERE id=?");
    $st->execute([$other]);
    $row = $st->fetch();
    assertThat($row['phone'] === null && $row['email'] === null, 'kisisel alanlar silinmemis');
    assertThat($row['password_hash'] === null && $row['qr_uid'] === null, 'sifre veya kart kodu kalmis');
    assertSame2(0, (int)$row['is_active'], 'hesap hala aktif');

    $st = $P->prepare("SELECT COUNT(*) FROM np_guest_sessions WHERE customer_id=?");
    $st->execute([$other]);
    assertSame2(0, (int)$st->fetchColumn(), 'oturumlar kalmis');
    $st = $P->prepare("SELECT COUNT(*) FROM np_guest_events WHERE customer_id=?");
    $st->execute([$other]);
    assertSame2(0, (int)$st->fetchColumn(), 'hareket gecmisi kalmis');
    $st = $P->prepare("SELECT COUNT(*) FROM loyalty_cards WHERE customer_id=?");
    $st->execute([$other]);
    assertThat((int)$st->fetchColumn() > 0, 'restoranin pul defteri de silinmis - o onun muhasebesi');

    assertSame2(401, call('GET', "$G/cards.php", [], $s['token'])['status'], 'silinen hesap hala giriyor');
});

check('a deleted guest cannot log in again', function () use ($G, $PHONE_OTHER, $P) {
    untangle($P);
    $r = call('POST', "$G/login.php", ['phone' => $PHONE_OTHER, 'password' => 'Baska123']);
    assertSame2(401, $r['status'], 'HTTP');
});

/* ------------------------- teardown ------------------------- */
untangle($P);
wipe_guests($P, $ALL_PHONES);
foreach (['guest-a@ornek.test', 'guest-b@ornek.test', 'guest-c@ornek.test',
          'guest-d@ornek.test'] as $e) drop_tenant_by_email($e);

echo "\n  $pass/$total checks passed\n";
foreach ($failures as $f) echo "  ! $f\n";
exit($failures ? 1 : 0);
