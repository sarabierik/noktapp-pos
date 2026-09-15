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
 * /bayi/ - the reseller's own panel.
 *
 * A reseller sees their own customers and nothing else: not another reseller's
 * customers, not another reseller's existence, and not one figure about the
 * vendor's business as a whole. Every read below goes through a bayi_* function
 * in lib/para.php that takes the reseller id as its first argument and puts it
 * in the WHERE clause, so a guessed `?id=` returns NOTHING from the database
 * rather than a row this file then has to remember to reject.
 *
 * The screens, in the order a reseller uses them:
 *   home        what needs me - expiring licences, unpaid invoices, commission
 *   musteriler  my customers
 *   musteri     one of my customers
 *   faturalar   my customers' invoices
 *   fatura      one invoice
 *   odemeler    my customers' payments
 *   komisyon    what I have earned, month by month, and how it is worked out
 */
require_once __DIR__ . '/shell.php';

$p = $_GET['p'] ?? 'home';

/* ------------------------------- login ---------------------------------- */
if ($p === 'login') {
    $err = '';
    if (!empty($_GET['x'])) $err = 'Bayi hesabınız pasife alınmış. Lütfen NOKTApp ile görüşün.';
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $email = strtolower(trim($_POST['email'] ?? ''));
        $r = bayi_by_email($email);
        if ($r && $r['password_hash'] && password_verify($_POST['password'] ?? '', $r['password_hash'])) {
            /* A fresh id on sign-in: the reseller and the administrator must
               never end up sharing a session identifier on a shared machine. */
            session_regenerate_id(true);
            $_SESSION['bayi'] = ['id' => (int) $r['id'], 'email' => $r['email'], 'name' => $r['name']];
            q('UPDATE np_resellers SET last_login_at=NOW() WHERE id=?', [$r['id']]);
            $GLOBALS['np_actor'] = 'bayi:' . $r['email'];
            audit('bayi.login', $r['email']);
            header('Location: index.php?p=home'); exit;
        }
        /* One message for both "no such reseller" and "wrong password": which
           of the two it was is not the visitor's business. */
        $err = 'E-posta veya şifre hatalı';
    }
    ?><!doctype html><html lang="tr"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Bayi girişi · NOKTApp POS</title><link rel="stylesheet" href="<?= np_css() ?>"></head>
    <body class="login-body"><div class="login-split">
      <div class="login-art">
        <div class="brand"><span class="mark"></span> NOKTApp POS <em>bayi</em></div>
        <div class="art-mid">
          <h1>Bayi paneli</h1>
          <p class="lede">Sattığınız işletmeler, lisanslarının durumu, kesilen faturalar,
             tahsilatlar ve hak ettiğiniz komisyon — tek yerde.</p>
          <div class="facts">
            <div><b>Yalnızca</b><span>kendi müşterileriniz</span></div>
            <div><b>7/24</b><span>lisans durumu</span></div>
          </div>
        </div>
        <p class="foot">pos.noktapp.com · bayi girişi</p>
      </div>
      <div class="login-form"><form method="post" class="box">
        <h2>Bayi girişi</h2>
        <p class="lead">NOKTApp'in size verdiği bayi hesabıyla devam edin.</p>
        <?php if ($err) echo '<div class="alert">' . e($err) . '</div>'; ?>
        <label>E-posta<input name="email" type="email" required autofocus autocomplete="username"
               value="<?= e($_POST['email'] ?? '') ?>"></label>
        <label>Şifre<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="btn">Giriş yap</button>
        <p class="note">Burası bayi kapısıdır. NOKTApp yönetici paneli ayrıdır ve buradan açılmaz;
           restoran sahipleri ise kendi kasalarından giriş yapar.</p>
      </form></div>
    </div></body></html><?php
    exit;
}

if ($p === 'logout') { session_destroy(); header('Location: index.php?p=login'); exit; }

$me = require_bayi();
$rid = (int) $me['id'];
$GLOBALS['np_actor'] = 'bayi:' . $me['email'];

/* An overdue invoice must read as overdue here too. Touching the global flag
   is not a leak: it changes no figure this reseller can see beyond their own
   rows, and letting it drift would show a reseller "gönderildi" for an invoice
   the vendor is already chasing. */
para_touch_overdue();

