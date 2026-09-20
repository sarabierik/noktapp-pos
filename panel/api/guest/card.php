<?php
/**
 * One card, plus the movements behind it.
 *
 * The tenant and programme come from the request, which sounds like the hole
 * this API is careful not to have — but they are only ever used to FILTER the
 * guest's own rows. The customer id is still the one out of the token, so a
 * guest who guesses another restaurant's tenant id gets their own (empty) card
 * there and learns nothing.
 */
require_once __DIR__ . '/../../lib/guest.php';
guest_cors();
$me   = guest_auth();
$pass = guest_pass();

$in       = array_merge($_GET, json_in());
$tenantId = (int)($in['tenant_id'] ?? 0);
$programId= (int)($in['program_id'] ?? 0);
if ($tenantId <= 0 || $programId <= 0) fail('tenant_id ve program_id gerekli');

try {
    $card = null;
    foreach (guest_cards($pass, (int)$me['id']) as $c) {
        if ($c['tenant_id'] === $tenantId && $c['program_id'] === $programId) { $card = $c; break; }
    }
    if (!$card) fail('Kart bulunamadi', 404);

    $events = [];
    try {
        $st = $pass->prepare(
            "SELECT kind, qty, product_name, program_title, happened_at
               FROM np_guest_events
              WHERE customer_id=? AND tenant_id=? AND program_id=?
              ORDER BY happened_at DESC, event_id DESC LIMIT 50");
        $st->execute([(int)$me['id'], $tenantId, $programId]);
        $events = $st->fetchAll();
    } catch (Throwable $e) {
        /* The mirror table only exists once a till has pushed events. A card
           with no history yet is a card, not an error. */
        $events = [];
    }
    out(['ok' => true, 'card' => $card, 'events' => $events]);
} catch (Throwable $e) {
    error_log('guest card: ' . $e->getMessage());
    fail('Kart okunamadi', 502);
}
