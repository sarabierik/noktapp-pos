<?php

/*
 * Cache-bust the stylesheet.
 *
 * A browser holding the previous release's panel.css is the worst kind of
 * "broken": the cards still look right because those classes existed before,
 * while anything NEW - the sidebar, in this release - renders as a bare bullet
 * list. It reads as a botched upload and it is not one. The file's own
 * modification time is appended, so a changed stylesheet is a changed URL and
 * the browser has no cached copy of it to reach for.
 */
if (!function_exists('np_css')) {
    function np_css(string $rel = '../assets/panel.css'): string {
        $path = __DIR__ . '/' . $rel;
        $v = @filemtime($path) ?: 1;
        return $rel . '?v=' . $v;
    }
}
/**
 * NOKTApp POS - control panel.
 * This is the only part of the product that lives on our server. It hands out
 * licences, keeps the nightly backups, distributes updates and relays the
 * waiter phones. It never holds a restaurant's orders.
 *
 * The home page answers one question - "what needs me today?" - and every
 * number on it that implies something is wrong links through to the list of
 * who. A count with no way to reach the names behind it is a rumour.
 */
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/layout.php';
require_once __DIR__ . '/chain.php';
require_once __DIR__ . '/rapor.php';
require_once __DIR__ . '/para.php';
require_once __DIR__ . '/uyari.php';
require_once __DIR__ . '/yedek.php';

$p = $_GET['p'] ?? 'home';

/* ------------------------------- login ---------------------------- */
if ($p === 'login') {
    $err = '';
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $email = strtolower(trim($_POST['email'] ?? ''));
        $a = one('SELECT * FROM np_admins WHERE email=? AND is_active=1', [$email]);
        if ($a && password_verify($_POST['password'] ?? '', $a['password_hash'])) {
            $_SESSION['admin'] = ['id' => $a['id'], 'email' => $a['email'], 'name' => $a['name']];
            q('UPDATE np_admins SET last_login_at=NOW() WHERE id=?', [$a['id']]);
            audit('panel.login', $a['email']);
            header('Location: index.php?p=home'); exit;
        }
        $err = 'E-posta veya şifre hatalı';
        q('INSERT INTO np_login_attempts (email, ip, ok) VALUES (?,?,0)', [$email, $_SERVER['REMOTE_ADDR'] ?? null]);
    }

    /*
     * NOTHING about the business goes on this page.
     *
     * It used to carry three live figures - how many restaurants are paying,
     * how many tills are installed, and which build is published. The reasoning
     * written here was "counts of rows, nothing identifying", and that was
     * simply wrong: the count IS the fact. Anyone who found the address learned
     * the size of the customer base, and a competitor reading "1 aktif işletme"
     * on a vendor's own login screen learns something no sales call would ever
     * tell them. The version number is the same mistake in the other direction
     * - it tells whoever is looking exactly which build to go and read about.
     *
     * The panel says what it DOES here, which is a marketing sentence, and
     * keeps every number for the far side of the password. If you want the
     * figures back, they are on Genel, one login away, where they belong.
     */
    ?><!doctype html><html lang="tr"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Panel girişi · NOKTApp POS</title><link rel="stylesheet" href="<?= np_css() ?>"></head>
    <body class="login-body"><div class="login-split">
      <div class="login-art">
        <div class="brand"><span class="mark"></span> NOKTApp POS <em>panel</em></div>
        <div class="art-mid">
          <h1>İşin kontrol paneli</h1>
          <p class="lede">Lisanslar ve kasa sayıları, gecelik bulut yedekleri, sürüm dağıtımı,
             garson telefonlarının relay trafiği ve zincir müşterilerin şube raporları — hepsi tek yerde.</p>
          <div class="facts">
            <div><b>7/24</b><span>lisans doğrulama</span></div>
            <div><b>Gecelik</b><span>bulut yedeği</span></div>
            <div><b>Otomatik</b><span>sürüm dağıtımı</span></div>
            <div><b>Zincir</b><span>şube raporları</span></div>
          </div>
        </div>
        <p class="foot">pos.noktapp.com · yalnızca yetkili yönetici girişi</p>
      </div>
      <div class="login-form"><form method="post" class="box">
        <h2>Panel girişi</h2>
        <p class="lead">Yönetici hesabınızla devam edin.</p>
        <?php if ($err) echo '<div class="alert">' . e($err) . '</div>'; ?>
        <label>E-posta<input name="email" type="email" required autofocus autocomplete="username"
               value="<?= e($_POST['email'] ?? '') ?>"></label>
        <label>Şifre<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="btn">Giriş yap</button>
        <p class="note">Bu panel yalnızca NOKTApp POS bayisi içindir. Restoran sahipleri kendi
           kasalarından giriş yapar; buradan işletme girişi yapılmaz.</p>
      </form></div>
    </div></body></html><?php
    exit;
}

if ($p === 'logout') { session_destroy(); header('Location: index.php?p=login'); exit; }
$me = require_admin();

/*
 * The consolidated report's CSV and PDF send a file, not a page, so they have
 * to run before layout_head() puts a byte of HTML on the wire. Returns
 * immediately for everything that is not an export.
 */
rapor_export();

/* Same arrangement for a backup download: a file, not a page, so it has to go
   out before the shell prints its first tag. Returns immediately for every
   request that is not one. See admin/yedek.php. */
backup_admin_export();