$titles = ['home' => 'Genel', 'musteriler' => 'Müşterilerim', 'musteri' => 'Müşteri',
           'faturalar' => 'Faturalar', 'fatura' => 'Fatura', 'odemeler' => 'Tahsilatlar',
           'komisyon' => 'Komisyonum'];
bayi_head($titles[$p] ?? 'Bayi paneli', $me);

/* ======================================================================== */
if ($p === 'home') {
    $tot = bayi_totals($rid);
    $customers = bayi_customers($rid);

    /* Expiring licences - among THIS reseller's customers only. Computed from
       the list that is already scoped rather than by a second query, so there
       is no chance of the two disagreeing. */
    $expiring = [];
    foreach ($customers as $c) {
        if (!$c['expires_at'] || !in_array((string) $c['lic_status'], ['active', 'trial'], true)) continue;
        $days = (int) floor((strtotime($c['expires_at']) - time()) / 86400);
        if ($days <= 45) { $c['days_left'] = $days; $expiring[] = $c; }
    }
    usort($expiring, fn($a, $b) => $a['days_left'] <=> $b['days_left']);

    $openInv = [];
    foreach (bayi_invoices($rid, null, 200) as $i) {
        if (!in_array($i['status'], ['sent', 'overdue'], true)) continue;
        $left = para_k($i['total']) - para_k($i['paid']);
        if ($left > 0) { $i['left'] = $left; $openInv[] = $i; }
    }

    bayi_page_head('Genel', ['eyebrow' => 'Bayi · ' . $me['code'],
        'sub' => $me['name'] . ' · ' . $tot['customers'] . ' müşteri']);
    ?>
    <div class="stats">
      <a class="stat" href="index.php?p=musteriler"><span>Müşterim</span><b><?= $tot['customers'] ?></b>
        <small><?= $tot['live'] ?> aktif hesap</small></a>
      <div class="stat"><span>Yakında bitecek lisans</span>
        <b class="<?= $expiring ? 'warn' : '' ?>"><?= count($expiring) ?></b>
        <small>45 gün içinde</small></div>
      <a class="stat" href="index.php?p=faturalar"><span>Müşterilerimin açık bakiyesi</span>
        <b style="font-size:23px"><?= e(para_tl($tot['open'])) ?></b>
        <small><?= e(para_tl($tot['collected'])) ?> tahsil edildi</small></a>
      <a class="stat" href="index.php?p=komisyon"><span>Komisyonum</span>
        <b style="font-size:23px"><?= e(para_tl($tot['commission'])) ?></b>
        <small>%<?= e(number_format($tot['pct'], 2, ',', '.')) ?> · ödenmiş faturalar üzerinden</small></a>
    </div>

    <div class="detail">
    <div>
      <div class="sec-head" style="margin-top:0"><h3>Lisansı yakında bitecek müşterilerim</h3>
        <span class="sub">45 gün içinde · en yakın önce</span></div>
      <div class="scroll-x"><table class="grid">
        <tr><th>İşletme</th><th>Plan</th><th>Lisans</th><th class="r">Bitiş</th><th class="r">Kalan</th></tr>
        <?php foreach ($expiring as $c): ?>
          <tr><td><a class="t-name" href="index.php?p=musteri&id=<?= (int) $c['id'] ?>"><?= e($c['company_name']) ?></a>
                  <div class="t-sub"><?= e($c['code']) ?><?= $c['city'] ? ' · ' . e($c['city']) : '' ?></div></td>
              <td><?= e($c['plan'] ?: '—') ?></td>
              <td><span class="pill pill-<?= e($c['lic_status']) ?>"><?= e($c['lic_status']) ?></span></td>
              <td class="r nums"><?= bayi_dt($c['expires_at']) ?></td>
              <td class="r nums"><b><?= $c['days_left'] < 0 ? abs($c['days_left']) . ' gün geçti' : $c['days_left'] . ' gün' ?></b></td></tr>
        <?php endforeach;
        if (!$expiring) bayi_empty_row(5, 'Yakında biten lisans yok',
            'Müşterilerinizin hiçbirinin lisansı önümüzdeki 45 gün içinde bitmiyor. Bu ekran boşken '
          . 'arayacağınız kimse yok demektir.',
            ['href' => 'index.php?p=musteriler', 'label' => 'Müşterilerim']); ?>
      </table></div>

      <div class="sec-head"><h3>Ödenmemiş faturalar</h3>
        <span class="sub">müşterilerime kesilmiş ve hâlâ açık</span></div>
      <div class="scroll-x"><table class="grid">
        <tr><th>Fatura</th><th>İşletme</th><th class="r">Toplam</th><th class="r">Kalan</th>
            <th>Durum</th><th class="r">Vade</th></tr>
        <?php foreach (array_slice($openInv, 0, 12) as $i): $late = para_ageing_days($i); ?>
          <tr><td><a class="t-name" href="index.php?p=fatura&id=<?= (int) $i['id'] ?>"><?= e($i['no']) ?></a>
                  <div class="t-sub"><?= bayi_dt($i['issued_at']) ?></div></td>
              <td><?= e($i['company_name']) ?></td>
              <td class="r nums"><?= e(para_tl(para_k($i['total']))) ?></td>
              <td class="r nums"><b><?= e(para_tl($i['left'])) ?></b></td>
              <td><span class="pill <?= e(para_status_pill($i['status'])) ?>"><?= e(para_status_label($i['status'])) ?></span></td>
              <td class="r nums"><?= bayi_dt($i['due_at']) ?>
                  <?= $late ? '<div class="t-sub"><b>' . $late . ' gün gecikti</b></div>' : '' ?></td></tr>
        <?php endforeach;
        if (!$openInv) bayi_empty_row(6, 'Açık fatura yok',
            'Müşterilerinizin kesilmiş her faturası tahsil edilmiş durumda.'); ?>
      </table></div>
    </div>

    <aside class="rail">
      <section class="card">
        <h3>Komisyonum nasıl hesaplanıyor</h3>
        <table>
          <tr><td>Oranım</td><td class="r"><b>%<?= e(number_format($tot['pct'], 2, ',', '.')) ?></b></td></tr>
          <tr><td>Hesap tabanı<div class="t-sub">ödenmiş faturaların KDV hariç tutarı</div></td>
              <td class="r nums"><?= e(para_tl($tot['base'])) ?></td></tr>
          <tr><td><b>Komisyon</b></td><td class="r nums"><b><?= e(para_tl($tot['commission'])) ?></b></td></tr>
          <tr><td colspan="2"><a href="index.php?p=komisyon">ay ay dökümü</a></td></tr>
        </table>
        <p class="hint" style="margin:10px 0 0">KDV devletin payıdır, komisyona girmez.
          Tahsil edilmemiş fatura komisyon doğurmaz; kısmi ödeme de fatura kapanana kadar saymaz.</p>
      </section>
      <section class="card">
        <h3>Bu panelde ne var</h3>
        <table>
          <tr><td>Görebildikleriniz<div class="t-sub">yalnızca sizin sattığınız işletmeler,
              onların lisansları, faturaları ve tahsilatları</div></td></tr>
          <tr><td>Göremedikleriniz<div class="t-sub">diğer bayilerin müşterileri, NOKTApp'in
              geneline ait ciro ve alacak rakamları</div></td></tr>
        </table>
      </section>
    </aside>
    </div>
    <?php
}

