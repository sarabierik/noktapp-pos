<?php
/**
 * Karekod — the code the cashier scans.
 *
 * Two codes exist and they are not interchangeable:
 *
 *   qr_uid is permanent. It is what gets printed on a plastic card, and anyone
 *   who photographs it can present it for ever. The app shows it as a fallback
 *   only, never as the thing on screen at the counter.
 *
 *   A one-time token is what this endpoint mints: sixty-four hex characters,
 *   good for five minutes, and burned by the first till that spends it. The
 *   burn happens at the restaurant that used it, not here - the till writes the
 *   stamps first and tells us afterwards, so a dropped reply cannot cost the
 *   guest a scan.
 *
 * Five minutes is short on purpose. This is a screen held up at a counter, not
 * a link sent to somebody.
 */
require_once __DIR__ . '/../../lib/guest.php';
guest_cors();
guest_require_post();
$me   = guest_auth();
$pass = guest_pass();

/* A code per second is a person pressing refresh; a thousand is somebody
   filling loyalty_qr_tokens up. */
guest_throttle($pass, 'qr', (string)(int)$me['id']);

try {
    $token   = bin2hex(random_bytes(32));
    $seconds = 300;
    $expires = time() + $seconds;
    $pass->prepare("INSERT INTO loyalty_qr_tokens (token, customer_id, expires_at, expires_ts, created_at)
                    VALUES (?,?,?,?,NOW())")
         ->execute([$token, (int)$me['id'], date('Y-m-d H:i:s', $expires), $expires]);
    /* Old codes of this guest's own, spent or stale, are not evidence of
       anything once they are dead. */
    try {
        $pass->prepare("DELETE FROM loyalty_qr_tokens
                         WHERE customer_id=? AND expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)")
             ->execute([(int)$me['id']]);
    } catch (Throwable $e) {}
    guest_attempt($pass, 'qr', (string)(int)$me['id'], true);
    out(['ok' => true, 'token' => $token, 'expires_in' => $seconds,
         'expires_at' => date('c', $expires),
         'card_code' => $me['qr_uid'] ?? null]);
} catch (Throwable $e) {
    error_log('guest qr: ' . $e->getMessage());
    fail('Karekod uretilemedi', 502);
}
