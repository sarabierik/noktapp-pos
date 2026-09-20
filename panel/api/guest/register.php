<?php
/**
 * Sign up — or claim the account a restaurant already made for you.
 *
 * Three cases, and the third is the one that matters for security:
 *
 *  1. The number is new. Nothing exists to steal, so the account is created
 *     with the password given and the guest is logged straight in.
 *
 *  2. The number exists AND already has a password. Somebody has been here.
 *     We say "log in instead" and nothing else — we do not offer to reset a
 *     password we cannot prove belongs to the caller.
 *
 *  3. The number exists with NO password. This is the common case and the
 *     dangerous one: a cashier enrolled this guest at the counter, so the row
 *     carries real stamps and real rewards. Letting anyone who can type a phone
 *     number take it over would hand a stranger somebody's free pizzas and the
 *     list of restaurants they eat at. So possession has to be proved, and the
 *     only proof available offline is the card code — the qr_uid printed on
 *     the guest's own NOKTA card, which they are holding.
 *
 * Case 3 without the code is answered with NEEDS_PROOF, not with a password
 * field. It is the app's job to explain it, not to work around it.
 *
 * An SMS one-time code is the right second channel here and is NOT implemented:
 * it needs a Turkish SMS provider under contract, and inventing one would make
 * this endpoint look finished when it is not. When that contract exists, it
 * plugs in at exactly this point — see docs/NOKTA-API.md.
 */
require_once __DIR__ . '/../../lib/guest.php';
guest_cors();
guest_require_post();

$in    = json_in();
$pass  = guest_pass();
$phone = np_tr_phone((string)($in['phone'] ?? ''));
$first = trim((string)($in['first_name'] ?? ''));
$pw    = (string)($in['password'] ?? '');
$code  = trim((string)($in['card_code'] ?? ''));

if (!preg_match('/^5\d{9}$/', $phone)) fail('Telefon 5 ile baslayan 10 hane olmali');
if (mb_strlen($pw) < 6)               fail('Sifre en az 6 karakter olmali');
if (mb_strlen($pw) > 200)             fail('Sifre cok uzun');

/* Throttled like a login, because case 3 turns this endpoint into one: a
   card_code guess is a credential guess. */
guest_throttle($pass, 'register', $phone);

try {
    $variants = np_phone_variants($phone);
    $ph = implode(',', array_fill(0, count($variants), '?'));
    $st = $pass->prepare("SELECT * FROM customers WHERE phone IN ($ph) LIMIT 1");
    $st->execute($variants);
    $row = $st->fetch() ?: null;

    if ($row && !empty($row['password_hash'])) {
        guest_attempt($pass, 'register', $phone, false);
        out(['ok' => false, 'code' => 'ALREADY_REGISTERED',
             'error' => 'Bu numara kayitli. Giris yapin.'], 409);
    }

    if ($row) {
        // enrolled at a till, no password yet — prove the card is yours
        $uid = (string)($row['qr_uid'] ?? '');
        if ($code === '' || $uid === '' || !hash_equals(strtolower($uid), strtolower($code))) {
            guest_attempt($pass, 'register', $phone, false);
            out(['ok' => false, 'code' => 'NEEDS_PROOF',
                 'error' => 'Bu numara bir restoranda kayitli. Hesabi devralmak icin '
                          . 'NOKTA kartinizdaki kodu girin veya kartinizi okutun.'], 409);
        }
        $pass->prepare("UPDATE customers SET password_hash=?, first_name=COALESCE(NULLIF(?,''), first_name),
                               updated_at=NOW() WHERE id=?")
             ->execute([password_hash($pw, PASSWORD_DEFAULT), $first, (int)$row['id']]);
        $customerId = (int)$row['id'];
        audit('guest.claim', $phone, ['customer' => $customerId]);
    } else {
        if ($first === '') fail('Ad zorunlu');
        $qr = bin2hex(random_bytes(16));
        $pass->prepare(
            "INSERT INTO customers (first_name, last_name, phone, email, birth_date, password_hash,
                 qr_uid, is_verified, is_active, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,0,1,NOW(),NOW())")
             ->execute([$first,
                        trim((string)($in['last_name'] ?? '')) ?: null,
                        $phone,
                        trim((string)($in['email'] ?? '')) ?: null,
                        preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)($in['birth_date'] ?? ''))
                            ? $in['birth_date'] : null,
                        password_hash($pw, PASSWORD_DEFAULT), $qr]);
        $customerId = (int)$pass->lastInsertId();
        audit('guest.register', $phone, ['customer' => $customerId]);
    }

    $session = guest_session_new($pass, $customerId, (string)($in['device'] ?? ''));
    guest_attempt($pass, 'register', $phone, true);
    $st = $pass->prepare("SELECT * FROM customers WHERE id=?");
    $st->execute([$customerId]);
    out(['ok' => true, 'token' => $session['token'],
         'expires_in_days' => $session['expires_in_days'],
         'guest' => guest_public($st->fetch())]);
} catch (Throwable $e) {
    error_log('guest register: ' . $e->getMessage());
    fail('Kayit tamamlanamadi', 502);
}
