<?php
/**
 * Profil. GET reads it, POST changes the parts a guest owns.
 *
 * The phone number is NOT one of them. It is the identity every till resolves
 * against and the key the restaurant enrolled; letting the app rewrite it would
 * let a guest walk onto somebody else's account by typing their number. A
 * change of number is a support job, deliberately.
 *
 * A password change requires the current password even though the caller is
 * already holding a valid session - a phone left unlocked on a table should not
 * be enough to lock its owner out.
 */
require_once __DIR__ . '/../../lib/guest.php';
guest_cors();
$me   = guest_auth();
$pass = guest_pass();

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    out(['ok' => true, 'guest' => guest_public($me)]);
}

$in = json_in();
$set = [];
$arg = [];

if (array_key_exists('first_name', $in)) {
    $v = trim((string)$in['first_name']);
    if ($v === '') fail('Ad bos olamaz');
    $set[] = 'first_name=?'; $arg[] = mb_substr($v, 0, 100);
}
if (array_key_exists('last_name', $in)) {
    $set[] = 'last_name=?'; $arg[] = mb_substr(trim((string)$in['last_name']), 0, 100) ?: null;
}
if (array_key_exists('email', $in)) {
    $v = trim((string)$in['email']);
    if ($v !== '' && !filter_var($v, FILTER_VALIDATE_EMAIL)) fail('E-posta gecersiz');
    $set[] = 'email=?'; $arg[] = $v ?: null;
}
if (array_key_exists('birth_date', $in)) {
    $v = trim((string)$in['birth_date']);
    if ($v !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $v)) fail('Dogum tarihi YYYY-AA-GG olmali');
    $set[] = 'birth_date=?'; $arg[] = $v ?: null;
}

$newPw = (string)($in['new_password'] ?? '');
if ($newPw !== '') {
    if (mb_strlen($newPw) < 6) fail('Yeni sifre en az 6 karakter olmali');
    $current = (string)($in['current_password'] ?? '');
    if (empty($me['password_hash']) || !password_verify($current, $me['password_hash'])) {
        guest_throttle($pass, 'pwchange', (string)(int)$me['id']);
        guest_attempt($pass, 'pwchange', (string)(int)$me['id'], false);
        fail('Mevcut sifre hatali', 403);
    }
    $set[] = 'password_hash=?'; $arg[] = password_hash($newPw, PASSWORD_DEFAULT);
}

if (!$set) fail('Degisecek bir sey gonderilmedi');

try {
    $arg[] = (int)$me['id'];
    $pass->prepare("UPDATE customers SET " . implode(', ', $set) . ", updated_at=NOW() WHERE id=?")
         ->execute($arg);
    /* A password change ends every OTHER session, because the usual reason to
       change one is that somebody else has it. This phone keeps its own. */
    if ($newPw !== '') {
        $pass->prepare("DELETE FROM np_guest_sessions WHERE customer_id=? AND token_hash<>?")
             ->execute([(int)$me['id'], $me['__token_hash']]);
    }
    $st = $pass->prepare("SELECT * FROM customers WHERE id=?");
    $st->execute([(int)$me['id']]);
    out(['ok' => true, 'guest' => guest_public($st->fetch())]);
} catch (Throwable $e) {
    error_log('guest profile: ' . $e->getMessage());
    fail('Profil kaydedilemedi', 502);
}