/* ======================================================================== */
elseif ($p === 'musteriler') {
    $customers = bayi_customers($rid);
    bayi_page_head('Müşterilerim', ['eyebrow' => 'Müşteriler',
        'sub' => count($customers) . ' işletme size bağlı']);
    ?>
    <div class="scroll-x"><table class="grid">
      <tr><th>İşletme</th><th>İletişim</th><th>Plan</th><th>Lisans</th><th class="r">Bitiş</th>
          <th class="r">Kasa</th><th class="r">Bakiye</th></tr>
      <?php foreach ($customers as $c):
        $bal = para_tenant_balance((int) $c['id']); ?>
        <tr>
          <td><a class="t-name" href="index.php?p=musteri&id=<?= (int) $c['id'] ?>"><?= e($c['company_name']) ?></a>
              <div class="t-sub"><?= e($c['code']) ?><?= $c['city'] ? ' · ' . e($c['city']) : '' ?>
                <?= $c['is_active'] ? '' : ' · <b>pasif</b>' ?></div></td>
          <td><?= e($c['email']) ?><div class="t-sub"><?= e($c['phone']) ?></div></td>
          <td><?= e($c['plan'] ?: '—') ?></td>
          <td><span class="pill pill-<?= e($c['lic_status'] ?: 'out') ?>"><?= e($c['lic_status'] ?: '—') ?></span></td>
          <td class="r nums"><?= bayi_dt($c['expires_at']) ?></td>
          <td class="r"><?= (int) $c['devices'] ?></td>
          <td class="r nums"><?= e(para_tl($bal['balance'])) ?></td>
        </tr>
      <?php endforeach;
      if (!$customers) bayi_empty_row(7, 'Henüz müşteriniz yok',
          'Sattığınız bir işletme NOKTApp tarafından hesabınıza bağlandığında burada görünür.'); ?>
    </table></div>
    <?php
}

