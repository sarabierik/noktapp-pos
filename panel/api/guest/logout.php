<?php
/** End this session. `all: true` ends the ones on the guest's other phones too. */
require_once __DIR__ . '/../../lib/guest.php';
guest_cors();
guest_require_post();
$me   = guest_auth();
$pass = guest_pass();
$in   = json_in();

try {
    if (!empty($in['all'])) {
        $pass->prepare("DELETE FROM np_guest_sessions WHERE customer_id=?")->execute([(int)$me['id']]);
    } else {
        $pass->prepare("DELETE FROM np_guest_sessions WHERE token_hash=?")->execute([$me['__token_hash']]);
    }
} catch (Throwable $e) { error_log('guest logout: ' . $e->getMessage()); }
out(['ok' => true]);
