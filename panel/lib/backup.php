<?php
/**
 * Handing a cloud backup back.
 *
 * api/desktop/backup.php has been taking a dump from every till every night
 * since the first release and nothing ever gave one back. The data was safe
 * and unreachable, which is the same as not having it - the one morning it is
 * needed, somebody is on the phone to us and the answer is "it is on the
 * server somewhere".
 *
 * Both ways out - the till asking with its licence key, the vendor clicking a
 * row on Yedekler - go through this file, because the three things that are
 * easy to get wrong are the same on both sides:
 *
 *   1. WHOSE file it is. One tenant-scoped lookup, and the answer for another
 *      restaurant's id is byte-for-byte the answer for an id that was never
 *      issued. Two different refusals would tell whoever is walking the ids
 *      which of their guesses landed.
 *   2. WHICH file on disk. np_backups.path is a column, and a column is data;
 *      handing data straight to readfile() is how a listing endpoint becomes a
 *      file-read endpoint. The path is rebuilt from config and the result is
 *      checked to be inside the backup directory before anything is opened.
 *   3. HOW it leaves. Streamed, never assembled in a variable: these are
 *      hundreds of megabytes and the panel lives on shared hosting with a
 *      memory_limit somebody else chose.
 */
require_once __DIR__ . '/db.php';

/** Newest first, and no more than a month of nights is ever worth offering. */
const BACKUP_LIST_MAX = 60;

/**
 * One backup row.
 *
 * $tenantId scopes it to that restaurant - pass null only for the vendor's own
 * admin session, which is allowed to reach any of them. Callers must give the
 * SAME refusal for null-because-not-yours as for null-because-no-such-id.
 */
function backup_find(int $id, ?int $tenantId): ?array {
    if ($id <= 0) return null;
    return $tenantId === null
        ? one('SELECT * FROM np_backups WHERE id=?', [$id])
        : one('SELECT * FROM np_backups WHERE id=? AND tenant_id=?', [$id, $tenantId]);
}

/**
 * The file behind a row, or null when there is nothing readable behind it.
 *
 * The stored path is a hint, not an instruction. The real path is rebuilt the
 * way backup.php built it - backup_dir / tenant id / filename - so a panel
 * whose database was restored onto a host with a different directory layout
 * still finds its files, and so a `path` that was edited by hand, by an import
 * or by anything else cannot point this at /etc/passwd.
 *
 * The stored value is only tried as a fallback, and then only if it resolves
 * INSIDE the backup directory. realpath() is what makes that check mean
 * something: '.../noktapp-backups/19/../../../etc/passwd' passes a naive
 * string comparison and fails this one.
 */
function backup_path(array $b): ?string {
    $root = realpath(rtrim((string) cfg('backup_dir'), '/'));
    if ($root === false) return null;

    $name = basename((string) ($b['filename'] ?? ''));
    $tried = [];
    if ($name !== '' && $name !== '.' && $name !== '..') {
        $tried[] = $root . '/' . (int) ($b['tenant_id'] ?? 0) . '/' . $name;
    }
    if (!empty($b['path'])) $tried[] = (string) $b['path'];

    foreach ($tried as $p) {
        $real = realpath($p);
        if ($real === false || !is_file($real) || !is_readable($real)) continue;
        if (strpos($real, $root . DIRECTORY_SEPARATOR) !== 0) continue;
        return $real;
    }
    return null;
}

/**
 * The sha256 to advertise, or null when the record and the file disagree.
 *
 * The till verifies this before it overwrites a live database, so it has to
 * describe the bytes that are about to leave THIS server, not the bytes that
 * arrived here months ago. Those are the same thing right up until the day
 * they are not - a half-written file from a disk that filled up, a truncated
 * copy from a migration - and that is precisely the day somebody is restoring
 * from it.
 *
 * So it is computed from disk every time. That reads the file twice, hashing
 * then streaming, which is the cost of the guarantee; hash_file() streams too,
 * so neither read costs memory. A row that has no stored hash (sha256 is
 * optional on the upload) still gets one - the till asked for a checksum and
 * "we never wrote one down" is not an answer it can verify anything with.
 */
function backup_verify(array $b, string $path): ?string {
    $sha = hash_file('sha256', $path);
    if ($sha === false) return null;
    $stored = (string) ($b['sha256'] ?? '');
    if ($stored !== '' && !hash_equals($stored, $sha)) {
        error_log('backup #' . (int) $b['id'] . ': stored sha256 ' . $stored . ' but disk has ' . $sha);
        return null;
    }
    return $sha;
}

/**
 * Send the file and stop.
 *
 * Not JSON, not base64. The upload endpoint gets away with base64 because it
 * is one file a night arriving at a machine with room; doing it in this
 * direction means holding the whole dump, plus a third again for the encoding,
 * in PHP's memory on a shared host - the request dies at memory_limit and the
 * restaurant is told nothing useful.
 *
 * The output buffers are torn down first for the same reason: an ob_start()
 * anywhere up the stack (a stray one in an include, zlib.output_compression)
 * would quietly accumulate the entire file in memory that we just took care
 * not to use. Length and checksum go in the headers, so the far end knows what
 * it is owed before the first byte and can tell a short read from a whole file.
 */
function backup_send(array $b, string $path, string $sha): void {
    $size = filesize($path);
    $name = basename((string) $b['filename']);

    while (ob_get_level() > 0) { @ob_end_clean(); }

    header('Content-Type: application/gzip');
    header('Content-Length: ' . $size);
    header('Content-Disposition: attachment; filename="' . $name . '"');
    header('X-Backup-Sha256: ' . $sha);
    header('X-Backup-Filename: ' . $name);
    header('X-Content-Type-Options: nosniff');
    /* A database dump has no business in any cache between here and there. */
    header('Cache-Control: no-store, private');

    readfile($path);
    exit;
}
