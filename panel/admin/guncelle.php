<?php
/**
 * Panel update — apply the schema of a newer release to a LIVE panel.
 *
 * `setup.php` is the first-install script: it loads the schema AND writes an
 * administrator, and its INSERT is an upsert, so running it on a working panel
 * to "get the new tables" quietly resets that administrator's password. That is
 * a trap, and updating a panel is a thing you do far more often than installing
 * one. So this is the update door instead:
 *
 *   - it applies every schema file, all of which are guarded (CREATE TABLE IF
 *     NOT EXISTS / ADD COLUMN IF NOT EXISTS), so running it twice is harmless;
 *   - it never touches np_admins, np_tenants, np_licences or any data;
 *   - it requires you to be logged in as an administrator already, so an
 *     uploaded-but-forgotten file is not a door into the database.
 *
 * Safe to leave on the server. Open it after every upload.
 */
/*
 * This page must NOT share fate with the code it exists to repair.
 *
 * It used to pull in auth.php and layout.php, which now pull in the sidebar,
 * which pulls in the libraries every screen uses. So one bad file anywhere in
 * that chain took down the one page that could have fixed it. It now boots on
 * `lib/db.php` alone, reads the session itself, and renders inside the shell
 * only if the shell loads cleanly.
 *
 * What this does and does not buy: a MISSING file, a throwing file or a broken
 * library no longer reaches this page. A PARSE error still does — PHP compiles
 * an include before any try/catch can see it, so no amount of care here catches
 * that one. `tani.php` exists for it: it includes nothing at all and lints every
 * file, so it can name the broken one when nothing else will run.
 */
require_once __DIR__ . '/../lib/db.php';

if (session_status() === PHP_SESSION_NONE) {
    session_name(cfg('app.session_name') ?: 'nokpos_panel');
    session_start();
}
if (empty($_SESSION['admin'])) { header('Location: index.php?p=login'); exit; }
$me = $_SESSION['admin'];

if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));

/*
 * Try the shell FIRST, then fill in only what it did not provide.
 *
 * Declaring the fallbacks first and letting the shell load afterwards is a
 * "Cannot redeclare function" fatal — the very failure this page exists to
 * survive, caused by the safety net itself. Order matters: load, then patch
 * the holes.
 */
$shell = false;
try {
    if (is_file(__DIR__ . '/auth.php')) require_once __DIR__ . '/auth.php';
    if (is_file(__DIR__ . '/layout.php')) require_once __DIR__ . '/layout.php';
    $shell = function_exists('layout_head') && function_exists('admin_user');
} catch (Throwable $e) { $shell = false; }

if (!function_exists('csrf')) { function csrf(): string { return $_SESSION['csrf']; } }
if (!function_exists('check_csrf')) {
    function check_csrf(): void {
        if (($_POST['csrf'] ?? '') !== ($_SESSION['csrf'] ?? 'x')) { http_response_code(400); exit('Oturum dogrulanamadi'); }
    }
}
if (!function_exists('e')) { function e($s): string { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); } }

if (!$shell) {
    function layout_head(string $t): void {
        echo '<!doctype html><html lang="tr"><head><meta charset="utf-8">'
           . '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' . e($t) . '</title>'
           . '<link rel="stylesheet" href="' . e(np_css()) . '"></head><body><main style="padding:24px">'
           . '<p style="color:#B42318;font:13px system-ui">Panel kabugu yuklenemedi — bu sayfa kendi basina calisiyor.</p>';
    }
    function layout_foot(): void { echo '</main></body></html>'; }
}

/* Every schema file the panel ships, in dependency order. Add new ones here
   and an upgrade needs no instructions beyond "open this page". */
const SCHEMA_FILES = ['panel_schema.sql', 'chain_schema.sql', 'rapor_schema.sql', 'panel_ops_schema.sql',
                      'bayi_schema.sql', 'para_schema.sql', 'teshis_schema.sql', 'uyari_schema.sql'];

