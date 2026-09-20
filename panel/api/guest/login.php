<?php
/**
 * Phone + password, and one deliberately unhelpful error message.
 *
 * "Bu numara kayitli degil" would turn this endpoint into a directory of who
 * has a NOKTA account, so a wrong password and an unknown number get the same
 * answer. The app tells the guest to check both, which is all it honestly
 * knows.
 *
 * A guest whose row has no password at all — enrolled at a counter and never
 * signed up — is answered with NEEDS_REGISTER so the app can send them to the
 * claim flow instead of letting them retype a password they never set. That
 * does reveal that the number is known to the platform. It is a deliberate
 * trade: without it every till-enrolled guest hits a dead end on the login
 * screen and never reaches the app at all, and the fact leaked is one a
 * restaurant already knows.
 */
require_once __DIR__ . '/../../lib/guest.php';
guest_cors();
guest_require_post();

$in    = json_in();
$pass  = guest_pass();
$phone = np_tr_phone((string)($in['phone'] ?? ''));
$pw    = (string)($in['password'] ?? '');
if (!preg_match('/^5\d{9}$/', $phone)) fail('Telefon 5 ile baslayan 10 hane olmali');
if ($pw === '') fail('Sifre gerekli');

guest_throttle($pass, 'login', $phone);

try {
    $variants = np_phone_variants($phone);
    $ph = implode(',', array_fill(0, count($variants), '?'));
    $st = $pass->prepare("SELECT * FROM customers WHERE phone IN ($ph)
                            AND COALESCE(is_active,1)=1 LIMIT 1");
    $st->execute($variants);
    $row = $st->fetch() ?: null;

    if ($row && empty($row['password_hash'])) {
        guest_attempt($pass, 'login', $phone, false);
        out(['ok' => false, 'code' => 'NEEDS_REGISTER',
             'error' => 'Bu numaranin henuz sifresi yok. Kayit ol adimini tamamlayin.'], 409);
    }

    /* Verify even when there is no row, against a throwaway hash, so a missing
       number and a wrong password take the same time to answer. Otherwise the
       timing alone rebuilds the directory this endpoint refuses to be. */
    $hash = $row['password_hash'] ?? '$2y$10$usesomesillystringfoorrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';
    if (!password_verify($pw, $hash) || !$row) {
        guest_attempt($pass, 'login', $phone, false);
        fail('Telefon veya sifre hatali', 401);
    }

    if (password_needs_rehash($row['password_hash'], PASSWORD_DEFAULT)) {
        $pass->prepare("UPDATE customers SET password_hash=? WHERE id=?")
             ->execute([password_hash($pw, PASSWORD_DEFAULT), (int)$row['id']]);
    }

    $session = guest_session_new($pass, (int)$row['id'], (string)($in['device'] ?? ''));
    guest_attempt($pass, 'login', $phone, true);
    out(['ok' => true, 'token' => $session['token'],
         'expires_in_days' => $session['expires_in_days'],
         'guest' => guest_public($row)]);
} catch (Throwable $e) {
    error_log('guest login: ' . $e->getMessage());
    fail('Giris yapilamadi', 502);
}
