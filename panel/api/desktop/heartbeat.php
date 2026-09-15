<?php
/** Every half hour the till says hello; that is what keeps its offline grace
 *  window open and what fills the "last seen" column in the panel. */
require_once __DIR__ . '/../../lib/api.php';
require_once __DIR__ . '/../../lib/teshis.php';
$in = json_in();
$t = require_licence($in);
touch_device((int)$t['id'], $in);

/*
 * The diagnostics document rides here and nowhere else.
 *
 * It is OPTIONAL and ADDITIVE: the request keeps every field it had, the
 * response is not touched at all, and a till that has never heard of `diag` -
 * which is every till in the field until it updates - goes through this file
 * exactly as it did before. teshis_store() swallows its own errors for the
 * same reason: this endpoint is the licence lifeline for every installed till,
 * and a bad diagnostics row must cost a support screen, never a restaurant's
 * ability to open in the morning.
 */
if (!empty($in['diag']) && is_array($in['diag'])) {
    teshis_store((int) $t['id'], (string) ($in['device_id'] ?? ''), $in['diag']);
}

if (!empty($in['stats']) && is_array($in['stats'])) {
    q('INSERT INTO np_reports (tenant_id, entity, entity_id, payload)
       VALUES (?, "heartbeat", ?, ?)
       ON DUPLICATE KEY UPDATE payload=VALUES(payload), created_at=NOW()',
      [$t['id'], date('Y-m-d'), json_encode($in['stats'], JSON_UNESCAPED_UNICODE)]);
}
out(['ok' => true, 'licence' => licence_payload($t), 'server_time' => date('c')]);