/* ======================================================================== */
elseif ($p === 'musteri') {
    /* Scoped read. A reseller typing another reseller's tenant id here gets
       null from the database - not a row that this file then has to reject. */
    $t = bayi_tenant($rid, (int) ($_GET['id'] ?? 0));
    if (!$t) {
        bayi_page_head('Müşteri bulunamadı', ['eyebrow' => 'Müşteriler',
            'sub' => 'Bu işletme size bağlı değil ya da adres yanlış.']);
        echo '<section class="card">';
        bayi_empty('Kayıt yok', 'Yalnızca kendi müşterilerinizi görüntüleyebilirsiniz.',
            ['href' => 'index.php?p=musteriler', 'label' => 'Müşterilerim']);
        echo '</section>';
    } else {
        $tid = (int) $t['id'];
        $lic = one('SELECT * FROM np_licences WHERE tenant_id=? ORDER BY id DESC LIMIT 1', [$tid]);
        $devs = all('SELECT * FROM np_devices WHERE tenant_id=? ORDER BY last_seen_at IS NULL, last_seen_at DESC', [$tid]);
        $bal = para_tenant_balance($tid);
        $invs = bayi_invoices($rid, $tid, 30);
        $pays = bayi_payments($rid, $tid, 15);
        $daysLeft = ($lic && $lic['expires_at']) ? (int) floor((strtotime($lic['expires_at']) - time()) / 86400) : null;

        bayi_page_head($t['company_name'], [
            'eyebrow' => 'Müşterim · ' . $t['code'],
            'sub' => trim(($t['owner_name'] ? $t['owner_name'] . ' · ' : '') . $t['email']
                     . ($t['phone'] ? ' · ' . $t['phone'] : '') . ($t['city'] ? ' · ' . $t['city'] : '')),
            'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=musteriler">Müşterilerim</a>']);
        ?>
        <div class="stats">
          <div class="stat"><span>Lisans</span>
            <b class="<?= $daysLeft !== null && $daysLeft < 0 ? 'bad' : ($daysLeft !== null && $daysLeft <= 30 ? 'warn' : '') ?>"><?php
              echo $daysLeft === null ? '—' : ($daysLeft < 0 ? abs($daysLeft) . ' gün geçti' : $daysLeft . ' gün'); ?></b>
            <small><?= e($lic['status'] ?? '—') ?> · <?= e($lic['plan'] ?? '—') ?> ·
              bitiş <?= bayi_dt($lic['expires_at'] ?? null) ?></small></div>
          <div class="stat"><span>Kasa</span><b><?= count($devs) ?> / <?= (int) ($lic['seats'] ?? 0) ?></b>
            <small>kurulu kasa / lisanslı kasa</small></div>
          <div class="stat"><span>Kesilen</span><b style="font-size:23px"><?= e(para_tl($bal['invoiced'])) ?></b>
            <small>KDV dahil · matrah <?= e(para_tl($bal['net'])) ?></small></div>
          <div class="stat"><span>Bakiye</span>
            <b style="font-size:23px" class="<?= $bal['overdue'] > 0 ? 'bad' : ($bal['balance'] > 0 ? 'warn' : '') ?>"><?= e(para_tl($bal['balance'])) ?></b>
            <small><?= e(para_tl($bal['paid'])) ?> tahsil edildi</small></div>
        </div>

        <div class="detail">
        <div>
          <div class="sec-head" style="margin-top:0"><h3>Faturalar</h3>
            <span class="sub"><?= count($invs) ?> fatura</span></div>
          <div class="scroll-x"><table class="grid">
            <tr><th>Fatura</th><th>Dönem</th><th class="r">Matrah</th><th class="r">KDV</th>
                <th class="r">Toplam</th><th class="r">Kalan</th><th>Durum</th></tr>
            <?php foreach ($invs as $i):
              $tK = para_k($i['total']); $pK = para_k($i['paid']); ?>
              <tr><td><a class="t-name" href="index.php?p=fatura&id=<?= (int) $i['id'] ?>"><?= e($i['no']) ?></a>
                      <div class="t-sub"><?= bayi_dt($i['issued_at']) ?></div></td>
                  <td class="nums muted"><?= $i['period_start']
                      ? bayi_dt($i['period_start']) . '<div class="t-sub">' . bayi_dt($i['period_end']) . '</div>' : '—' ?></td>
                  <td class="r nums"><?= e(para_tl(para_k($i['amount']))) ?></td>
                  <td class="r nums muted"><?= e(para_tl(para_invoice_vat_k($i))) ?></td>
                  <td class="r nums"><b><?= e(para_tl($tK)) ?></b></td>
                  <td class="r nums"><?= $tK > $pK ? e(para_tl($tK - $pK)) : '<span class="muted">—</span>' ?></td>
                  <td><span class="pill <?= e(para_status_pill($i['status'])) ?>"><?= e(para_status_label($i['status'])) ?></span></td></tr>
            <?php endforeach;
            if (!$invs) bayi_empty_row(7, 'Fatura yok', 'Bu müşteriye henüz fatura kesilmemiş.'); ?>
          </table></div>

          <div class="sec-head"><h3>Kasalar</h3><span class="sub"><?= count($devs) ?> kurulu</span></div>
          <div class="scroll-x"><table class="grid">
            <tr><th>Kasa</th><th>Sürüm</th><th class="r">İlk kurulum</th><th class="r">Son bağlantı</th></tr>
            <?php foreach ($devs as $d): ?>
              <tr><td><b><?= e($d['device_name'] ?: $d['device_id']) ?></b>
                      <?= $d['is_blocked'] ? ' <span class="pill pill-suspended">engelli</span>' : '' ?></td>
                  <td><?= e($d['app_version'] ?: '—') ?><div class="t-sub"><?= e($d['os']) ?></div></td>
                  <td class="r nums muted"><?= bayi_dt($d['first_seen_at']) ?></td>
                  <td class="r muted nums"><?= bayi_dt($d['last_seen_at'], 'd.m.Y H:i') ?></td></tr>
            <?php endforeach;
            if (!$devs) bayi_empty_row(4, 'Kurulum yok',
                'Lisans anahtarı bir kasaya girildiğinde kasa kendini kaydeder ve burada görünür.'); ?>
          </table></div>
        </div>

        <aside class="rail">
          <section class="card"><h3>Hesap</h3>
            <table>
              <tr><td>Kesilen <span class="t-sub">KDV dahil</span></td><td class="r nums"><?= e(para_tl($bal['invoiced'])) ?></td></tr>
              <tr><td>Matrah <span class="t-sub">KDV hariç</span></td><td class="r nums muted"><?= e(para_tl($bal['net'])) ?></td></tr>
              <tr><td>KDV</td><td class="r nums muted"><?= e(para_tl($bal['vat'])) ?></td></tr>
              <tr><td>Tahsil edilen</td><td class="r nums"><?= e(para_tl($bal['paid'])) ?></td></tr>
              <tr><td><b>Bakiye</b></td><td class="r nums"><b><?= e(para_tl($bal['balance'])) ?></b></td></tr>
            </table>
          </section>
          <section class="card"><h3>Son tahsilatlar</h3>
            <table>
              <?php foreach ($pays as $pp): ?>
                <tr><td><?= bayi_dt($pp['paid_at']) ?>
                        <div class="t-sub"><?= e(para_method_label($pp['method'])) ?><?php
                          if ($pp['invoice_no']) echo ' · ' . e($pp['invoice_no']); ?></div></td>
                    <td class="r nums"><b><?= e(para_tl(para_k($pp['amount']))) ?></b></td></tr>
              <?php endforeach;
              if (!$pays) { echo '<tr><td>'; bayi_empty('Tahsilat yok', 'Bu müşteriden henüz ödeme kaydedilmemiş.'); echo '</td></tr>'; } ?>
            </table>
          </section>
        </aside>
        </div>
        <?php
    }
}

