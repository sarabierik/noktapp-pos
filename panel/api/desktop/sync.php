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

    } elseif ($entity === 'loyalty_programs') {
        /* The campaign definitions behind the cards.
         *
         * NOT written into pass_db.loyalty_programs. That table's primary key
         * is `id` alone and it auto-increments per database, so every desktop
         * till has a programme 1, 2, 3 of its own. Writing a till's local id
         * straight in would let one restaurant's campaign overwrite another
         * restaurant's - silently, and with the guest's card still pointing at
         * the row. So desktop tenants get their own table, keyed by the pair
         * that is actually unique: (tenant, the till's own program id).
         *
         * Legacy web-POS tenants keep using loyalty_programs exactly as before
         * and are untouched by any of this.
         */
        $pass = pass_db();
        if ($pass) {
            try {
                $pass->exec(
                    "CREATE TABLE IF NOT EXISTS `np_tenant_programs` (
                       `tenant_id`     int(11) NOT NULL,
                       `program_id`    int(10) UNSIGNED NOT NULL,
                       `product_id`    int(10) UNSIGNED DEFAULT NULL,
                       `title`         varchar(190) NOT NULL,
                       `target_count`  int(10) UNSIGNED NOT NULL DEFAULT 10,
                       `reward_text`   varchar(190) NOT NULL,
                       `product_name`  varchar(190) DEFAULT NULL,
                       `product_price` decimal(10,2) DEFAULT NULL,
                       `is_active`     tinyint(1) NOT NULL DEFAULT 1,
                       `updated_at`    datetime NOT NULL DEFAULT current_timestamp()
                                       ON UPDATE current_timestamp(),
                       PRIMARY KEY (`tenant_id`,`program_id`)
                     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

                $st = $pass->prepare(
                    "INSERT INTO np_tenant_programs
                        (tenant_id, program_id, product_id, title, target_count, reward_text,
                         product_name, product_price, is_active, updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,NOW())
                     ON DUPLICATE KEY UPDATE product_id=VALUES(product_id), title=VALUES(title),
                         target_count=VALUES(target_count), reward_text=VALUES(reward_text),
                         product_name=VALUES(product_name), product_price=VALUES(product_price),
                         is_active=VALUES(is_active), updated_at=NOW()");
                foreach (($item['payload']['programs'] ?? []) as $pr) {
                    $pid = (int)($pr['id'] ?? 0);
                    if ($pid <= 0) continue;
                    $st->execute([
                        $t['id'], $pid,
                        isset($pr['product_id']) && $pr['product_id'] !== null ? (int)$pr['product_id'] : null,
                        mb_substr((string)($pr['title'] ?? ''), 0, 190),
                        max(1, (int)($pr['target_count'] ?? 10)),
                        mb_substr((string)($pr['reward_text'] ?? ''), 0, 190),
                        isset($pr['product_name']) ? mb_substr((string)$pr['product_name'], 0, 190) : null,
                        isset($pr['product_price']) ? (float)$pr['product_price'] : null,
                        !empty($pr['is_active']) ? 1 : 0,
                    ]);
                }
            } catch (Throwable $e) { error_log('program mirror: ' . $e->getMessage()); }
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
