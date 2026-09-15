<?php
require_once __DIR__ . '/../lib/db.php';
session_name(cfg('app.session_name'));
session_start();

/*
 * Never show a blank page.
 *
 * On shared hosting display_errors is off, so a fatal - a missing table, a
 * typo in a query - renders the header and then simply stops. You are left
 * looking at an empty panel with nothing to go on. These two handlers turn
 * that into a readable message, and the message is the difference between
 * "it is broken" and "np_reports does not exist".
 */
function np_fail_box(string $title, string $detail): void {
    echo '<div style="margin:22px;padding:16px 18px;border:1px solid #F5C6C2;background:#FDECEA;'
       . 'border-radius:10px;font:14px/1.5 \'Segoe UI\',system-ui,sans-serif;color:#B42318">'
       . '<b>' . htmlspecialchars($title) . '</b><br>'
       . '<span style="color:#7a1c14">' . htmlspecialchars($detail) . '</span>'
       . '<div style="margin-top:10px;color:#8a5a55;font-size:12.5px">'
       . 'Tablo eksikse: phpMyAdmin -> panel veritabani -> sql/panel_schema.sql dosyasini import edin.'
       . '</div></div>';
}

set_exception_handler(function (Throwable $e) {
    http_response_code(500);
    error_log('panel: ' . $e->getMessage());
    np_fail_box('Panel bir hata ile karsilasti', $e->getMessage());
});

register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        np_fail_box('Panel durdu', $e['message'] . ' (' . basename($e['file']) . ':' . $e['line'] . ')');
    }
});

function admin_user(): ?array { return $_SESSION['admin'] ?? null; }
function require_admin(): array {
    $u = admin_user();
    if (!$u) { header('Location: index.php?p=login'); exit; }
    return $u;
}
function csrf(): string {
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));
    return $_SESSION['csrf'];
}
function check_csrf(): void {
    if (($_POST['csrf'] ?? '') !== ($_SESSION['csrf'] ?? 'x')) { http_response_code(400); exit('Oturum dogrulanamadi'); }
}
function e($s): string { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
function money($n): string { return number_format((float)$n, 2, ',', '.'); }