/* ======================================================================== */
elseif ($p === 'faturalar') {
    $invs = bayi_invoices($rid, null, 200);
    $tot = bayi_totals($rid);
    bayi_page_head('Faturalar', ['eyebrow' => 'Para',
        'sub' => 'Müşterilerime kesilen faturalar · ' . para_tl($tot['open']) . ' hâlâ açık']);
    ?>
    <div class="scroll-x"><table class="grid">
      <tr><th>Fatura</th><th>İşletme</th><th>Dönem</th><th class="r">Matrah</th><th class="r">KDV</th>
          <th class="r">Toplam</th><th class="r">Kalan</th><th>Durum</th><th class="r">Vade</th></tr>
      <?php foreach ($invs as $i):
        $tK = para_k($i['total']); $pK = para_k($i['paid']); $late = para_ageing_days($i); ?>
        <tr>
          <td><a class="t-name" href="index.php?p=fatura&id=<?= (int) $i['id'] ?>"><?= e($i['no']) ?></a>
              <div class="t-sub"><?= bayi_dt($i['issued_at']) ?></div></td>
          <td><a href="index.php?p=musteri&id=<?= (int) $i['tenant_id'] ?>"><?= e($i['company_name']) ?></a></td>
          <td class="nums muted"><?= $i['period_start'] ? bayi_dt($i['period_start']) : '—' ?></td>
          <td class="r nums"><?= e(para_tl(para_k($i['amount']))) ?></td>
          <td class="r nums muted"><?= e(para_tl(para_invoice_vat_k($i))) ?></td>
          <td class="r nums"><b><?= e(para_tl($tK)) ?></b></td>
          <td class="r nums"><?= $tK > $pK ? e(para_tl($tK - $pK)) : '<span class="muted">—</span>' ?></td>
          <td><span class="pill <?= e(para_status_pill($i['status'])) ?>"><?= e(para_status_label($i['status'])) ?></span></td>
          <td class="r nums"><?= bayi_dt($i['due_at']) ?>
              <?= $late && $tK > $pK ? '<div class="t-sub"><b>' . $late . ' gün</b></div>' : '' ?></td>
        </tr>
      <?php endforeach;
      if (!$invs) bayi_empty_row(9, 'Fatura yok',
          'Müşterilerinize henüz fatura kesilmemiş. Faturalar NOKTApp tarafından kesilir; '
        . 'burada yalnızca kendi müşterilerinizinkini görürsünüz.'); ?>
    </table></div>
    <?php
}

