<?php
/**
 * "Give me that one back."
 *
 *   POST { client_id, licence_key, device_id, id }
 *   -> the gzipped dump itself, streamed, with Content-Length and
 *      X-Backup-Sha256 on it. Errors are JSON, like every other endpoint.
 *
 * This is the far end of the nightly upload and the only reason the upload is
 * worth doing. The till checks the sha256 against the bytes it received before
 * it does anything with them - what it is about to overwrite is a live
 * restaurant's database, and half a file that arrived through a hotel wifi
 * looks exactly like a whole one until you hash it.
 *
 * The panel never pushes a restore. It hands over a file when it is asked; the
 * decision to overwrite a working database belongs to the person standing in
 * front of the machine, not to a server in another city.
 *
 * An id belonging to somebody else gets the same 404 as an id that has never
 * existed. Two different refusals would turn this into an oracle: walk the
 * integers, and "bulunamadi" versus "size ait degil" quietly maps out which
 * restaurants back up and how often. backup_find() makes that structural - the
 * tenant is in the WHERE clause, so there is no second branch to keep in step.
 */
require_once __DIR__ . '/../../lib/api.php';
require_once __DIR__ . '/../../lib/backup.php';

/* A month-old dump over a village ADSL line takes as long as it takes; the
   default 30 seconds would cut the restore off halfway and the till would have
   no way to tell that from a corrupt backup. */
@set_time_limit(0);

$in = json_in();
$t = require_licence($in);

/* After the licence check, so a restaurant with a valid key is never locked
   out by whatever else shares its IP, and before a single byte is read: this
   is the most expensive thing the panel will do for an unauthenticated-ish
   caller, and it is the one worth hammering if you want our customers' data. */
rate_limit('backup_get', 30, 300);

touch_device((int) $t['id'], $in);

$b = backup_find((int) ($in['id'] ?? 0), (int) $t['id']);
if (!$b) fail('Yedek bulunamadi', 404);

$path = backup_path($b);
if ($path === null) fail('Yedek dosyasi sunucuda bulunamadi', 410);

$sha = backup_verify($b, $path);
if ($sha === null) fail('Yedek dosyasi bozulmus - bu yedekten geri donulmemeli', 500);

/* Who took a copy of a restaurant's database, and when. The till is acting for
   the restaurant itself here, so the actor is the machine that asked. */
$GLOBALS['np_actor'] = 'kasa:' . substr((string) ($in['device_id'] ?? ''), 0, 64);
audit('desktop.backup_download', $b['filename'],
      ['backup' => (int) $b['id'], 'size' => (int) $b['size_bytes']], (int) $t['id']);

backup_send($b, $path, $sha);
