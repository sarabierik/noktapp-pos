<?php
/**
 * Kesfet — the campaigns a guest could be collecting but is not yet.
 *
 * Without this the app opens empty for everybody who has just signed up: they
 * have no cards, so Kartlarim is blank, and nothing on screen explains what the
 * app is for. This is the answer to "where do I use this".
 *
 * Only ACTIVE campaigns at active tenants with a live licence, and only the
 * campaign text — nothing about the restaurant beyond its name and city, and
 * nothing about any other guest. Requires a session: this is a member list, not
 * an open directory to be scraped.
 */
require_once __DIR__ . '/../../lib/guest.php';
guest_cors();
$me   = guest_auth();
$pass = guest_pass();

$rows = [];
try {
    $rows = $pass->query(
        "SELECT tenant_id, program_id, title, target_count, reward_text, product_name
           FROM np_tenant_programs
          WHERE is_active=1
          ORDER BY tenant_id, program_id")->fetchAll();
} catch (Throwable $e) {
    /* No desktop tenant has pushed a campaign to this panel yet. */
    $rows = [];
}

/* Only tenants that are actually trading. A suspended licence or a closed
   restaurant on this list is a guest walking to a door that is shut. */
$ids = array_values(array_unique(array_map('intval', array_column($rows, 'tenant_id'))));
$live = [];
if ($ids) {
    $in = implode(',', array_fill(0, count($ids), '?'));
    foreach (all("SELECT t.id, t.company_name, t.city
                    FROM np_tenants t JOIN np_licences l ON l.tenant_id = t.id
                   WHERE t.id IN ($in) AND t.is_active=1
                     AND l.status <> 'suspended'
                     AND (l.expires_at IS NULL
                          OR l.expires_at > DATE_SUB(NOW(), INTERVAL COALESCE(l.grace_days,0) DAY))",
                 $ids) as $r) {
        $live[(int)$r['id']] = $r;
    }
}

/* Which of these the guest already holds, so the app can mark them rather than
   offering somebody a card they are halfway through. */
$mine = [];
try {
    foreach (guest_cards($pass, (int)$me['id']) as $c) {
        $mine[$c['tenant_id'] . ':' . $c['program_id']] = true;
    }
} catch (Throwable $e) {}

$out = [];
foreach ($rows as $r) {
    $t = (int)$r['tenant_id'];
    if (!isset($live[$t])) continue;
    if (!isset($out[$t])) {
        $out[$t] = ['tenant_id' => $t, 'restaurant' => $live[$t]['company_name'],
                    'city' => $live[$t]['city'], 'programs' => []];
    }
    $out[$t]['programs'][] = [
        'program_id'   => (int)$r['program_id'],
        'title'        => $r['title'],
        'target_count' => (int)$r['target_count'],
        'reward_text'  => $r['reward_text'],
        'product_name' => $r['product_name'],
        'already_mine' => isset($mine[$t . ':' . (int)$r['program_id']]) ? 1 : 0,
    ];
}
out(['ok' => true, 'restaurants' => array_values($out)]);
