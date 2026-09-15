<?php
/** Summaries and day-end figures pushed up by the restaurant PC. */
require_once __DIR__ . '/../../lib/api.php';
require_once __DIR__ . '/../../lib/rapor.php';
$in = json_in();
$t = require_licence($in);
touch_device((int)$t['id'], $in);

$pushDevice = substr((string)($in['device_id'] ?? ''), 0, 64);
$accepted = [];
foreach (($in['items'] ?? []) as $item) {
    $entity = substr((string)($item['entity'] ?? ''), 0, 48);
    $eid    = substr((string)($item['entity_id'] ?? ''), 0, 64);
    if ($entity === '' || $eid === '') continue;
    $payload = json_encode($item['payload'] ?? null, JSON_UNESCAPED_UNICODE);

    if ($entity === 'loyalty_cards') {
        /* Mirror the till's card balances back into the shared loyalty
           database, so the guest's Pass app shows the same numbers. The till
           is the source of truth for its own restaurant - it wrote these while
           the guest was standing at the counter - so we take what it says. */
        $pass = pass_db();
        $p = $item['payload'] ?? [];
        $customerId = (int)($p['customer_id'] ?? 0);
        if ($pass && $customerId > 0) {
            try {
                foreach (($p['cards'] ?? []) as $card) {
                    $pass->prepare(
                        "INSERT INTO loyalty_cards
                            (client_id, customer_id, program_id, progress_count, rewards_available,
                             rewards_used, created_at, updated_at)
                         VALUES (?,?,?,?,?,?,NOW(),NOW())
                         ON DUPLICATE KEY UPDATE progress_count=VALUES(progress_count),
                             rewards_available=VALUES(rewards_available),
                             rewards_used=VALUES(rewards_used), updated_at=NOW()")
                        ->execute([$t['id'], $customerId, (int)$card['program_id'],
                                   (int)$card['progress_count'], (int)$card['rewards_available'],
                                   (int)($card['rewards_used'] ?? 0)]);
                }
            } catch (Throwable $e) { error_log('loyalty mirror: ' . $e->getMessage()); }
        }
        q('INSERT INTO np_reports (tenant_id, entity, entity_id, payload) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE payload=VALUES(payload), created_at=NOW()',
          [$t['id'], $entity, $eid, $payload]);

    } elseif ($entity === 'qr_token_used') {
        /* A one-time code has been spent at this restaurant. Burn it centrally
           so it cannot be scanned again at another one. */
        $pass = pass_db();
        $token = (string)($item['payload']['token'] ?? $eid);
        if ($pass && preg_match('/^[a-f0-9]{64}$/i', $token)) {
            try {
                $pass->prepare("UPDATE loyalty_qr_tokens SET used_at=NOW(), used_by_client_id=?
                                 WHERE token=? AND used_at IS NULL")
                     ->execute([$t['id'], strtolower($token)]);
            } catch (Throwable $e) { error_log('qr burn: ' . $e->getMessage()); }
        }

    } elseif ($entity === 'qr_menu') {
        $p = $item['payload'] ?? [];
        $slug = substr((string)($p['settings']['slug'] ?? ''), 0, 120);
        if ($slug !== '') {
            q('INSERT INTO np_qr_menus (tenant_id, slug, payload) VALUES (?,?,?)
               ON DUPLICATE KEY UPDATE slug=VALUES(slug), payload=VALUES(payload), updated_at=NOW()',
              [$t['id'], $slug, $payload]);
        }
    } else {
        q('INSERT INTO np_reports (tenant_id, entity, entity_id, payload) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE payload=VALUES(payload), created_at=NOW()',
          [$t['id'], $entity, $eid, $payload]);

        if ($entity === 'daily_closing') {
            /*
             * The raw push stays exactly where it landed above; this only
             * materialises it into np_branch_days so head office can read ten
             * branches side by side without decoding nine hundred JSON blobs.
             *
             * np_reports never recorded WHO pushed a row, and the branch is a
             * property of the pushing device - so the device is written onto
             * the raw row here, and that is what lets the whole table be
             * rebuilt from source later, including after head office corrects
             * a till that was bound to the wrong branch.
             *
             * Guarded, and failure is silent: a panel whose code was updated
             * before sql/rapor_schema.sql was imported must still ACCEPT the
             * day-end. Losing the till's push because head office has not run
             * a migration would be a far worse failure than a screen that is
             * a day behind, and rapor_catch_up() picks it up afterwards.
             */
            try {
                $tid = (int) $t['id'];
                $branchId = rapor_resolve_branch($tid, is_array($item['payload'] ?? null) ? $item['payload'] : [], $pushDevice);
                q('UPDATE np_reports SET device_id=?, branch_id=? WHERE tenant_id=? AND entity=? AND entity_id=?',
                  [$pushDevice ?: null, $branchId, $tid, $entity, $eid]);
                $srcId = (int) val('SELECT id FROM np_reports WHERE tenant_id=? AND entity=? AND entity_id=?',
                                   [$tid, $entity, $eid]);
                rapor_materialise($tid, $branchId, $eid, $item['payload'] ?? [], $srcId ?: null);
            } catch (Throwable $e) {
                error_log('rapor materialise: ' . $e->getMessage());
            }
        }
    }
    $accepted[] = (int)($item['id'] ?? 0);
}
out(['ok' => true, 'accepted' => $accepted]);