/* ======================================================================== */
elseif ($p === 'fatura') {
    $inv = bayi_invoice($rid, (int) ($_GET['id'] ?? 0));
    if (!$inv) {
        bayi_page_head('Fatura bulunamadı', ['eyebrow' => 'Para',
            'sub' => 'Bu fatura sizin müşterinize ait değil ya da adres yanlış.']);
        echo '<section class="card">';
        bayi_empty('Kayıt yok', 'Yalnızca kendi müşterilerinizin faturalarını görüntüleyebilirsiniz.',
            ['href' => 'index.php?p=faturalar', 'label' => 'Faturalar']);
        echo '</section>';
    } else {
        $netK = para_k($inv['amount']); $totK = para_k($inv['total']);
        $paidK = para_paid_k((int) $inv['id']); $late = para_ageing_days($inv);
        $pays = bayi_payments($rid, (int) $inv['tenant_id'], 50);
        bayi_page_head('Fatura ' . $inv['no'], [
            'eyebrow' => 'Para · ' . $inv['company_name'],
            'sub' => bayi_dt($inv['issued_at']) . ' tarihli'
                   . ($inv['due_at'] ? ' · vade ' . bayi_dt($inv['due_at']) : '')
                   . ($late && $totK > $paidK ? ' · ' . $late . ' gün gecikti' : ''),
            'actions' => '<span class="pill ' . e(para_status_pill($inv['status'])) . '">'
                       . e(para_status_label($inv['status'])) . '</span>'
                       . '<a class="btn btn-ghost btn-sm" href="index.php?p=musteri&id='
                       . (int) $inv['tenant_id'] . '">İşletme</a>']);
        ?>
        <div class="stats">
          <div class="stat"><span>Matrah (KDV hariç)</span><b style="font-size:23px"><?= e(para_tl($netK)) ?></b>
            <small>faturanın vergisiz tutarı</small></div>
          <div class="stat"><span>KDV %<?= e(number_format((float) $inv['vat_rate'], 2, ',', '.')) ?></span>
            <b style="font-size:23px"><?= e(para_tl($totK - $netK)) ?></b><small>genel toplam eksi matrah</small></div>
          <div class="stat"><span>Genel toplam (KDV dahil)</span><b style="font-size:23px"><?= e(para_tl($totK)) ?></b>
            <small>müşteriden istenen tutar</small></div>
          <div class="stat"><span>Kalan</span>
            <b style="font-size:23px" class="<?= $totK > $paidK ? 'warn' : '' ?>"><?= e(para_tl($totK - $paidK)) ?></b>
            <small><?= e(para_tl($paidK)) ?> tahsil edildi</small></div>
        </div>
        <div class="detail"><div>
          <section class="card"><h3>Fatura dökümü</h3>
            <table>
              <tr><td>Fatura no</td><td class="r mono"><?= e($inv['no']) ?></td></tr>
              <tr><td>İşletme</td><td class="r"><a href="index.php?p=musteri&id=<?= (int) $inv['tenant_id'] ?>"><?= e($inv['company_name']) ?></a></td></tr>
              <tr><td>Dönem</td><td class="r nums"><?= $inv['period_start']
                  ? bayi_dt($inv['period_start']) . ' – ' . bayi_dt($inv['period_end'])
                  : '<span class="muted">dönemsiz</span>' ?></td></tr>
              <tr><td><b>Matrah</b> <span class="t-sub">KDV hariç</span></td><td class="r nums"><?= e(para_tl($netK)) ?></td></tr>
              <tr><td><b>KDV</b> <span class="t-sub">fiyatın içinden</span></td><td class="r nums"><?= e(para_tl($totK - $netK)) ?></td></tr>
              <tr><td><b>Genel toplam</b> <span class="t-sub">KDV dahil</span></td><td class="r nums"><b><?= e(para_tl($totK)) ?></b></td></tr>
              <?php if ($inv['note']): ?><tr><td>Açıklama</td><td class="r"><?= e($inv['note']) ?></td></tr><?php endif; ?>
            </table>
          </section>
        </div>
        <aside class="rail">
          <section class="card"><h3>Bu müşterinin tahsilatları</h3>
            <table>
              <?php foreach (array_slice($pays, 0, 10) as $pp): ?>
                <tr><td><?= bayi_dt($pp['paid_at']) ?>
                        <div class="t-sub"><?= e(para_method_label($pp['method'])) ?><?php
                          if ($pp['invoice_no']) echo ' · ' . e($pp['invoice_no']); ?></div></td>
                    <td class="r nums"><?= e(para_tl(para_k($pp['amount']))) ?></td></tr>
              <?php endforeach;
              if (!$pays) { echo '<tr><td>'; bayi_empty('Tahsilat yok', 'Bu müşteriden henüz ödeme kaydedilmemiş.'); echo '</td></tr>'; } ?>
            </table>
            <p class="hint" style="margin:10px 0 0">Tahsilatı NOKTApp kaydeder; bayi paneli
              yalnızca gösterir.</p>
          </section>
        </aside></div>
        <?php
    }
}