/* ------------------------------- actions -------------------------- */
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    check_csrf();
    $a = $_POST['action'] ?? '';

    if ($a === 'tenant_save') {
        $id = (int)($_POST['id'] ?? 0);
        $code = trim($_POST['code'] ?? '') ?: ('R' . random_int(1000, 9999));
        if ($id) {
            q('UPDATE np_tenants SET code=?, company_name=?, owner_name=?, email=?, phone=?, tax_number=?,
                 tax_office=?, address=?, city=?, is_active=?, notes=? WHERE id=?',
              [$code, $_POST['company_name'], $_POST['owner_name'], strtolower(trim($_POST['email'])),
               $_POST['phone'], $_POST['tax_number'], $_POST['tax_office'], $_POST['address'],
               $_POST['city'], isset($_POST['is_active']) ? 1 : 0, $_POST['notes'], $id]);
            audit('tenant.update', $_POST['company_name'], null, $id);
            $_SESSION['flash'] = 'İşletme bilgileri kaydedildi.';
        } else {
            if (empty($_POST['password'])) { $_SESSION['flash'] = 'Yeni işletme için şifre zorunlu'; header('Location: index.php?p=tenants'); exit; }
            q('INSERT INTO np_tenants (code, company_name, owner_name, email, password_hash, phone,
                 tax_number, tax_office, address, city, is_active, notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
              [$code, $_POST['company_name'], $_POST['owner_name'], strtolower(trim($_POST['email'])),
               password_hash($_POST['password'], PASSWORD_BCRYPT), $_POST['phone'], $_POST['tax_number'],
               $_POST['tax_office'], $_POST['address'], $_POST['city'], 1, $_POST['notes']]);
            $id = lastId();
            // every new restaurant gets a licence straight away
            q('INSERT INTO np_licences (tenant_id, licence_key, plan, status, seats, starts_at, expires_at, grace_days)
               VALUES (?,?,?,?,?,CURDATE(), DATE_ADD(NOW(), INTERVAL 30 DAY), 7)',
              [$id, strtoupper(bin2hex(random_bytes(12))), 'standart', 'trial', 1]);
            audit('tenant.create', $_POST['company_name'], null, $id);
            $_SESSION['flash'] = 'İşletme oluşturuldu ve 30 günlük deneme lisansı verildi.';
        }
        header('Location: index.php?p=tenant&id=' . $id); exit;
    }

    if ($a === 'licence_save') {
        $id = (int)$_POST['licence_id'];
        $tid = (int)$_POST['tenant_id'];
        q('UPDATE np_licences SET plan=?, status=?, seats=?, expires_at=?, grace_days=?, price=?, billing_period=?, features=?
            WHERE id=? AND tenant_id=?',
          [$_POST['plan'], $_POST['status'], (int)$_POST['seats'],
           $_POST['expires_at'] ? $_POST['expires_at'] . ' 23:59:59' : null,
           (int)$_POST['grace_days'], $_POST['price'] !== '' ? $_POST['price'] : null,
           $_POST['billing_period'], $_POST['features'] ?: '{}', $id, $tid]);
        audit('licence.update', 'licence#' . $id, $_POST['status'], $tid);
        $_SESSION['flash'] = 'Lisans kaydedildi.';
        header('Location: index.php?p=tenant&id=' . $tid); exit;
    }

    /*
     * Extend the licence - the single action the vendor performs most.
     *
     * It extends from whichever is LATER, today or the current expiry. Adding
     * a year to "now" on a licence with four months left silently throws those
     * four months away, and the customer paid for them.
     */
    if ($a === 'licence_extend') {
        $tid = (int)$_POST['tenant_id'];
        $months = max(1, min(60, (int)$_POST['months']));
        $lic = one('SELECT * FROM np_licences WHERE id=? AND tenant_id=?', [(int)$_POST['licence_id'], $tid]);
        if ($lic) {
            $base = ($lic['expires_at'] && strtotime($lic['expires_at']) > time())
                  ? $lic['expires_at'] : date('Y-m-d H:i:s');
            $new = date('Y-m-d', strtotime($base . ' +' . $months . ' month')) . ' 23:59:59';
            /* An extension is also a reinstatement: a licence that had lapsed
               becomes active again, otherwise the till stays locked out with a
               future date on it and nobody can see why. */
            $status = in_array($lic['status'], ['expired', 'suspended'], true) ? 'active' : $lic['status'];
            q('UPDATE np_licences SET expires_at=?, status=? WHERE id=? AND tenant_id=?',
              [$new, $status, $lic['id'], $tid]);
            audit('licence.extend', 'licence#' . $lic['id'],
                  ['months' => $months, 'from' => $lic['expires_at'], 'to' => $new, 'status' => $status], $tid);
            $_SESSION['flash'] = 'Lisans ' . $months . ' ay uzatıldı. Yeni bitiş: ' . date('d.m.Y', strtotime($new));
        }
        header('Location: index.php?p=tenant&id=' . $tid); exit;
    }

    /* Seat count on its own, because it changes when a restaurant adds a till
       and that is a phone call, not a form-filling session. */
    if ($a === 'seats_save') {
        $tid = (int)$_POST['tenant_id'];
        $seats = max(1, min(999, (int)$_POST['seats']));
        $lic = one('SELECT * FROM np_licences WHERE id=? AND tenant_id=?', [(int)$_POST['licence_id'], $tid]);
        if ($lic) {
            q('UPDATE np_licences SET seats=? WHERE id=? AND tenant_id=?', [$seats, $lic['id'], $tid]);
            audit('licence.seats', 'licence#' . $lic['id'], ['from' => (int)$lic['seats'], 'to' => $seats], $tid);
            $_SESSION['flash'] = 'Kasa sayısı ' . $seats . ' olarak güncellendi.';
        }
        header('Location: index.php?p=tenant&id=' . $tid); exit;
    }

    if ($a === 'licence_status') {
        $tid = (int)$_POST['tenant_id'];
        $st = (string)$_POST['status'];
        if (in_array($st, ['trial','active','suspended','expired'], true)) {
            $lic = one('SELECT * FROM np_licences WHERE id=? AND tenant_id=?', [(int)$_POST['licence_id'], $tid]);
            if ($lic) {
                q('UPDATE np_licences SET status=? WHERE id=? AND tenant_id=?', [$st, $lic['id'], $tid]);
                audit('licence.status', 'licence#' . $lic['id'], ['from' => $lic['status'], 'to' => $st], $tid);
                $_SESSION['flash'] = 'Lisans durumu güncellendi.';
            }
        }
        header('Location: index.php?p=tenant&id=' . $tid); exit;
    }

    /* Reset the restaurant's own login. The new password is shown once on the
       next screen and is NEVER written to the audit trail - the audit row says
       that it happened, not what it became. */
    if ($a === 'tenant_password') {
        $tid = (int)$_POST['tenant_id'];
        $t = one('SELECT id, company_name FROM np_tenants WHERE id=?', [$tid]);
        if ($t) {
            $pw = trim((string)($_POST['password'] ?? ''));
            if ($pw === '') $pw = strtoupper(bin2hex(random_bytes(4)));
            if (mb_strlen($pw) < 6) {
                $_SESSION['flash'] = 'Şifre en az 6 karakter olmalı.';
            } else {
                q('UPDATE np_tenants SET password_hash=? WHERE id=?', [password_hash($pw, PASSWORD_BCRYPT), $tid]);
                audit('tenant.password_reset', $t['company_name'], null, $tid);
                $_SESSION['flash'] = 'Yeni şifre: ' . $pw . ' — bu şifre bir daha gösterilmeyecek, şimdi iletin.';
            }
        }
        header('Location: index.php?p=tenant&id=' . $tid); exit;
    }

    if ($a === 'device_block') {
        $did = (int)$_POST['id'];
        $d = one('SELECT * FROM np_devices WHERE id=?', [$did]);
        if ($d) {
            q('UPDATE np_devices SET is_blocked=? WHERE id=?', [(int)$_POST['blocked'], $did]);
            audit('device.block', 'device#' . $did, (int)$_POST['blocked'] ? 'engellendi' : 'açıldı', (int)$d['tenant_id']);
            $_SESSION['flash'] = (int)$_POST['blocked'] ? 'Kasa engellendi.' : 'Kasanın engeli kaldırıldı.';
        }
        /* Come back to where you pressed the button. The destination is rebuilt
           from a tenant id here rather than taken from the form, so the field
           can never become an open redirect. */
        $back = (int)($_POST['back_tenant'] ?? 0);
        header('Location: ' . ($back ? 'index.php?p=tenant&id=' . $back : 'index.php?p=devices')); exit;
    }

    if ($a === 'version_save') {
        q('INSERT INTO np_versions (version, channel, filename, size_bytes, sha512, release_notes, is_current)
           VALUES (?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE filename=VALUES(filename), size_bytes=VALUES(size_bytes),
             sha512=VALUES(sha512), release_notes=VALUES(release_notes), is_current=VALUES(is_current)',
          [$_POST['version'], $_POST['channel'] ?: 'stable', $_POST['filename'],
           (int)$_POST['size_bytes'], $_POST['sha512'], $_POST['release_notes'],
           isset($_POST['is_current']) ? 1 : 0]);
        if (isset($_POST['is_current'])) {
            q('UPDATE np_versions SET is_current=0 WHERE version<>? AND channel=?', [$_POST['version'], $_POST['channel'] ?: 'stable']);
        }
        audit('version.publish', $_POST['version']);
        $_SESSION['flash'] = 'Sürüm ' . $_POST['version'] . ' kaydedildi.';
        header('Location: index.php?p=versions'); exit;
    }

    /* Mark an already-published build as the current one, without retyping it. */
    if ($a === 'version_current') {
        $v = one('SELECT * FROM np_versions WHERE id=?', [(int)$_POST['version_id']]);
        if ($v) {
            /* The page hides this button when the installer is missing, but a
               form post is a form post: check here too, because the cost of
               being wrong is every till in the field failing to update against
               a latest.yml that points at a 404. */
            $fi = panel_release_file($v);
            if (!$fi['present']) {
                $_SESSION['flash'] = 'v' . $v['version'] . ' güncel yapılamadı: kurulum dosyası '
                    . $v['filename'] . ' indir/ klasöründe yok.';
                header('Location: index.php?p=versions'); exit;
            }
            q('UPDATE np_versions SET is_current=0 WHERE channel=?', [$v['channel']]);
            q('UPDATE np_versions SET is_current=1 WHERE id=?', [$v['id']]);
            audit('version.current', $v['version'], $v['channel']);
            $_SESSION['flash'] = 'v' . $v['version'] . ' güncel sürüm olarak yayınlandı.';
        }
        header('Location: index.php?p=versions'); exit;
    }

    /*
     * Remove a published record - a version typed wrong, or an old build whose
     * installer is long gone and which only clutters the list.
     *
     * The RECORD, not the file: nothing in indir/ is touched, so a mistaken
     * delete costs one line retyped in the publish form and never a download
     * somebody still needs. The current version is refused outright; deleting
     * it would leave latest.yml with nothing to advertise and every till
     * polling into a hole.
     */
    if ($a === 'version_delete') {
        $v = one('SELECT * FROM np_versions WHERE id=?', [(int)$_POST['version_id']]);
        if (!$v) { header('Location: index.php?p=versions'); exit; }
        if ($v['is_current']) {
            $_SESSION['flash'] = 'Güncel sürüm silinemez. Önce başka bir sürümü güncel yapın.';
        } else {
            q('DELETE FROM np_versions WHERE id=?', [$v['id']]);
            audit('version.delete', $v['version'], $v['channel']);
            $_SESSION['flash'] = 'v' . $v['version'] . ' kaydı silindi. Kurulum dosyası duruyor.';
        }
        header('Location: index.php?p=versions'); exit;
    }

    /* The chain actions live in chain.php so this file stays the panel it has
       always been. Each one redirects and exits; falling through here means
       the POST was not a chain action. */
    chain_actions($a);

    /* The reseller and money actions, same arrangement: every one of them
       redirects and exits, so reaching the end of this block means the POST
       belonged to none of them. See admin/para.php. */
    para_actions($a);

    /* The alert actions, same arrangement again: saving a rule or running the
       cron by hand has to redirect, or a refresh re-runs it. See admin/uyari.php. */
    uyari_actions($a);
}

