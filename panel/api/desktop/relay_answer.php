<?php
/** The PC's answer travels back the same way, and the waiting phone picks it up. */
require_once __DIR__ . '/../../lib/api.php';
$in = json_in();
$t = require_licence($in);

$id = (int)($in['message_id'] ?? 0);
if (!$id) fail('message_id gerekli');
q("UPDATE np_relay_messages SET status='answered', answer_status=?, answer_body=?, answered_at=NOW()
    WHERE id=? AND tenant_id=?",
  [(int)($in['status'] ?? 200), json_encode($in['body'] ?? null, JSON_UNESCAPED_UNICODE), $id, $t['id']]);
out(['ok' => true]);
