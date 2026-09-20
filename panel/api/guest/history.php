<?php
/**
 * Gecmis — what actually happened, across every restaurant.
 *
 * The source is np_guest_events, which the tills mirror up: a stamp is written
 * at the counter on the restaurant's own PC, and a copy of that row - this
 * guest's rows only, last fifty per restaurant - comes here with the balance.
 * Nothing on this screen is derived or estimated; if a line is here, a cashier
 * put it there.
 *
 * A panel where no till has pushed events yet has no table at all, and the
 * honest answer to "what happened" is then an empty list rather than a 500.
 */
require_once __DIR__ . '/../../lib/guest.php';
guest_cors();
$me   = guest_auth();
$pass = guest_pass();

$in    = array_merge($_GET, json_in());
$limit = max(1, min(200, (int)($in['limit'] ?? 100)));

$rows = [];
try {
    $st = $pass->prepare(
        "SELECT tenant_id, program_id, kind, qty, product_name, program_title, happened_at
           FROM np_guest_events
          WHERE customer_id=?
          ORDER BY happened_at DESC, event_id DESC
          LIMIT $limit");
    $st->execute([(int)$me['id']]);
    $rows = $st->fetchAll();
} catch (Throwable $e) {
    $rows = [];
}

$names = guest_tenant_names(array_column($rows, 'tenant_id'));
$out = [];
foreach ($rows as $r) {
    $t = (int)$r['tenant_id'];
    $out[] = [
        'tenant_id'    => $t,
        'restaurant'   => $names[$t]['name'] ?? 'NOKTApp restorani',
        'program_id'   => (int)$r['program_id'],
        'program_title'=> $r['program_title'],
        'kind'         => $r['kind'],          // stamp | reward | adjust
        'qty'          => (int)$r['qty'],
        'product_name' => $r['product_name'],
        'happened_at'  => $r['happened_at'],
    ];
}
out(['ok' => true, 'events' => $out]);
