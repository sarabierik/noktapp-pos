<?php
/**
 * Kartlarim — every campaign this guest is collecting, at every restaurant.
 *
 * This is the screen the whole chain exists for. The till writes the stamp, the
 * till pushes the balance AND the campaign it belongs to, the panel mirrors
 * both, and this endpoint joins them back together. Before the campaign half of
 * that existed, this query could only return "4 of something at restaurant 88"
 * and the app had no choice but to show an empty list.
 *
 * Grouped by restaurant, because that is how a guest thinks about it: I have
 * two cards at the pizza place and one at the bar down the road.
 */
require_once __DIR__ . '/../../lib/guest.php';
guest_cors();
$me   = guest_auth();
$pass = guest_pass();

try {
    $cards = guest_cards($pass, (int)$me['id']);
} catch (Throwable $e) {
    error_log('guest cards: ' . $e->getMessage());
    fail('Kartlar okunamadi', 502);
}

$byTenant = [];
foreach ($cards as $c) {
    $k = $c['tenant_id'];
    if (!isset($byTenant[$k])) {
        $byTenant[$k] = ['tenant_id' => $k, 'restaurant' => $c['restaurant'],
                         'city' => $c['city'], 'cards' => []];
    }
    $byTenant[$k]['cards'][] = $c;
}

$ready = 0;
foreach ($cards as $c) $ready += $c['rewards_available'];

out(['ok' => true,
     'guest'        => guest_public($me),
     'restaurants'  => array_values($byTenant),
     'cards'        => $cards,           // flat, for a client that wants one list
     'rewards_ready'=> $ready]);
