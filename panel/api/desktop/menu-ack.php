<?php
/**
 * The till reporting what it did with a published menu.
 *
 *   POST /api/desktop/menu-ack.php
 *   { client_id, licence_key, device_id,
 *     version, applied_at, counts:{inserted,updated,deactivated} }
 *
 * This is the only thing that tells head office which branch is on which
 * version. Without it a manager looking at ten branches can see that a menu
 * was published and nothing at all about whether it landed - and a till that
 * silently failed to apply version 7 looks exactly like one that applied it.
 *
 * A till with no branch (single shop, which is nearly every install) is
 * accepted and recorded nowhere: there is no branch row to record it against
 * and it changes nothing for that customer.
 */
require_once __DIR__ . '/../../lib/api.php';
require_once __DIR__ . '/../../lib/chain.php';

$in = chain_credentials(json_in());
$t  = require_licence($in);
touch_device((int) $t['id'], $in);

$tenantId = (int) $t['id'];
$deviceId = substr((string) ($in['device_id'] ?? ''), 0, 64);
$version  = (int) ($in['version'] ?? 0);
if ($version <= 0) fail('Gecersiz menu surumu', 400);

$branch = null;
if (!empty($in['branch_code'])) $branch = chain_bind_device($tenantId, $deviceId, (string) $in['branch_code']);
if (!$branch) $branch = chain_branch_of_device($tenantId, $deviceId);

if ($branch) {
    $c = is_array($in['counts'] ?? null) ? $in['counts'] : [];
    $counts = sprintf('+%d ~%d -%d',
        (int) ($c['inserted'] ?? 0), (int) ($c['updated'] ?? 0), (int) ($c['deactivated'] ?? 0));

    /* The till's own clock, not ours: it is the one that says when the branch
       actually started selling these prices. Anything unparseable falls back
       to now rather than writing a zero date nobody can read. */
    $appliedAt = null;
    if (!empty($in['applied_at'])) {
        $ts = strtotime((string) $in['applied_at']);
        if ($ts) $appliedAt = date('Y-m-d H:i:s', $ts);
    }

    /* Never move the recorded version backwards. Two tills at one branch ack
       independently, and an old one still catching up must not make the branch
       look like it regressed. */
    q('UPDATE np_branches SET menu_version = GREATEST(menu_version, ?), menu_applied_at = ?, menu_counts = ?
        WHERE id = ? AND tenant_id = ?',
      [$version, $appliedAt ?: date('Y-m-d H:i:s'), $counts, $branch['id'], $tenantId]);

    $GLOBALS['np_actor'] = 'sube:' . $branch['code'];
    audit('chain.menu_ack', $branch['code'], ['version' => $version, 'counts' => $counts]);
}

out([
    'ok'        => true,
    'version'   => $version,
    'branch_id' => $branch ? (int) $branch['id'] : null,
    'recorded'  => $branch !== null,
]);
