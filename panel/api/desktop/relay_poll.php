<?php
/**
 * The restaurant PC asks: "is there anything for me?" and holds the line for a
 * few seconds. Nothing is opened on the restaurant's router - the connection is
 * always outbound from them, which is why this works behind any modem.
 */
require_once __DIR__ . '/../../lib/api.php';
@set_time_limit(40);
$in = json_in();
$t = require_licence($in);
touch_device((int)$t['id'], $in);

$after = (int)($in['after_id'] ?? 0);
$wait  = max(0, min(25, (int)($in['wait'] ?? 20)));
$deadline = time() + $wait;

// anything that has been sitting too long is not worth delivering any more
q("UPDATE np_relay_messages SET status='expired'
    WHERE tenant_id=? AND status='queued' AND created_at < DATE_SUB(NOW(), INTERVAL ? SECOND)",
  [$t['id'], (int) cfg('app.relay_ttl')]);

do {
    $rows = all("SELECT id, method, path, body, authorization, device_id
                   FROM np_relay_messages
                  WHERE tenant_id=? AND status='queued' AND id > ?
                  ORDER BY id LIMIT 20", [$t['id'], $after]);
    if ($rows) break;
    if (time() >= $deadline) break;
    usleep(700000);
} while (true);

$out = [];
foreach ($rows as $r) {
    q("UPDATE np_relay_messages SET status='taken', taken_at=NOW() WHERE id=?", [$r['id']]);
    $out[] = [
        'id' => (int)$r['id'],
        'method' => $r['method'],
        'path' => $r['path'],
        'body' => $r['body'] ? json_decode($r['body'], true) : null,
        'authorization' => $r['authorization'],
        'device_id' => $r['device_id'],
    ];
}
out(['ok' => true, 'messages' => $out, 'server_time' => date('c')]);