/* -------------------------------- pages --------------------------- */
$titles = ['home' => 'Genel bakış', 'tenants' => 'İşletmeler', 'tenant' => 'İşletme',
           'devices' => 'Kasalar', 'backups' => 'Yedekler', 'relay' => 'Relay',
           'versions' => 'Sürümler', 'audit' => 'İşlem kayıtları', 'ara' => 'Arama',
           'liste' => 'Liste', 'branches' => 'Şubeler', 'menu' => 'Ana menü',
           'menuversions' => 'Menü sürümleri', 'exceptions' => 'Şube istisnaları',
           'rapor' => 'Şube raporu'];
/* A screen the sidebar knows about but this map does not - a new area, or one
   of its detail pages - takes its title from admin/nav.php rather than
   rendering as the generic "Panel". */
layout_head($titles[$p] ?? nav_title($p) ?? 'Panel');
if ($flash = ($_SESSION['flash'] ?? null)) { echo '<div class="flash">' . e($flash) . '</div>'; unset($_SESSION['flash']); }

/* =================================================================== */
if ($p === 'home') {
    /*
     * Every figure is fetched through panel_try().
     *
     * The first version of this page ran six queries in a row with no guard:
     * one of them failing took the whole page down, and with display_errors
     * off on shared hosting that meant a header and then white space - no
     * message, nothing to act on. A tile that cannot be computed says so and
     * lets the other five render.
     */
    $customers = (int) panel_try('panel_count_customers', 0);
    $onlineNow = (int) panel_try('panel_count_online_now', 0);
    $onlineDay = (int) panel_try('panel_count_online_today', 0);
    $devices   = (int) panel_try('panel_count_devices', 0);
    $exp30     = panel_try(fn() => panel_list_expiring(30), []);
    $exp90     = panel_try(fn() => panel_list_expiring(90), []);
    $lapsed    = panel_try('panel_list_lapsed', []);
    $silent    = panel_try('panel_list_silent', []);
    $noinst    = panel_try('panel_list_never_installed', []);
    $overdue   = panel_try('panel_list_backup_overdue', []);
    $adoption  = panel_try('panel_version_adoption', ['current' => null, 'total' => 0, 'rows' => []]);
    $outdated  = panel_try('panel_list_outdated', []);
    $value     = panel_try('panel_contract_value', ['yearly' => 0, 'priced' => 0, 'total' => 0]);

    $today = panel_try(fn() => all("SELECT t.id, t.company_name, r.payload, r.created_at
                                      FROM np_reports r
                                      JOIN np_tenants t ON t.id = r.tenant_id
                                     WHERE r.entity = 'daily_summary'
                                       AND r.created_at > DATE_SUB(NOW(), INTERVAL 26 HOUR)
                                     ORDER BY r.created_at DESC LIMIT 12"), []);

    page_head('Genel bakış', [
        'eyebrow' => date('d.m.Y'),
        'sub' => $customers . ' aktif işletme · ' . $devices . ' kayıtlı kasa · şu an '
                 . $onlineNow . ' kasa çevrimiçi',
        'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=tenants">Tüm işletmeler</a>'
                   . '<a class="btn btn-sm" href="index.php?p=tenant&id=0">Yeni işletme</a>',
    ]);
    ?>
    <div class="stats">
      <a class="stat" href="index.php?p=tenants">
        <span>Aktif işletme</span><b><?= $customers ?></b>
        <small><?= $devices ?> kasa kayıtlı</small></a>

      <a class="stat" href="index.php?p=liste&k=online">
        <span>Bugün çevrimiçi kasa</span><b><?= $onlineDay ?></b>
        <small><?= $onlineNow ?> tanesi şu an bağlı</small></a>

      <a class="stat" href="index.php?p=liste&k=exp30">
        <span>30 günde bitecek lisans</span>
        <b class="<?= count($exp30) ? 'warn' : '' ?>"><?= count($exp30) ?></b>
        <small><?= count($exp90) ?> tanesi 90 gün içinde</small></a>

      <a class="stat" href="index.php?p=liste&k=silent">
        <span>Sessiz kasa</span>
        <b class="<?= count($silent) ? 'bad' : '' ?>"><?= count($silent) ?></b>
        <small><?= PANEL_SILENT_DAYS ?> gündür haber yok</small></a>

      <a class="stat" href="index.php?p=liste&k=backup">
        <span>Yedeği gecikmiş</span>
        <b class="<?= count($overdue) ? 'bad' : '' ?>"><?= count($overdue) ?></b>
        <small>son <?= PANEL_BACKUP_HOURS ?> saatte yedek yok</small></a>

      <a class="stat" href="index.php?p=liste&k=outdated">
        <span>Eski sürümdeki işletme</span>
        <b class="<?= count($outdated) ? 'warn' : '' ?>"><?= count($outdated) ?></b>
        <small><?= $adoption['current'] ? 'güncel: v' . e($adoption['current']) : 'yayınlanmış sürüm yok' ?></small></a>
    </div>

    <?php if ($lapsed): ?>
      <div class="flash bad"><b><?= count($lapsed) ?> işletmenin lisansı süresi geçmiş durumda.</b>
        Bu kasalar çevrimdışı hoşgörü süresi bitince satış yapamaz.
        <a href="index.php?p=liste&k=lapsed">kimler olduğunu gör</a></div>
    <?php endif; ?>
    <?php if (!$customers): ?>
      <div class="flash">Henüz işletme yok. <a href="index.php?p=tenant&id=0">İlk işletmeyi ekleyin</a>
        — kaydettiğinizde lisans anahtarı ve 30 günlük deneme otomatik oluşur.</div>
    <?php endif; ?>

    <div class="cols-2">
      <!-- ---------------- licence runway: names, not a count ---------------- -->
      <section class="card card-tight">
        <h3>Lisans yenileme takvimi
          <span class="sp"></span><a href="index.php?p=liste&k=exp90">90 günün tamamı</a></h3>
        <div class="scroll-x"><table class="grid" style="border:0;border-radius:0">
          <tr><th>İşletme</th><th>Plan</th><th class="r">Kalan</th><th>Bitiş</th></tr>
          <?php
          $shown = array_slice($exp90, 0, 8);
          foreach ($shown as $r):
            $d = (int) $r['days_left'];
            $band = $d <= 30 ? 'pill-suspended' : ($d <= 60 ? 'pill-trial' : 'pill'); ?>
            <tr>
              <td><a class="t-name" href="index.php?p=tenant&id=<?= (int)$r['id'] ?>"><?= e($r['company_name']) ?></a>
                  <div class="t-sub"><?= e($r['email']) ?></div></td>
              <td><?= e($r['plan']) ?><div class="t-sub"><?= (int)$r['seats'] ?> kasa</div></td>
              <td class="r"><span class="pill <?= $band ?>"><?= $d ?> gün</span></td>
              <td class="nums"><?= panel_dt($r['expires_at'], 'd.m.Y') ?></td>
            </tr>
          <?php endforeach;
          if (!$exp90) empty_row(4, 'Önümüzdeki 90 günde biten lisans yok',
              'Yenileme takvimi bugün için boş. Lisans bitişleri 90 güne girdiğinde burada, adlarıyla listelenir.'); ?>
        </table></div>
        <?php if (count($exp90) > 8): ?>
          <div style="padding:10px 18px;border-top:1px solid var(--line-2)">
            <a href="index.php?p=liste&k=exp90"><?= count($exp90) - 8 ?> işletme daha</a></div>
        <?php endif; ?>
      </section>

      <!-- ---------------- version adoption ---------------- -->
      <section class="card">
        <h3>Sürüm dağılımı
          <span class="sp"></span><a href="index.php?p=versions">sürümleri yönet</a></h3>
        <?php if (!$adoption['rows']): ?>
          <?php empty_state('Hiçbir kasa sürüm bildirmedi',
              'Kasalar her yarım saatte bir sürümlerini bildirir. Kurulum yapıldıktan sonra dağılım burada görünür.'); ?>
        <?php else: ?>
          <p class="hint" style="margin-top:-4px">
            <?= $adoption['current'] ? 'Yayındaki sürüm <b>v' . e($adoption['current']) . '</b>. ' : 'Henüz güncel sürüm işaretlenmemiş. ' ?>
            Toplam <?= (int)$adoption['total'] ?> kasa.</p>
          <table>
            <?php foreach ($adoption['rows'] as $r): ?>
              <tr>
                <td style="width:34%">
                  <b><?= $r['unknown'] ? 'bildirmedi' : 'v' . e($r['v']) ?></b>
                  <?php if ($r['current']) echo ' <span class="pill pill-active">güncel</span>';
                        elseif ($r['behind']) echo ' <span class="pill pill-trial">eski</span>'; ?>
                  <div class="t-sub"><?= (int)$r['tenants'] ?> işletme</div>
                </td>
                <td><?php /* magnitude only, one hue, number always printed */
                  meter($r['share'], (int)$r['devices'] . ' kasa · %' . number_format($r['share'] * 100, 0),
                        !$r['current']); ?></td>
              </tr>
            <?php endforeach; ?>
          </table>
          <?php if ($outdated): ?>
            <p class="hint" style="margin:12px 0 0">
              <a href="index.php?p=liste&k=outdated"><?= count($outdated) ?> işletme</a> hâlâ eski bir sürümde.</p>
          <?php endif; ?>
        <?php endif; ?>
      </section>
    </div>

    <div class="cols-2" style="margin-top:14px">
      <!-- ---------------- silence ---------------- -->
      <section class="card card-tight">
        <h3>Sessiz kasalar<span class="sp"></span>
          <?php if ($silent): ?><a href="index.php?p=liste&k=silent">tümü</a><?php endif; ?></h3>
        <div class="scroll-x"><table class="grid" style="border:0;border-radius:0">
          <tr><th>İşletme</th><th>Kasa</th><th class="r">Son bağlantı</th></tr>
          <?php foreach (array_slice($silent, 0, 6) as $r): ?>
            <tr><td><a class="t-name" href="index.php?p=tenant&id=<?= (int)$r['id'] ?>"><?= e($r['company_name']) ?></a>
                    <div class="t-sub"><?= e($r['phone'] ?: $r['email']) ?></div></td>
                <td class="nums"><?= (int)$r['devices'] ?></td>
                <td class="r muted"><?= e(panel_ago($r['last_seen'])) ?></td></tr>
          <?php endforeach;
          if (!$silent) empty_row(3, 'Bütün kasalar bağlantıda',
              'Kurulu her kasa son ' . PANEL_SILENT_DAYS . ' gün içinde haber verdi. Bir kasa sustuğunda burada adıyla çıkar ve müşteriyi arayabilirsiniz.'); ?>
        </table></div>
        <?php if ($noinst): ?>
          <div style="padding:10px 18px;border-top:1px solid var(--line-2)" class="hint">
            Ayrıca <a href="index.php?p=liste&k=noinstall"><?= count($noinst) ?> işletmede</a> hiç kurulum yapılmamış.</div>
        <?php endif; ?>
      </section>

      <!-- ---------------- backups ---------------- -->
      <section class="card card-tight">
        <h3>Yedeği gecikmiş işletmeler<span class="sp"></span>
          <?php if ($overdue): ?><a href="index.php?p=liste&k=backup">tümü</a><?php endif; ?></h3>
        <div class="scroll-x"><table class="grid" style="border:0;border-radius:0">
          <tr><th>İşletme</th><th class="r">Son yedek</th></tr>
          <?php foreach (array_slice($overdue, 0, 6) as $r): ?>
            <tr><td><a class="t-name" href="index.php?p=tenant&id=<?= (int)$r['id'] ?>"><?= e($r['company_name']) ?></a>
                    <div class="t-sub"><?= e($r['phone'] ?: $r['email']) ?></div></td>
                <td class="r muted"><?= $r['last_backup'] ? e(panel_ago($r['last_backup'])) : 'hiç yedek yok' ?></td></tr>
          <?php endforeach;
          if (!$overdue) empty_row(2, 'Yedekler güncel',
              'Kurulu her işletme son ' . PANEL_BACKUP_HOURS . ' saat içinde bulut yedeği gönderdi.'); ?>
        </table></div>
        <div style="padding:10px 18px;border-top:1px solid var(--line-2)" class="hint">
          Panel yalnızca <b>ulaşan</b> yedekleri görür; başarısız bir yükleme iz bırakmaz.
          Bu yüzden liste “başarısız” değil, <b>gecikmiş</b> yedekleri gösterir.</div>
      </section>
    </div>

    <!-- ---------------- today's turnover ---------------- -->
    <div class="sec-head"><h3>Bugünün ciroları</h3>
      <span class="sub">işletmelerin kasalarından gönderdiği özet</span></div>
    <div class="scroll-x"><table class="grid">
      <tr><th>İşletme</th><th class="r">Adisyon</th><th class="r">Ciro</th><th class="r">Geldiği saat</th></tr>
      <?php foreach ($today as $r): $d = json_decode((string)$r['payload'], true); ?>
        <tr><td><a class="t-name" href="index.php?p=tenant&id=<?= (int)$r['id'] ?>"><?= e($r['company_name']) ?></a></td>
            <td class="r"><?= (int)($d['orders'] ?? 0) ?></td>
            <td class="r"><b><?= money($d['total'] ?? 0) ?> ₺</b></td>
            <td class="r muted"><?= panel_dt($r['created_at'], 'H:i') ?></td></tr>
      <?php endforeach;
      if (!$today) empty_row(4, 'Bugün hiçbir kasadan özet gelmedi',
          'Kasalar gün içinde ciro özetini kendiliğinden yollar. Hiç gelmemesi genelde kasaların kapalı ya da internetsiz olduğu anlamına gelir — sessiz kasalar listesi bunu doğrular.',
          ['href' => 'index.php?p=liste&k=silent', 'label' => 'Sessiz kasalar']); ?>
    </table></div>
    <?php
}

/* =================================================================== */
elseif ($p === 'ara') {
    /* Search results come off a POST (see layout.php for why), so a refresh
       re-asks rather than replaying a stale term. */
    $term = trim((string)($_POST['q'] ?? ''));
    $rows = $term === '' ? [] : panel_search($term);
    page_head('Arama', ['eyebrow' => 'İşletme ara',
        'sub' => $term === '' ? 'Üstteki kutuya ünvan, e-posta, lisans anahtarı, vergi numarası ya da cihaz kimliği yazın.'
                              : count($rows) . ' sonuç · “' . $term . '”']);
    if ($term === '') {
        echo '<section class="card">';
        empty_state('Ne arıyorsunuz?',
            'Tek kutu; ünvan, yetkili adı, e-posta, işletme kodu, telefon, vergi numarası, lisans anahtarı ve cihaz kimliği birlikte aranır. Lisans anahtarı ve cihaz kimliği tam eşleşme ister.');
        echo '</section>';
    } elseif (!$rows) {
        echo '<section class="card">';
        empty_state('“' . $term . '” için kayıt yok',
            'Ünvanın bir parçası yeter; lisans anahtarı ve cihaz kimliği ise harfi harfine aranır. Kayıt gerçekten yoksa yeni işletme olarak ekleyebilirsiniz.',
            ['href' => 'index.php?p=tenant&id=0', 'label' => 'Yeni işletme']);
        echo '</section>';
    } else { ?>
      <div class="scroll-x"><table class="grid">
        <tr><th>İşletme</th><th>İletişim</th><th>Lisans</th><th>Bitiş</th><th>Son bağlantı</th><th>Eşleşme</th></tr>
        <?php foreach ($rows as $r): ?>
          <tr>
            <td><a class="t-name" href="index.php?p=tenant&id=<?= (int)$r['id'] ?>"><?= e($r['company_name']) ?></a>
                <div class="t-sub"><?= e($r['code']) ?><?= $r['city'] ? ' · ' . e($r['city']) : '' ?>
                  <?= $r['is_active'] ? '' : ' · <b>pasif</b>' ?></div></td>
            <td><?= e($r['email']) ?><div class="t-sub"><?= e($r['phone']) ?></div></td>
            <td><span class="pill pill-<?= e($r['lic_status']) ?>"><?= e($r['lic_status'] ?: '—') ?></span>
                <div class="t-sub"><?= e($r['plan']) ?> · <?= (int)$r['seats'] ?> kasa</div></td>
            <td class="nums"><?= panel_dt($r['expires_at'], 'd.m.Y') ?></td>
            <td class="muted"><?= e(panel_ago($r['last_seen'])) ?></td>
            <td class="muted"><?= e(implode(', ', $r['why'])) ?></td>
          </tr>
        <?php endforeach; ?>
      </table></div>
    <?php }
}

/* =================================================================== */
elseif ($p === 'liste') {
    /*
     * The other half of every dashboard number: the names behind it.
     *
     * One page, one whitelisted key. The key selects a function; it is never
     * interpolated into SQL, and an unknown key renders the menu rather than
     * an error.
     */
    $k = (string)($_GET['k'] ?? '');
    $kinds = [
      'exp30' => ['30 gün içinde bitecek lisanslar', 'Bu işletmelerin lisansı bir ay içinde doluyor. Yenileme konuşmasını şimdi yapın.', fn() => panel_list_expiring(30), 'licence'],
      'exp60' => ['60 gün içinde bitecek lisanslar', 'İki ay içinde dolan lisanslar.', fn() => panel_list_expiring(60), 'licence'],
      'exp90' => ['90 gün içinde bitecek lisanslar', 'Üç aylık yenileme takvimi, en yakın tarihten başlayarak.', fn() => panel_list_expiring(90), 'licence'],
      'lapsed'=> ['Süresi geçmiş lisanslar', 'Bitiş tarihi geride kalmış lisanslar. Çevrimdışı hoşgörü süresi dolduğunda bu kasalar satış yapamaz.', 'panel_list_lapsed', 'lapsed'],
      'silent'=> ['Sessiz kasalar', 'Kurulumu yapılmış ama ' . PANEL_SILENT_DAYS . ' gündür panele bağlanmayan işletmeler. Kasa kapalı, internet yok ya da kurulum bozulmuş olabilir.', 'panel_list_silent', 'silent'],
      'noinstall' => ['Kurulum yapılmamış işletmeler', 'Kaydı açılmış, lisansı verilmiş, ama hiçbir kasa bağlanmamış işletmeler. Genelde kurulum randevusu bekleyenlerdir.', 'panel_list_never_installed', 'noinstall'],
      'backup'=> ['Yedeği gecikmiş işletmeler', 'Son ' . PANEL_BACKUP_HOURS . ' saatte bulut yedeği ulaşmayan işletmeler. Panel yalnızca ulaşan yedekleri görür; başarısız bir yükleme iz bırakmaz.', 'panel_list_backup_overdue', 'backup'],
      'outdated'=>['Eski sürümdeki işletmeler', 'En az bir kasası yayındaki sürümün altında olan işletmeler. Sürüm bildirmemiş kasalar da güncel sayılmaz.', 'panel_list_outdated', 'outdated'],
      'blocked'=> ['Engellenmiş kasalar', 'Panelden elle engellenmiş kasalar. Engelli bir kasa lisans doğrulamasından geçemez.', 'panel_list_blocked', 'device'],
      'online' => ['Bugün çevrimiçi olan kasalar', 'Gece yarısından bu yana en az bir kez panele bağlanmış kasalar.',
                   fn() => all('SELECT d.*, t.company_name FROM np_devices d JOIN np_tenants t ON t.id=d.tenant_id
                                 WHERE d.last_seen_at >= CURDATE() ORDER BY d.last_seen_at DESC'), 'device'],
    ];

    if (!isset($kinds[$k])) {
        page_head('Listeler', ['eyebrow' => 'Genel bakış', 'sub' => 'Ana ekrandaki her rakamın arkasındaki isimler.']);
        echo '<section class="card"><table>';
        foreach ($kinds as $key => [$t, $d, , ]) {
            echo '<tr><td><a class="t-name" href="index.php?p=liste&k=' . e($key) . '">' . e($t) . '</a>'
               . '<div class="t-sub">' . e($d) . '</div></td></tr>';
        }
        echo '</table></section>';
    } else {
        [$title, $desc, $fn, $shape] = $kinds[$k];
        $rows = panel_try($fn, []);
        page_head($title, ['eyebrow' => 'Genel bakış', 'sub' => $desc,
            'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=home">Panele dön</a>']);
        echo '<div class="row"><b class="nums">' . count($rows) . '</b> <span class="muted">kayıt</span></div>';
        echo '<div class="scroll-x"><table class="grid">';

        if ($shape === 'device') {
            echo '<tr><th>İşletme</th><th>Kasa</th><th>Sürüm</th><th>IP</th><th class="r">Son bağlantı</th></tr>';
            foreach ($rows as $r) {
                echo '<tr><td><a class="t-name" href="index.php?p=tenant&id=' . (int)$r['tenant_id'] . '">'
                   . e($r['company_name']) . '</a></td>'
                   . '<td>' . e($r['device_name'] ?: $r['device_id'])
                   . ($r['is_blocked'] ? ' <span class="pill pill-suspended">engelli</span>' : '')
                   . '<div class="t-sub mono">' . e($r['device_id']) . '</div></td>'
                   . '<td>' . e($r['app_version'] ?: '—') . '</td>'
                   . '<td class="muted mono">' . e($r['last_ip']) . '</td>'
                   . '<td class="r muted">' . e(panel_ago($r['last_seen_at'])) . '</td></tr>';
            }
        } elseif ($shape === 'outdated') {
            echo '<tr><th>İşletme</th><th>İletişim</th><th>En eski kasa</th><th class="r">Kasa</th><th class="r">Son bağlantı</th></tr>';
            foreach ($rows as $r) {
                echo '<tr><td><a class="t-name" href="index.php?p=tenant&id=' . (int)$r['id'] . '">'
                   . e($r['company_name']) . '</a><div class="t-sub">' . e($r['code']) . '</div></td>'
                   . '<td>' . e($r['email']) . '<div class="t-sub">' . e($r['phone']) . '</div></td>'
                   . '<td><b>' . e($r['oldest'] ?: 'bildirmedi') . '</b></td>'
                   . '<td class="r">' . count($r['devices']) . '</td>'
                   . '<td class="r muted">' . e(panel_ago($r['last_seen'])) . '</td></tr>';
            }
        } elseif ($shape === 'backup') {
            echo '<tr><th>İşletme</th><th>İletişim</th><th>Son yedek</th><th class="r">Gecikme</th><th class="r">Kasa son bağlantı</th></tr>';
            foreach ($rows as $r) {
                echo '<tr><td><a class="t-name" href="index.php?p=tenant&id=' . (int)$r['id'] . '">'
                   . e($r['company_name']) . '</a><div class="t-sub">' . e($r['code']) . '</div></td>'
                   . '<td>' . e($r['email']) . '<div class="t-sub">' . e($r['phone']) . '</div></td>'
                   . '<td class="muted">' . ($r['last_backup'] ? panel_dt($r['last_backup']) : 'hiç yedek gelmemiş') . '</td>'
                   . '<td class="r">' . ($r['hours_since'] === null ? '—' : (int)$r['hours_since'] . ' saat') . '</td>'
                   . '<td class="r muted">' . e(panel_ago($r['last_seen'])) . '</td></tr>';
            }
        } elseif ($shape === 'silent') {
            echo '<tr><th>İşletme</th><th>İletişim</th><th>Lisans</th><th class="r">Kasa</th><th class="r">Son bağlantı</th></tr>';
            foreach ($rows as $r) {
                echo '<tr><td><a class="t-name" href="index.php?p=tenant&id=' . (int)$r['id'] . '">'
                   . e($r['company_name']) . '</a><div class="t-sub">' . e($r['code'])
                   . ($r['city'] ? ' · ' . e($r['city']) : '') . '</div></td>'
                   . '<td>' . e($r['email']) . '<div class="t-sub">' . e($r['phone']) . '</div></td>'
                   . '<td><span class="pill pill-' . e($r['lic_status']) . '">' . e($r['lic_status'] ?: '—') . '</span></td>'
                   . '<td class="r">' . (int)$r['devices'] . '</td>'
                   . '<td class="r muted">' . e(panel_ago($r['last_seen']))
                   . '<div class="t-sub">' . ($r['days_quiet'] === null ? '' : (int)$r['days_quiet'] . ' gün') . '</div></td></tr>';
            }
        } elseif ($shape === 'noinstall') {
            echo '<tr><th>İşletme</th><th>İletişim</th><th>Lisans</th><th>Kayıt</th><th class="r">Geçen süre</th></tr>';
            foreach ($rows as $r) {
                echo '<tr><td><a class="t-name" href="index.php?p=tenant&id=' . (int)$r['id'] . '">'
                   . e($r['company_name']) . '</a><div class="t-sub">' . e($r['code']) . '</div></td>'
                   . '<td>' . e($r['email']) . '<div class="t-sub">' . e($r['phone']) . '</div></td>'
                   . '<td><span class="pill pill-' . e($r['lic_status']) . '">' . e($r['lic_status'] ?: '—') . '</span></td>'
                   . '<td class="muted nums">' . panel_dt($r['created_at'], 'd.m.Y') . '</td>'
                   . '<td class="r">' . (int)$r['days_since'] . ' gün</td></tr>';
            }
        } elseif ($shape === 'lapsed') {
            echo '<tr><th>İşletme</th><th>İletişim</th><th>Durum</th><th>Bitiş</th><th class="r">Gecikme</th><th></th></tr>';
            foreach ($rows as $r) {
                echo '<tr><td><a class="t-name" href="index.php?p=tenant&id=' . (int)$r['id'] . '">'
                   . e($r['company_name']) . '</a><div class="t-sub">' . e($r['code']) . '</div></td>'
                   . '<td>' . e($r['email']) . '<div class="t-sub">' . e($r['phone']) . '</div></td>'
                   . '<td><span class="pill pill-' . e($r['status']) . '">' . e($r['status']) . '</span></td>'
                   . '<td class="nums">' . panel_dt($r['expires_at'], 'd.m.Y') . '</td>'
                   . '<td class="r">' . (int)$r['days_over'] . ' gün</td>'
                   . '<td class="r"><a class="btn btn-sm btn-ghost" href="index.php?p=tenant&id=' . (int)$r['id'] . '">Aç</a></td></tr>';
            }
        } else { /* licence */
            echo '<tr><th>İşletme</th><th>İletişim</th><th>Plan</th><th class="r">Kalan</th><th>Bitiş</th><th class="r">Ücret</th><th></th></tr>';
            foreach ($rows as $r) {
                $d = (int)$r['days_left'];
                $band = $d <= 30 ? 'pill-suspended' : ($d <= 60 ? 'pill-trial' : 'pill');
                echo '<tr><td><a class="t-name" href="index.php?p=tenant&id=' . (int)$r['id'] . '">'
                   . e($r['company_name']) . '</a><div class="t-sub">' . e($r['code'])
                   . ($r['city'] ? ' · ' . e($r['city']) : '') . '</div></td>'
                   . '<td>' . e($r['email']) . '<div class="t-sub">' . e($r['phone']) . '</div></td>'
                   . '<td>' . e($r['plan']) . '<div class="t-sub">' . (int)$r['seats'] . ' kasa</div></td>'
                   . '<td class="r"><span class="pill ' . $band . '">' . $d . ' gün</span></td>'
                   . '<td class="nums">' . panel_dt($r['expires_at'], 'd.m.Y') . '</td>'
                   . '<td class="r">' . ($r['price'] !== null ? money($r['price']) . ' ₺' : '—') . '</td>'
                   . '<td class="r"><a class="btn btn-sm btn-ghost" href="index.php?p=tenant&id=' . (int)$r['id'] . '">Aç</a></td></tr>';
            }
        }

        if (!$rows) {
            $cols = 7;
            echo '<tr><td colspan="' . $cols . '">';
            empty_state('Bu listede kimse yok', 'Şu an bu durumda bir işletme bulunmuyor. İyi haber — bu ekran boşken yapılacak bir iş yok demektir.',
                ['href' => 'index.php?p=home', 'label' => 'Panele dön']);
            echo '</td></tr>';
        }
        echo '</table></div>';
    }
}

/* =================================================================== */
elseif ($p === 'tenants') {
    $rows = all('SELECT t.*, l.status lic_status, l.plan, l.expires_at, l.seats, l.licence_key,
                        (SELECT MAX(last_seen_at) FROM np_devices d WHERE d.tenant_id=t.id) last_seen,
                        (SELECT COUNT(*) FROM np_devices d WHERE d.tenant_id=t.id) devices,
                        (SELECT MAX(created_at) FROM np_backups b WHERE b.tenant_id=t.id) last_backup,
                        (SELECT COUNT(*) FROM np_branches br WHERE br.tenant_id=t.id) branches
                   FROM np_tenants t ' . panel_licence_join() . '
                  ORDER BY t.is_active DESC, t.company_name');
    page_head('İşletmeler', ['eyebrow' => 'Müşteriler',
        'sub' => count($rows) . ' kayıtlı işletme',
        'actions' => '<a class="btn btn-sm" href="index.php?p=tenant&id=0">Yeni işletme</a>']);
    ?>
    <div class="scroll-x"><table class="grid">
      <tr><th>İşletme</th><th>İletişim</th><th>Plan</th><th>Lisans</th><th>Bitiş</th>
          <th class="r">Kasa</th><th class="r">Son yedek</th><th class="r">Son bağlantı</th></tr>
      <?php foreach ($rows as $r):
        $online = $r['last_seen'] && strtotime($r['last_seen']) > time() - PANEL_ONLINE_MINUTES * 60;
        $expSoon = $r['expires_at'] && strtotime($r['expires_at']) < time() + 30 * 86400; ?>
        <tr>
          <td><a class="t-name" href="index.php?p=tenant&id=<?= $r['id'] ?>"><?= e($r['company_name']) ?></a>
              <div class="t-sub"><?= e($r['code']) ?><?= $r['city'] ? ' · ' . e($r['city']) : '' ?>
                <?php if ((int)$r['branches'] >= 2) echo ' · ' . (int)$r['branches'] . ' şube'; ?>
                <?php if (!$r['is_active']) echo ' · <b>pasif</b>'; ?></div></td>
          <td><?= e($r['email']) ?><div class="t-sub"><?= e($r['phone']) ?></div></td>
          <td><?= e($r['plan']) ?><div class="t-sub"><?= (int)$r['seats'] ?> kasa hakkı</div></td>
          <td><span class="pill pill-<?= e($r['lic_status']) ?>"><?= e($r['lic_status'] ?: '—') ?></span></td>
          <td class="nums <?= $expSoon ? 'warn' : '' ?>"><?= panel_dt($r['expires_at'], 'd.m.Y') ?></td>
          <td class="r"><?= (int)$r['devices'] ?></td>
          <td class="r muted"><?= e(panel_ago($r['last_backup'])) ?></td>
          <td class="r"><?= $online ? '<span class="pill pill-active">çevrimiçi</span>'
                                    : '<span class="muted">' . e(panel_ago($r['last_seen'])) . '</span>' ?></td>
        </tr>
      <?php endforeach;
      if (!$rows) empty_row(8, 'Henüz işletme yok',
          'İlk müşteriyi eklediğinizde lisans anahtarı ve 30 günlük deneme otomatik oluşturulur.',
          ['href' => 'index.php?p=tenant&id=0', 'label' => 'Yeni işletme']); ?>
    </table></div>
    <?php
}

/* =================================================================== */
elseif ($p === 'tenant') {
    require __DIR__ . '/tenant.php';
}

/* =================================================================== */
elseif ($p === 'devices') {
    $rows = all('SELECT d.*, t.company_name FROM np_devices d JOIN np_tenants t ON t.id=d.tenant_id
                  ORDER BY d.last_seen_at IS NULL, d.last_seen_at DESC LIMIT 300');
    $cur = panel_current_version();
    page_head('Kasa bilgisayarları', ['eyebrow' => 'Kurulumlar',
        'sub' => panel_count_online_now() . ' kasa şu an çevrimiçi · '
                 . panel_count_online_today() . ' kasa bugün bağlandı',
        'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=liste&k=blocked">Engelliler</a>']);
    ?>
    <div class="scroll-x"><table class="grid">
      <tr><th>İşletme</th><th>Kasa</th><th>Sürüm</th><th>IP</th><th class="r">Son bağlantı</th><th class="r">İşlem</th></tr>
      <?php foreach ($rows as $r):
        $old = $cur && (string)$r['app_version'] !== '' && version_compare($r['app_version'], $cur['version'], '<'); ?>
        <tr>
          <td><a class="t-name" href="index.php?p=tenant&id=<?= $r['tenant_id'] ?>"><?= e($r['company_name']) ?></a></td>
          <td><?= e($r['device_name'] ?: $r['device_id']) ?>
              <?= $r['is_blocked'] ? ' <span class="pill pill-suspended">engelli</span>' : '' ?>
              <div class="t-sub mono"><?= e($r['device_id']) ?></div></td>
          <td><?= e($r['app_version'] ?: '—') ?><?= $old ? ' <span class="pill pill-trial">eski</span>' : '' ?></td>
          <td class="muted mono"><?= e($r['last_ip']) ?></td>
          <td class="r muted"><?= e(panel_ago($r['last_seen_at'])) ?></td>
          <td class="r"><form method="post" class="inline"><input type="hidden" name="csrf" value="<?= csrf() ?>">
            <input type="hidden" name="action" value="device_block"><input type="hidden" name="id" value="<?= $r['id'] ?>">
            <input type="hidden" name="blocked" value="<?= $r['is_blocked'] ? 0 : 1 ?>">
            <button class="btn btn-sm <?= $r['is_blocked'] ? 'btn-ghost' : 'btn-danger' ?>"><?= $r['is_blocked'] ? 'Engeli kaldır' : 'Engelle' ?></button></form></td>
        </tr>
      <?php endforeach;
      if (!$rows) empty_row(6, 'Hiç kurulum yok',
          'Bir kasaya NOKTApp POS kurulup lisans anahtarı girildiğinde burada kendiliğinden görünür.'); ?>
    </table></div><?php
}

/* =================================================================== */
elseif ($p === 'backups') {
    $rows = all('SELECT b.*, t.company_name FROM np_backups b JOIN np_tenants t ON t.id=b.tenant_id
                  ORDER BY b.id DESC LIMIT 300');
    $ok = panel_count_backup_ok();
    $late = panel_count_backup_overdue();
    /*
     * Is the file still there? A row in np_backups is a claim, and the whole
     * value of this screen rests on the claim being true on the morning
     * somebody rings up having lost their PC. A record whose file has been
     * cleaned off the disk looks identical to a good one until you click it,
     * so it is stat'ed here and said out loud.
     */
    $gone = 0;
    foreach ($rows as $i => $r) {
        $rows[$i]['on_disk'] = backup_path($r) !== null;
        if (!$rows[$i]['on_disk']) $gone++;
    }
    page_head('Bulut yedekleri', ['eyebrow' => 'Yedekleme',
        'sub' => $ok . ' işletme son ' . PANEL_BACKUP_HOURS . ' saatte yedek gönderdi · ' . $late . ' işletme gecikti',
        'actions' => $late ? '<a class="btn btn-ghost btn-sm" href="index.php?p=liste&k=backup">Gecikenler</a>' : '']);
    if ($gone): ?>
      <div class="flash bad"><b><?= $gone ?> yedek kaydının dosyası sunucuda yok.</b>
        Bu işletmeler için elimizde geri verilecek bir şey yok — kasalar da bu geceleri
        listelerinde görmez. Kayıt duruyor diye yedek durduğunu varsaymayın.</div>
    <?php endif; ?>
    <div class="scroll-x"><table class="grid">
      <tr><th>İşletme</th><th>Dosya</th><th class="r">Boyut</th><th class="r">Tarih</th><th class="r">İşlem</th></tr>
      <?php foreach ($rows as $r): ?><tr>
        <td><a class="t-name" href="index.php?p=tenant&id=<?= $r['tenant_id'] ?>"><?= e($r['company_name']) ?></a></td>
        <td class="mono"><?= e($r['filename']) ?>
          <?= $r['on_disk'] ? '' : '<div><span class="pill pill-suspended">dosya yok</span></div>' ?></td>
        <td class="r"><?= panel_mb((int)$r['size_bytes']) ?></td>
        <td class="r muted"><?= panel_dt($r['created_at']) ?></td>
        <?php /* The link goes through index.php, never at the file: backups sit
                 outside public_html and the only way to one is a checked
                 session. Every press leaves an audit row - see admin/yedek.php. */ ?>
        <td class="r"><?php if ($r['on_disk']): ?>
          <a class="btn btn-sm btn-ghost" href="index.php?p=backups&download=<?= (int)$r['id'] ?>">İndir</a>
        <?php else: ?>
          <span class="muted" style="font-size:12px">indirilemez</span>
        <?php endif; ?></td></tr><?php endforeach;
      if (!$rows) empty_row(5, 'Henüz yedek gelmemiş',
          'Kasalar her gece kapanıştan sonra veritabanını buraya yükler. İlk yedek kurulumdan sonraki ilk gün sonunda gelir.'); ?>
    </table></div><?php
}

/* =================================================================== */
elseif ($p === 'relay') {
    $rows = all('SELECT r.*, t.company_name FROM np_relay_messages r JOIN np_tenants t ON t.id=r.tenant_id
                  ORDER BY r.id DESC LIMIT 200');
    $stuck = (int) val("SELECT COUNT(*) FROM np_relay_messages WHERE status='queued' AND created_at < DATE_SUB(NOW(), INTERVAL 60 SECOND)");
    page_head('Telefon relay trafiği', ['eyebrow' => 'Garson telefonları',
        'sub' => 'Garson telefonlarının kasaya ulaşmak için kullandığı kuyruk. Son 200 istek gösteriliyor.']);
    if ($stuck) echo '<div class="flash bad">' . $stuck . ' istek kasaya ulaşamadı — o işletmelerin bilgisayarı kapalı olabilir.</div>'; ?>
    <div class="scroll-x"><table class="grid">
      <tr><th>İşletme</th><th>İstek</th><th>Durum</th><th class="r">Geldi</th><th class="r">Cevap</th></tr>
      <?php foreach ($rows as $r): ?><tr>
        <td><a class="t-name" href="index.php?p=tenant&id=<?= $r['tenant_id'] ?>"><?= e($r['company_name']) ?></a></td>
        <td class="mono"><?= e($r['method'] . ' ' . $r['path']) ?></td>
        <td><span class="pill pill-<?= e($r['status']) ?>"><?= e($r['status']) ?></span></td>
        <td class="r muted"><?= e(substr($r['created_at'], 11, 8)) ?></td>
        <td class="r muted"><?= e(substr((string)$r['answered_at'], 11, 8) ?: '—') ?></td></tr><?php endforeach;
      if (!$rows) empty_row(5, 'Relay trafiği yok',
          'Bir garson telefonu kasaya bağlanamadığında istek buradan geçer. Boş olması her telefonun kasayı yerel ağda bulduğu anlamına gelir — istenen durum budur.'); ?>
    </table></div><?php
}

/* =================================================================== */
elseif ($p === 'versions') {
    require __DIR__ . '/versions.php';
}

/* =================================================================== */
elseif (chain_is_page($p)) {
    /* branches / menu / menuversions / exceptions - see admin/chain.php */
    chain_page($p);
}

elseif (rapor_is_page($p)) {
    /* the head-office consolidated report - see admin/rapor.php */
    rapor_page();
}

/* =================================================================== */
elseif ($p === 'audit') {
    $rows = all('SELECT * FROM np_audit ORDER BY id DESC LIMIT 300');
    page_head('İşlem kayıtları', ['eyebrow' => 'Denetim',
        'sub' => 'Panelde ve kasalarda yapılan her işlem. Son 300 kayıt.']);
    ?>
    <div class="scroll-x"><table class="grid">
      <tr><th>Zaman</th><th>Kim</th><th>İşlem</th><th>Konu</th><th>Detay</th><th>IP</th></tr>
      <?php foreach ($rows as $r): ?><tr>
        <td class="muted nums"><?= panel_dt($r['created_at']) ?></td>
        <td><?= e($r['actor']) ?></td><td class="mono"><?= e($r['action']) ?></td>
        <td><?= e($r['subject']) ?></td>
        <td class="muted mono"><?= e(mb_substr((string)$r['detail'], 0, 90)) ?></td>
        <td class="muted mono"><?= e($r['ip']) ?></td></tr><?php endforeach;
      if (!$rows) empty_row(6, 'Kayıt yok', 'Panelde bir işlem yapıldığında burada iz bırakır.'); ?>
    </table></div><?php
}

/* =================================================================== */
/*
 * Anything the branches above did not claim.
 *
 * Two things can be true here. Either a screen the sidebar offers has a
 * drop-in file at admin/pages/<key>.php - include it and it is that page's
 * turn - or the sidebar offers it and nobody has built it yet, in which case
 * it gets the "hazırlanıyor" notice. Only an address that is in neither place
 * is a 404. This ordering is the whole hand-off: a new area needs a line in
 * admin/nav.php and a handler, and nothing in the shell is edited to switch
 * the notice off. See admin/nav.php.
 */
elseif (nav_knows($p) && is_file(__DIR__ . '/pages/' . preg_replace('~[^a-z0-9_]~', '', $p) . '.php')) {
    require __DIR__ . '/pages/' . preg_replace('~[^a-z0-9_]~', '', $p) . '.php';
}

elseif (nav_knows($p)) {
    pending_page($p);
}

else {
    page_head('Sayfa bulunamadı', ['sub' => 'Aradığınız ekran yok ya da adresi değişmiş olabilir.']);
    echo '<section class="card">';
    empty_state('Böyle bir sayfa yok', 'Adres yanlış yazılmış olabilir. Panelin ana ekranından devam edin.',
        ['href' => 'index.php?p=home', 'label' => 'Panele dön']);
    echo '</section>';
}

layout_foot();