/* ======================================================================== */
elseif ($p === 'odemeler') {
    $pays = bayi_payments($rid, null, 200);
    $tot = bayi_totals($rid);
    bayi_page_head('Tahsilatlar', ['eyebrow' => 'Para',
        'sub' => 'Müşterilerimden tahsil edilenler · toplam ' . para_tl($tot['collected'])]);
    ?>
    <div class="scroll-x"><table class="grid">
      <tr><th>Tarih</th><th>İşletme</th><th>Fatura</th><th>Yöntem</th><th class="r">Tutar</th></tr>
      <?php foreach ($pays as $pp): ?>
        <tr><td class="nums"><?= bayi_dt($pp['paid_at']) ?></td>
            <td><a class="t-name" href="index.php?p=musteri&id=<?= (int) $pp['tenant_id'] ?>"><?= e($pp['company_name']) ?></a></td>
            <td><?= $pp['invoice_id']
                ? '<a href="index.php?p=fatura&id=' . (int) $pp['invoice_id'] . '">' . e($pp['invoice_no']) . '</a>'
                : '<span class="muted">faturasız</span>' ?></td>
            <td><?= e(para_method_label($pp['method'])) ?></td>
            <td class="r nums"><b><?= e(para_tl(para_k($pp['amount']))) ?></b></td></tr>
      <?php endforeach;
      if (!$pays) bayi_empty_row(5, 'Tahsilat yok',
          'Müşterilerinizden henüz ödeme kaydedilmemiş.'); ?>
    </table></div>
    <?php
}

