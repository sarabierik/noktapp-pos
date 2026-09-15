<?php
/**
 * tani.php — one file that says why the panel is failing.
 *
 * A 500 with an empty body means PHP died before anything could be printed:
 * a missing include, a parse error, a database that will not open. The panel's
 * own error handlers cannot report that, because they are installed by a file
 * that never got to run. So this one has NO dependencies at all — it includes
 * nothing, and every check is wrapped — and it can therefore run when nothing
 * else can.
 *
 * Delete it when the panel is working again. It reveals no credentials: every
 * value is reported as present-or-missing, never printed.
 */
header('Content-Type: text/plain; charset=utf-8');
$root = __DIR__;

function line($k, $v) { printf("%-34s %s\n", $k, $v); }
function head($t) { echo "\n== $t ==\n"; }

echo "NOKTApp panel — tani\n";
line('Tarih', date('Y-m-d H:i:s'));
line('PHP', PHP_VERSION);
line('Klasor', $root);

/* 1. Is every file the panel needs actually on the server? A cPanel extract
      that half-finished is the commonest cause of a blank 500. */
head('DOSYALAR');
$need = [
  'lib/db.php', 'lib/config.php', 'lib/api.php', 'lib/panel.php',
  'lib/chain.php', 'lib/rapor.php', 'lib/para.php', 'lib/teshis.php', 'lib/pdf.php',
  'admin/auth.php', 'admin/layout.php', 'admin/nav.php', 'admin/index.php',
  'admin/guncelle.php', 'admin/tenant.php', 'admin/chain.php', 'admin/rapor.php',
  'admin/para.php', 'admin/uyari.php', 'admin/versions.php',
  'assets/panel.css', 'index.php',
];
$missing = 0;
foreach ($need as $f) {
    $ok = is_file("$root/$f");
    if (!$ok) $missing++;
    line($f, $ok ? 'var' : '>>> EKSIK <<<');
}
foreach (['admin/pages', 'bayi', 'cron', 'sql'] as $d) {
    line($d . '/', is_dir("$root/$d") ? 'var (' . (count(scandir("$root/$d")) - 2) . ' dosya)' : '>>> EKSIK <<<');
}

/* 2. Does every PHP file actually parse? A parse error anywhere in the include
      chain is a blank 500 and names no file in the browser. */
head('SOZDIZIMI');
$bad = [];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    if (strtolower($f->getExtension()) !== 'php') continue;
    $out = [];
    @exec('php -l ' . escapeshellarg($f->getPathname()) . ' 2>&1', $out, $rc);
    if ($rc !== 0) $bad[] = str_replace($root . '/', '', $f->getPathname()) . ' — ' . implode(' ', $out);
}
echo $bad ? implode("\n", $bad) . "\n" : (function_exists('exec') ? "hepsi temiz\n" : "exec() kapali — kontrol edilemedi\n");

/* 3. The database. Wrong credentials and a missing table look identical from
      the browser, and are completely different problems. */
head('VERITABANI');
try {
    $cfg = @include "$root/lib/config.php";
    if (!is_array($cfg)) throw new RuntimeException('lib/config.php bir dizi dondurmuyor');
    $d = $cfg['db'] ?? [];
    foreach (['host', 'name', 'user', 'pass'] as $k) {
        line("db.$k", isset($d[$k]) && $d[$k] !== '' ? 'dolu' : '>>> BOS <<<');
    }
    $pdo = new PDO(
        "mysql:host={$d['host']};port=" . ($d['port'] ?? 3306) . ";dbname={$d['name']};charset=" . ($d['charset'] ?? 'utf8mb4'),
        $d['user'], $d['pass'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    line('Baglanti', 'TAMAM');
    $t = $pdo->query("SHOW TABLES LIKE 'np\\_%'")->fetchAll(PDO::FETCH_COLUMN);
    line('np_ tablo sayisi', count($t));
    $want = ['np_admins','np_tenants','np_licences','np_devices','np_branches','np_menu_products',
             'np_branch_days','np_resellers','np_invoices','np_payments','np_diagnostics','np_alert_rules'];
    foreach ($want as $w) line("  $w", in_array($w, $t, true) ? 'var' : 'yok (guncelle.php calistirin)');
} catch (Throwable $e) {
    line('Baglanti', 'HATA: ' . $e->getMessage());
}

/* 4. Whatever the server itself wrote down. This is usually the answer. */
head('HATA KAYDI');
$logs = array_filter([
    "$root/error_log", "$root/admin/error_log",
    ini_get('error_log') ?: null,
]);
$found = false;
foreach ($logs as $lg) {
    if (!$lg || !is_file($lg) || !is_readable($lg)) continue;
    $found = true;
    echo "--- $lg (son 25 satir) ---\n";
    $lines = @file($lg);
    echo implode('', array_slice($lines ?: [], -25));
}
if (!$found) echo "error_log bulunamadi. cPanel > Metrics > Errors ekranina bakin.\n";

head('SON');
echo $missing ? "$missing dosya eksik — yukleme tamamlanmamis.\n" : "Dosyalar tam.\n";
echo "Bu dosyayi panel calisinca silin.\n";