$ran = [];
$errors = [];
$before = 0;
$after = 0;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    check_csrf();
    $before = count(db()->query("SHOW TABLES LIKE 'np\\_%'")->fetchAll(PDO::FETCH_NUM));
    foreach (SCHEMA_FILES as $file) {
        $path = __DIR__ . '/../sql/' . $file;
        if (!is_file($path)) { $errors[] = "$file bulunamadı"; continue; }
        /*
         * Comments are stripped BEFORE splitting on ';'. Splitting first and
         * skipping chunks that start with "--" looks equivalent and is not: a
         * comment sitting directly above a CREATE lands in the same chunk, and
         * that whole table is silently skipped. Three tables went missing that
         * way once and every page that touched them went blank.
         */
        $sql = preg_replace('/^\s*--.*$/m', '', (string) file_get_contents($path));
        $n = 0;
        foreach (array_filter(array_map('trim', explode(';', $sql))) as $stmt) {
            if ($stmt === '') continue;
            try { db()->exec($stmt); $n++; }
            catch (Throwable $e) {
                /* A guarded statement that the server's MariaDB is too old to
                   guard (IF NOT EXISTS on ADD COLUMN is 10.0+) throws on the
                   second run. Duplicate-object errors are the expected shape of
                   "already applied" and are not failures. */
                $msg = $e->getMessage();
                if (stripos($msg, 'duplicate') !== false || stripos($msg, 'exists') !== false) { continue; }
                $errors[] = $file . ': ' . $msg;
            }
        }
        $ran[$file] = $n;
    }
    $after = count(db()->query("SHOW TABLES LIKE 'np\\_%'")->fetchAll(PDO::FETCH_NUM));
}

layout_head('Panel güncelleme');
?>
<div class="wrap" style="max-width:760px">
  <h1>Panel güncelleme</h1>
  <p class="muted">Yeni sürümü sunucuya yükledikten sonra bu sayfayı bir kez açın.
     Eksik tablo ve sütunlar eklenir; <b>hiçbir veriniz, yöneticiniz, kiracınız
     ya da lisansınız değişmez</b>. Birden fazla kez çalıştırmak zararsızdır.</p>

<?php if ($_SERVER['REQUEST_METHOD'] === 'POST'): ?>
  <?php if ($errors): ?>
    <div class="alert alert--error">
      <b>Bazı adımlar tamamlanamadı:</b>
      <ul style="margin:8px 0 0;padding-left:18px">
        <?php foreach ($errors as $x): ?><li><?= e($x) ?></li><?php endforeach; ?>
      </ul>
      <p style="margin:10px 0 0">Dosyaları phpMyAdmin üzerinden <code>panel/sql/</code>
         klasöründen elle içe aktarabilirsiniz.</p>
    </div>
  <?php else: ?>
    <div class="alert alert--ok"><b>Güncelleme tamamlandı.</b>
      <?= (int)$before ?> tablodan <?= (int)$after ?> tabloya çıkıldı.</div>
  <?php endif; ?>
  <table class="tbl"><thead><tr><th>Dosya</th><th class="right">Çalıştırılan ifade</th></tr></thead><tbody>
    <?php foreach ($ran as $f => $n): ?>
      <tr><td><code><?= e($f) ?></code></td><td class="right"><?= (int)$n ?></td></tr>
    <?php endforeach; ?>
  </tbody></table>
  <p style="margin-top:18px"><a class="btn" href="index.php">Panele dön</a></p>
<?php else: ?>
  <form method="post">
    <input type="hidden" name="csrf" value="<?= e(csrf()) ?>">
    <table class="tbl"><thead><tr><th>Uygulanacak şema dosyası</th><th>Durum</th></tr></thead><tbody>
      <?php foreach (SCHEMA_FILES as $f): $ok = is_file(__DIR__ . '/../sql/' . $f); ?>
        <tr><td><code><?= e($f) ?></code></td>
            <td><?= $ok ? 'hazır' : '<span style="color:#B42318">dosya yok</span>' ?></td></tr>
      <?php endforeach; ?>
    </tbody></table>
    <p style="margin-top:18px">
      <button class="btn btn--primary" type="submit">Güncellemeyi uygula</button>
      <a class="btn" href="index.php" style="margin-left:8px">Vazgeç</a></p>
  </form>
<?php endif; ?>
</div>
<?php layout_foot();
