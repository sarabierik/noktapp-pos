<?php
/**
 * NOKTApp POS panel — first install.
 *
 * One page, no file editing. It asks for the database, proves it can connect
 * BEFORE writing anything, then writes lib/config.php, loads every schema file
 * and creates the first administrator.
 *
 * Why it writes the config rather than asking you to edit it: hand-editing a
 * PHP file over FTP is where installs die — one missing quote and the whole
 * site is a blank 500 with nothing to go on. The form cannot produce that.
 *
 * It refuses to run once an administrator exists, so it can never be used to
 * take over a working panel. To UPDATE an installed panel use
 * admin/guncelle.php, which touches schema only and no accounts.
 *
 * Delete this file once you have logged in.
 */
declare(strict_types=1);
error_reporting(E_ALL);
ini_set('display_errors', '1');           /* an installer that fails silently is useless */

const CFG_PATH = __DIR__ . '/lib/config.php';
$SCHEMA = ['panel_schema.sql', 'chain_schema.sql', 'rapor_schema.sql',
           'panel_ops_schema.sql', 'bayi_schema.sql', 'para_schema.sql',
           'teshis_schema.sql', 'uyari_schema.sql'];

function esc($s): string { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }

/* ---------------------------------------------------------------- guard --
   If a config already points at a database that already has an administrator,
   this installer is the wrong door and says so rather than overwriting. */