/* ======================================================================== */
elseif ($p === 'komisyon') {
    $tot = bayi_totals($rid);
    $months = bayi_commission_months($rid, 12);
    $peak = 0;
    foreach ($months as $m) $peak = max($peak, $m['commission']);
    bayi_page_head('Komisyonum', ['eyebrow' => 'Para',
        'sub' => 'Ödenmiş faturaların KDV hariç tutarı üzerinden, %'
               . number_format($tot['pct'], 2, ',', '.')]);
    ?>
    <div class="stats">
      <div class="stat"><span>Toplam komisyon</span><b style="font-size:23px"><?= e(para_tl($tot['commission'])) ?></b>
        <small>tüm zamanlar</small></div>
      <div class="stat"><span>Hesap tabanı</span><b style="font-size:23px"><?= e(para_tl($tot['base'])) ?></b>
        <small>ödenmiş faturaların matrahı</small></div>
      <div class="stat"><span>Oranım</span><b>%<?= e(number_format($tot['pct'], 2, ',', '.')) ?></b>
        <small>sözleşmenizdeki oran</small></div>
      <div class="stat"><span>Bekleyen</span><b style="font-size:23px"><?= e(para_tl($tot['open'])) ?></b>
        <small>müşterilerimin ödemediği · tahsil edilince komisyona girer</small></div>
    </div>

    <div class="detail"><div>
      <div class="sec-head" style="margin-top:0"><h3>Ay ay komisyon</h3>
        <span class="sub">faturanın kesildiği aya göre · yalnızca ödenmiş faturalar</span></div>
      <div class="scroll-x"><table class="grid">
        <tr><th>Ay</th><th class="r">Ödenmiş fatura</th><th class="r">Matrah</th>
            <th class="r">Komisyon</th><th>Dağılım</th></tr>
        <?php foreach (array_reverse($months) as $m): ?>
          <tr><td><b><?= e(para_month_label($m['month'])) ?></b></td>
              <td class="r"><?= $m['count'] ?: '<span class="muted">—</span>' ?></td>
              <td class="r nums muted"><?= e(para_tl($m['base'])) ?></td>
              <td class="r nums"><b><?= e(para_tl($m['commission'])) ?></b></td>
              <td style="min-width:150px"><?php
                bayi_meter($peak > 0 ? $m['commission'] / $peak : 0, para_tl($m['commission'])); ?></td></tr>
        <?php endforeach; ?>
      </table></div>
    </div>
    <aside class="rail">
      <section class="card"><h3>Kural</h3>
        <table>
          <tr><td><b>KDV hariç</b><div class="t-sub">Komisyon faturanın matrahı üzerinden hesaplanır;
              KDV devletin payıdır ve paylaşıma girmez.</div></td></tr>
          <tr><td><b>Tahsil edilince</b><div class="t-sub">Fatura tamamı ödenene kadar komisyon
              doğmaz. Kısmi ödeme faturayı kapatmaz.</div></td></tr>
          <tr><td><b>Ay, faturanın ayıdır</b><div class="t-sub">Satır, ödemenin değil faturanın
              kesildiği aya yazılır — böylece dönem ile satış eşleşir.</div></td></tr>
        </table>
      </section>
    </aside></div>
    <?php
}

/* ======================================================================== */
else {
    bayi_page_head('Sayfa bulunamadı', ['sub' => 'Aradığınız ekran yok ya da adresi değişmiş olabilir.']);
    echo '<section class="card">';
    bayi_empty('Böyle bir sayfa yok', 'Adres yanlış yazılmış olabilir.',
        ['href' => 'index.php?p=home', 'label' => 'Bayi paneline dön']);
    echo '</section>';
}

bayi_foot();
