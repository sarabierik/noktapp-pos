<?php
/**
 * The vendor's own copy of a restaurant's backup.
 *
 * This is the phone-call path: the owner rings, his PC is dead or his disk is
 * wiped, and somebody here has to get last night's database to him. Before
 * this existed the only way was an SSH session and scp, which meant it could
 * only be done by the one person who had the server password.
 *
 * It is a door in index.php, not a file of its own, on purpose. A second
 * entrance is a second place to get require_admin() right, and the one that
 * gets forgotten is the one that ends up serving a restaurant's entire
 * database to anybody who knows the address. Hooked in after require_admin()
 * and before layout_head(), so by the time this runs the session has already
 * been checked by the same gate as every other screen, and no HTML has gone
 * out that would stop the file being sent.
 */
require_once __DIR__ . '/../lib/backup.php';

/**
 * ?p=backups&download=<id> sends a file; everything else returns immediately.
 *
 * The vendor may reach any tenant's backup - that is the job - so this passes
 * null for the tenant scope. What it may never be is a URL that works without
 * the session, which is why the file is read by PHP here rather than linked to
 * on disk: the backups live outside public_html and there is no arrangement of
 * Apache config, symlink or alias in this codebase that can make one of them
 * fetchable by anybody who has not logged in.
 */
function backup_admin_export(): void {
    if (($_GET['p'] ?? '') !== 'backups') return;
    $id = (int) ($_GET['download'] ?? 0);
    if ($id <= 0) return;

    $b = backup_find($id, null);
    if (!$b) { http_response_code(404); exit('Yedek bulunamadi'); }

    $path = backup_path($b);
    if ($path === null) {
        /* The record is real and the file is not. Say which file, because the
           next thing that happens is somebody looking for it on the server. */
        http_response_code(410);
        exit('Yedek kaydi duruyor ama dosya sunucuda yok: ' . $b['filename']);
    }

    $sha = backup_verify($b, $path);
    if ($sha === null) {
        http_response_code(500);
        exit('Yedek dosyasi kayitli sha256 ile uyusmuyor. Bu dosyadan geri donulmemeli.');
    }

    /* Who took a copy of a restaurant's database, and when. A dump of somebody
       else's business leaving this server is the single most serious thing the
       panel can do, and the audit row is written BEFORE the bytes go out -
       backup_send() never returns, so anything after it would never run. */
    audit('backup.download', $b['filename'],
          ['backup' => (int) $b['id'], 'size' => (int) $b['size_bytes'], 'sha256' => $sha],
          (int) $b['tenant_id']);

    backup_send($b, $path, $sha);
}
