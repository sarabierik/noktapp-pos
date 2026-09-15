<?php
/**
 * "What have you got of mine?"
 *
 *   POST { client_id, licence_key, device_id }
 *   -> { ok:true, backups:[ {id, filename, size_bytes, sha256, created_at} ] }
 *
 * The till has just been reinstalled on a new PC, or the old one's disk is
 * gone, and this is the first thing it asks. Newest first, because the answer
 * is almost always "last night".
 *
 * No path. Where a file sits on our server is not the till's business, it is
 * one more thing to keep in step if the layout ever changes, and it is exactly
 * what somebody poking at this endpoint would most like to be told.
 *
 * Rows whose file is not actually on disk are left out. A listing is an offer,
 * and offering a night we cannot hand over sends the till - and the person
 * waiting on it - down a road that ends in a 404. The vendor still sees those
 * rows on Yedekler, marked as missing, because for him the gap IS the news.
 */
require_once __DIR__ . '/../../lib/api.php';
require_once __DIR__ . '/../../lib/backup.php';

$in = json_in();
$t = require_licence($in);
touch_device((int) $t['id'], $in);

$rows = all('SELECT id, tenant_id, filename, path, size_bytes, sha256, created_at
               FROM np_backups WHERE tenant_id = ?
              ORDER BY id DESC LIMIT ' . BACKUP_LIST_MAX, [$t['id']]);

$backups = [];
foreach ($rows as $r) {
    if (backup_path($r) === null) continue;
    $backups[] = [
        'id'         => (int) $r['id'],
        'filename'   => $r['filename'],
        'size_bytes' => (int) $r['size_bytes'],
        'sha256'     => $r['sha256'],
        'created_at' => $r['created_at'],
    ];
}

out(['ok' => true, 'backups' => $backups]);