$installed = false;
if (is_file(CFG_PATH)) {
    try {
        $c = include CFG_PATH;
        $d = $c['db'] ?? [];
        $p = new PDO("mysql:host={$d['host']};port=" . ($d['port'] ?? 3306) . ";dbname={$d['name']};charset=utf8mb4",
                     $d['user'], $d['pass'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $installed = (int) $p->query('SELECT COUNT(*) FROM np_admins')->fetchColumn() > 0;
    } catch (Throwable $e) { $installed = false; }
}

$err = null; $done = [];
$in = fn(string $k, string $d = '') => trim((string)($_POST[$k] ?? $d));

if (!$installed && $_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        foreach (['db_name', 'db_user', 'email', 'password'] as $need) {
            if ($in($need) === '') throw new RuntimeException('Eksik alan: ' . $need);
        }
        if (strlen($in('password')) < 8) throw new RuntimeException('Şifre en az 8 karakter olmalı.');
        if (!filter_var($in('email'), FILTER_VALIDATE_EMAIL)) throw new RuntimeException('E-posta geçersiz.');

        $db = ['host' => $in('db_host', 'localhost'), 'port' => (int) ($in('db_port', '3306') ?: 3306),
               'name' => $in('db_name'), 'user' => $in('db_user'), 'pass' => (string)($_POST['db_pass'] ?? '')];

        /* Connect FIRST. Writing a config we have not proved is how an install
           ends with a broken site and no way back in. */
        $pdo = new PDO("mysql:host={$db['host']};port={$db['port']};dbname={$db['name']};charset=utf8mb4",
                       $db['user'], $db['pass'],
                       [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => false]);
        $done[] = 'Veritabanına bağlanıldı: ' . $db['name'];

        /* The loyalty database. Same server unless told otherwise; empty name
           turns the guest registry off rather than half-configuring it. */
        $pass = ['host' => $in('pass_host', $db['host']), 'port' => (int) ($in('pass_port', (string)$db['port']) ?: $db['port']),
                 'name' => $in('pass_name'), 'user' => $in('pass_user', $db['user']),
                 'pass' => (string)($_POST['pass_pass'] ?? $db['pass'])];

        $cfg = "<?php\n"
             . "/**\n * NOKTApp POS panel yapılandırması.\n"
             . " * setup.php tarafından " . date('d.m.Y H:i') . " tarihinde yazıldı.\n"
             . " * Bu dosyayı sunucudan silmeyin ve güncelleme paketleriyle DEĞİŞTİRMEYİN.\n */\n"
             . "return " . var_export([
                 'db' => $db + ['charset' => 'utf8mb4'],
                 'pass_db' => $pass,
                 'backup_dir' => $in('backup_dir', dirname(__DIR__) . '/noktapp-backups'),
                 'release_dir' => __DIR__ . '/indir',
                 'mail' => ['from' => $in('mail_from', 'noreply@noktapp.com'),
                            'from_name' => $in('mail_from_name', 'NOKTApp POS')],
                 'app' => ['session_name' => 'nokpos_panel', 'name' => 'NOKTApp POS Panel'],
                 /* Both PHP and MariaDB are put on this zone, so every time on
                    every screen is the restaurant's own clock rather than the
                    hosting account's. Change it in one place if you sell
                    outside Turkey. */
                 'timezone' => 'Europe/Istanbul',
               ], true) . ";\n";

        if (!is_dir(dirname(CFG_PATH))) throw new RuntimeException('lib/ klasörü yok — yükleme eksik.');
        if (@file_put_contents(CFG_PATH, $cfg) === false) {
            throw new RuntimeException('lib/config.php yazılamadı. Klasör izni 755, dosya 644 olmalı.');
        }
        @chmod(CFG_PATH, 0644);
        $done[] = 'lib/config.php yazıldı';

        /*
         * Comments are stripped BEFORE the split on ';'. Splitting first and
         * skipping chunks that begin with "--" looks equivalent and is not: a
         * comment directly above a CREATE lands in the same chunk and that
         * whole table is silently skipped. Three tables went missing that way
         * once, the panel installed anyway, and every page touching them was
         * blank.
         */
        $made = 0; $skipped = [];
        foreach ($SCHEMA as $file) {
            $path = __DIR__ . '/sql/' . $file;
            if (!is_file($path)) { $skipped[] = $file; continue; }
            $sql = preg_replace('/^\s*--.*$/m', '', (string) file_get_contents($path));
            foreach (array_filter(array_map('trim', explode(';', $sql))) as $stmt) {
                if ($stmt === '') continue;
                try { $pdo->exec($stmt); $made++; }
                catch (Throwable $e) {
                    $m = $e->getMessage();
                    if (stripos($m, 'duplicate') === false && stripos($m, 'exists') === false) throw $e;
                }
            }
        }
        if ($skipped) throw new RuntimeException('Eksik şema dosyası: ' . implode(', ', $skipped));

        /* SHOW TABLES, not information_schema: shared hosting denies the latter
           outright, on exactly the accounts this installer exists for. */
        $n = count($pdo->query("SHOW TABLES LIKE 'np\\_%'")->fetchAll(PDO::FETCH_NUM));
        if ($n < 10) throw new RuntimeException("Şema eksik yüklendi: {$n} tablo oluştu.");
        $done[] = "Tablolar oluşturuldu ({$n} tablo, {$made} ifade)";

        $st = $pdo->prepare('INSERT INTO np_admins (email, name, password_hash) VALUES (?,?,?)
                             ON DUPLICATE KEY UPDATE name=VALUES(name), password_hash=VALUES(password_hash)');
        $st->execute([mb_strtolower($in('email')), $in('name', 'Yönetici'), password_hash($in('password'), PASSWORD_BCRYPT)]);
        $done[] = 'Yönetici hesabı hazır: ' . $in('email');

        $bd = $in('backup_dir', dirname(__DIR__) . '/noktapp-backups');
        if (!is_dir($bd)) @mkdir($bd, 0750, true);
        $done[] = is_dir($bd) ? 'Yedek klasörü: ' . $bd : 'Yedek klasörü açılamadı: ' . $bd . ' (elle oluşturun)';
        $installed = true;
    } catch (Throwable $e) {
        $err = $e->getMessage();
    }
}
?><!doctype html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NOKTApp POS Panel — Kurulum</title>
<style>
 body{margin:0;background:#F4F4F6;color:#18181B;font:15px/1.5 "Segoe UI",system-ui,sans-serif}
 .w{max-width:660px;margin:40px auto;padding:0 18px}
 .c{background:#fff;border:1px solid #E4E4E7;border-radius:14px;padding:24px;margin-bottom:16px}
 h1{font-size:22px;margin:0 0 4px;letter-spacing:-.02em}
 h2{font-size:14px;margin:22px 0 10px;color:#52525B;text-transform:uppercase;letter-spacing:.06em}
 p.s{color:#8A8A93;margin:0 0 18px;font-size:13.5px}
 label{display:block;font-size:13px;color:#52525B;margin:12px 0 5px}
 input{width:100%;height:42px;padding:0 12px;border:1px solid #D4D4D8;border-radius:9px;font:inherit;box-sizing:border-box}
 input:focus{outline:none;border-color:#FF7A1A;box-shadow:0 0 0 3px #FFF3E9}
 .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
 .btn{height:46px;padding:0 22px;border:0;border-radius:9px;background:#FF7A1A;color:#fff;font:600 15px inherit;cursor:pointer}
 .btn:hover{background:#EA580C}
 .ok{background:#F1F1F3;border:1px solid #DCDCE1;border-radius:10px;padding:14px 16px;margin-bottom:16px}
 .bad{background:#FDECEA;border:1px solid #F5C6C2;color:#B42318;border-radius:10px;padding:14px 16px;margin-bottom:16px}
 .hint{color:#8A8A93;font-size:12.5px;margin:6px 0 0}
 ul{margin:8px 0 0;padding-left:18px} li{margin:3px 0}
 a{color:#EA580C}
</style></head><body><div class="w">

<?php if ($installed && !$done): ?>
  <div class="c">
    <h1>Panel zaten kurulu</h1>
    <p class="s">Bu veritabanında bir yönetici hesabı var, bu yüzden kurulum çalışmadı — mevcut
       panelinizin üzerine yazmasını istemezsiniz.</p>
    <p><b>Güncelleme mi yapıyorsunuz?</b> <a href="admin/guncelle.php">admin/guncelle.php</a>
       sadece eksik tablo ve sütunları ekler; hiçbir veriye, hesaba ya da lisansa dokunmaz.</p>
    <p><b>Giriş mi yapacaksınız?</b> <a href="admin/index.php">Panele git</a></p>
    <p class="hint">Bu dosyayı (setup.php) sunucudan silebilirsiniz.</p>
  </div>

<?php elseif ($done): ?>
  <div class="c">
    <h1>Kurulum tamamlandı</h1>
    <div class="ok"><ul><?php foreach ($done as $d) echo '<li>' . esc($d) . '</li>'; ?></ul></div>
    <p><a class="btn" style="display:inline-block;line-height:46px;text-decoration:none" href="admin/index.php">Panele giriş yap</a></p>
    <p class="hint" style="margin-top:16px"><b>Şimdi yapın:</b> bu dosyayı (<code>setup.php</code>)
       sunucudan silin. Yapılandırmanız <code>lib/config.php</code> içinde — güncelleme paketleri
       o dosyayı içermez, bu yüzden yükleme onu asla ezmez.</p>
  </div>

<?php else: ?>
  <form method="post" class="c">
    <h1>NOKTApp POS Panel kurulumu</h1>
    <p class="s">Veritabanı bilgilerinizi girin. Önce bağlantı denenir, sonra
       <code>lib/config.php</code> yazılır ve tablolar oluşturulur. Hiçbir dosyayı elle
       düzenlemeniz gerekmez.</p>

    <?php if ($err): ?><div class="bad"><b>Kurulum yapılamadı:</b> <?= esc($err) ?></div><?php endif; ?>

    <h2>Veritabanı</h2>
    <div class="two">
      <div><label>Sunucu</label><input name="db_host" value="<?= esc($_POST['db_host'] ?? 'localhost') ?>"></div>
      <div><label>Port</label><input name="db_port" value="<?= esc($_POST['db_port'] ?? '3306') ?>"></div>
    </div>
    <label>Veritabanı adı</label>
    <input name="db_name" value="<?= esc($_POST['db_name'] ?? '') ?>" placeholder="hesap_nokpos_panel" required>
    <div class="two">
      <div><label>Kullanıcı</label><input name="db_user" value="<?= esc($_POST['db_user'] ?? '') ?>" required></div>
      <div><label>Şifre</label><input name="db_pass" type="password" autocomplete="new-password"></div>
    </div>
    <p class="hint">cPanel → MySQL Veritabanları ekranında oluşturduğunuz veritabanı ve kullanıcı.
       Kullanıcının o veritabanında <b>ALL PRIVILEGES</b> yetkisi olmalı.</p>

    <h2>Sadakat veritabanı <span style="text-transform:none;font-weight:400">(isteğe bağlı)</span></h2>
    <label>Veritabanı adı — boş bırakırsanız sadakat kapalı olur</label>
    <input name="pass_name" value="<?= esc($_POST['pass_name'] ?? '') ?>" placeholder="hesap_nokpos">
    <div class="two">
      <div><label>Kullanıcı</label><input name="pass_user" value="<?= esc($_POST['pass_user'] ?? '') ?>"></div>
      <div><label>Şifre</label><input name="pass_pass" type="password" autocomplete="new-password"></div>
    </div>
    <p class="hint">Misafirlerin NOKTApp Pass kayıtlarının durduğu veritabanı. Boş bırakılırsa
       panel çalışır, yalnızca sadakat aramaları kapalı olur.</p>

    <h2>Yönetici hesabı</h2>
    <div class="two">
      <div><label>Ad soyad</label><input name="name" value="<?= esc($_POST['name'] ?? '') ?>" placeholder="Erik"></div>
      <div><label>E-posta</label><input name="email" type="email" value="<?= esc($_POST['email'] ?? '') ?>" required></div>
    </div>
    <label>Şifre (en az 8 karakter)</label>
    <input name="password" type="password" autocomplete="new-password" required>

    <p style="margin-top:22px"><button class="btn" type="submit">Kur</button></p>
  </form>
<?php endif; ?>
</div></body></html>
