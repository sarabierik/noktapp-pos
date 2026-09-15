<?php
/**
 * The master menu pull.
 *
 *   GET  /api/desktop/menu.php?since=<applied_version>
 *   POST /api/desktop/menu.php   { client_id, licence_key, device_id, since }
 *
 * The panel never pushes. This is the till asking, on the back of its existing
 * heartbeat, whether head office has published anything since the version it
 * is running. A branch behind a hotel NAT, or switched off since Friday, gets
 * the same correct answer when it comes back as one that never went away.
 *
 * Both verbs are accepted because the contract writes it as a GET with the
 * version in the query while the till's own HTTP helper only POSTs JSON.
 * `since` may ride in the query - it is not a secret. The licence key may not:
 * it comes from the JSON body, Basic auth, or X-Licence-Key, exactly as the
 * other desktop endpoints authenticate.
 */
require_once __DIR__ . '/../../lib/api.php';
require_once __DIR__ . '/../../lib/chain.php';

$in = chain_credentials(json_in());
$t  = require_licence($in);
touch_device((int) $t['id'], $in);

$tenantId = (int) $t['id'];
$deviceId = substr((string) ($in['device_id'] ?? ''), 0, 64);

/* A till that has been given its branch code binds itself here. Head office
   reads the code out over the phone and never has to touch the panel again. */
$branch = null;
if (!empty($in['branch_code'])) {
    $branch = chain_bind_device($tenantId, $deviceId, (string) $in['branch_code']);
}
if (!$branch) $branch = chain_branch_of_device($tenantId, $deviceId);

/* isset, not ??, so that since=0 in the query is honoured rather than falling
   through to the body and quietly turning a full pull into an incremental one. */
$since = (int) (isset($_GET['since']) ? $_GET['since'] : ($in['since'] ?? 0));
if ($since < 0) $since = 0;

out(chain_menu_for($tenantId, $branch, $since) + ['server_time' => date('c')]);
