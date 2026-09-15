<?php
/**
 * The customer page - everything about one restaurant, and the handful of
 * actions the vendor performs on it over and over.
 *
 * Included from index.php inside the page dispatch, so $me and the panel
 * helpers are already in scope. It is a separate file only because it is the
 * longest screen in the panel and burying it in the router made the router
 * unreadable.
 *
 * The order is the order of the questions actually asked on the phone:
 * is their licence alright, are their tills talking to us, are their backups
 * coming in, what have we done to this account lately.
 */

require_once __DIR__ . '/../lib/para.php';

$id = (int)($_GET['id'] ?? 0);
$t = $id ? one('SELECT * FROM np_tenants WHERE id=?', [$id]) : null;

if ($id && !$t) {
    page_head('İşletme bulunamadı', ['sub' => 'Bu kayıt silinmiş ya da adres yanlış olabilir.']);
    echo '<section class="card">';
    empty_state('Kayıt yok', 'Aradığınız işletme bulunamadı. Listeden seçebilir ya da arama kutusunu kullanabilirsiniz.',
        ['href' => 'index.php?p=tenants', 'label' => 'İşletmeler']);
    echo '</section>';
    return;
}

$lic = $id ? one('SELECT * FROM np_licences WHERE tenant_id=? ORDER BY id DESC LIMIT 1', [$id]) : null;

/* ---------------------------------------------------------------- */
/* new customer: just the form, nothing to report on yet             */
if (!$id) {
    page_head('Yeni işletme', ['eyebrow' => 'İşletmeler',
        'sub' => 'Kaydettiğinizde lisans anahtarı ve 30 günlük deneme lisansı otomatik oluşur.',
        'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=tenants">Vazgeç</a>']);
} else {
    $devs = all('SELECT d.*, b.code AS branch_code, b.name AS branch_name
                   FROM np_devices d
              LEFT JOIN np_branches b ON b.id = d.branch_id AND b.tenant_id = d.tenant_id
                  WHERE d.tenant_id=? ORDER BY d.last_seen_at IS NULL, d.last_seen_at DESC', [$id]);
    $lastSeen  = null;
    foreach ($devs as $d) if ($d['last_seen_at'] && $d['last_seen_at'] > (string)$lastSeen) $lastSeen = $d['last_seen_at'];
    $lastBackup = val('SELECT MAX(created_at) FROM np_backups WHERE tenant_id=?', [$id]);
    $cur = panel_current_version();

    /* The account. Guarded the same way the branch and audit cards are: a panel
       whose code has been updated ahead of sql/para_schema.sql must still open
       this page and say what is missing, not go blank. */
    $bal = null; $invs = []; $pays = [];
    try {
        para_touch_overdue();
        $bal = para_tenant_balance($id);
        $invs = para_tenant_invoices($id, 8);
        $pays = para_tenant_payments($id, 6);
    } catch (Throwable $ex) { error_log('panel tenant money: ' . $ex->getMessage()); }

    /* Who sold this customer, for the rail control. */
    $resellers = null; $reseller = null;
    try {
        $resellers = all('SELECT id, code, name FROM np_resellers WHERE is_active=1 OR id=? ORDER BY name',
                         [(int) ($t['reseller_id'] ?? 0)]);
        if (!empty($t['reseller_id'])) $reseller = bayi_get((int) $t['reseller_id']);
    } catch (Throwable $ex) { error_log('panel tenant reseller: ' . $ex->getMessage()); }

    $daysLeft = ($lic && $lic['expires_at']) ? (int) floor((strtotime($lic['expires_at']) - time()) / 86400) : null;
    $seats = $lic ? (int)$lic['seats'] : 0;
    $used = count($devs);

    $pill = '<span class="pill pill-' . e($lic['status'] ?? '') . '">' . e($lic['status'] ?? '—') . '</span>';
    page_head($t['company_name'], [
        'eyebrow' => 'İşletme · ' . $t['code'],
        'sub' => trim(($t['owner_name'] ? $t['owner_name'] . ' · ' : '') . $t['email']
                 . ($t['phone'] ? ' · ' . $t['phone'] : '') . ($t['city'] ? ' · ' . $t['city'] : '')),
        'actions' => ($t['is_active'] ? '' : '<span class="pill pill-suspended">pasif hesap</span>')
                   . '<a class="btn btn-ghost btn-sm" href="index.php?p=branches&id=' . $id . '">Şubeler</a>'
                   . '<a class="btn btn-ghost btn-sm" href="index.php?p=tenants">İşletmeler</a>',
    ]);
    ?>
    <div class="stats">
      <div class="stat"><span>Lisans</span>
        <b class="<?= $daysLeft !== null && $daysLeft < 0 ? 'bad' : ($daysLeft !== null && $daysLeft <= 30 ? 'warn' : '') ?>"><?php
          echo $daysLeft === null ? '—' : ($daysLeft < 0 ? abs($daysLeft) . ' gün geçti' : $daysLeft . ' gün'); ?></b>
        <small><?= $pill ?> · <?= e($lic['plan'] ?? '—') ?> · bitiş <?= panel_dt($lic['expires_at'] ?? null, 'd.m.Y') ?></small></div>

      <div class="stat"><span>Kasa hakkı</span>
        <b class="<?= $used > $seats ? 'bad' : '' ?>"><?= $used ?> / <?= $seats ?></b>
        <small><?= $used > $seats ? 'hak aşıldı — kasa sayısını artırın' : 'kurulu kasa / lisanslı kasa' ?></small></div>

      <div class="stat"><span>Son bağlantı</span><b style="font-size:19px"><?= e(panel_ago($lastSeen)) ?></b>
        <small><?= $lastSeen ? panel_dt($lastSeen) : 'hiçbir kasa bağlanmadı' ?></small></div>

      <?php /* The balance sits with the licence and the tills because "do they
               owe us anything" is asked on the same phone call as "when does
               their licence run out". */ ?>
      <?php if ($bal !== null): ?>
      <a class="stat" href="index.php?p=faturalar&tenant=<?= $id ?>"><span>Bakiye</span>
        <b style="font-size:23px" class="<?= $bal['overdue'] > 0 ? 'bad' : ($bal['balance'] > 0 ? 'warn' : '') ?>"><?= e(para_tl($bal['balance'])) ?></b>
        <small><?= $bal['overdue'] > 0 ? e(para_tl($bal['overdue'])) . ' gecikmiş' : 'kesilen eksi tahsil edilen' ?></small></a>
      <?php endif; ?>

      <div class="stat"><span>Son bulut yedeği</span>
        <b style="font-size:19px" class="<?= (!$lastBackup || strtotime($lastBackup) < time() - PANEL_BACKUP_HOURS * 3600) ? 'warn' : '' ?>"><?= e(panel_ago($lastBackup)) ?></b>
        <small><?= $lastBackup ? panel_dt($lastBackup) : 'hiç yedek gelmemiş' ?></small></div>
    </div>

    <?php
    /* Everything below is the customer page proper: the record on the left,
       the controls on the right. `$railLicence` is built here and printed
       inside the rail further down, so the markup order matches the reading
       order rather than the order the data happened to be fetched. */
    ob_start(); if ($lic): ?>
      <section class="card">
        <h3>Lisans<span class="sp"></span><span class="pill pill-<?= e($lic['status'] === 'active' ? 'active' : ($lic['status'] === 'trial' ? 'trial' : 'suspended')) ?>"><?= e($lic['status']) ?></span></h3>

        <div class="keyline">
          <code id="lkey" data-key="<?= e($lic['licence_key']) ?>">••••••••••••••••••••••••</code>
          <div class="keybtns">
            <button class="btn btn-sm btn-ghost" type="button" id="lkeyShow">Göster</button>
            <button class="btn btn-sm btn-ghost" type="button" id="lkeyCopy">Kopyala</button>
          </div>
        </div>

        <div class="ctl"><span><b>Süre uzat</b><i>mevcut bitişin üzerine eklenir</i></span>
          <div class="ctl-act">
            <?php foreach ([1 => '+1a', 3 => '+3a', 6 => '+6a', 12 => '+1y'] as $m => $label): ?>
              <form method="post" class="inline">
                <input type="hidden" name="csrf" value="<?= csrf() ?>">
                <input type="hidden" name="action" value="licence_extend">
                <input type="hidden" name="tenant_id" value="<?= $id ?>">
                <input type="hidden" name="licence_id" value="<?= (int)$lic['id'] ?>">
                <input type="hidden" name="months" value="<?= $m ?>">
                <button class="btn btn-sm btn-ghost"><?= $label ?></button>
              </form>
            <?php endforeach; ?>
          </div>
        </div>

        <div class="ctl"><span><b>Kasa sayısı</b><i><?= $used ?> kurulu</i></span>
          <form method="post" class="inline ctl-act">
            <input type="hidden" name="csrf" value="<?= csrf() ?>">
            <input type="hidden" name="action" value="seats_save">
            <input type="hidden" name="tenant_id" value="<?= $id ?>">
            <input type="hidden" name="licence_id" value="<?= (int)$lic['id'] ?>">
            <input name="seats" type="number" min="1" max="999" value="<?= $seats ?>">
            <button class="btn btn-sm">Kaydet</button>
          </form>
        </div>

        <div class="ctl"><span><b>Durum</b><i>askıya alınan kasa satış yapamaz</i></span>
          <form method="post" class="inline ctl-act">
            <input type="hidden" name="csrf" value="<?= csrf() ?>">
            <input type="hidden" name="action" value="licence_status">
            <input type="hidden" name="tenant_id" value="<?= $id ?>">
            <input type="hidden" name="licence_id" value="<?= (int)$lic['id'] ?>">
            <select name="status">
              <?php foreach (['trial' => 'Deneme', 'active' => 'Aktif', 'suspended' => 'Askıda', 'expired' => 'Süresi doldu'] as $k => $v): ?>
                <option value="<?= $k ?>" <?= $lic['status'] === $k ? 'selected' : '' ?>><?= $v ?></option>
              <?php endforeach; ?>
            </select>
            <button class="btn btn-sm btn-ghost">Uygula</button>
          </form>
        </div>

        <div class="ctl"><span><b>İşletme şifresi</b><i>bir kez gösterilir</i></span>
          <form method="post" class="inline ctl-act" onsubmit="return confirm('İşletmenin giriş şifresi sıfırlansın mı?')">
            <input type="hidden" name="csrf" value="<?= csrf() ?>">
            <input type="hidden" name="action" value="tenant_password">
            <input type="hidden" name="tenant_id" value="<?= $id ?>">
            <input name="password" type="text" placeholder="rastgele">
            <button class="btn btn-sm btn-danger">Sıfırla</button>
          </form>
        </div>

        <p class="hint" style="margin:12px 0 0;padding-top:11px;border-top:1px solid var(--line-2)">
          <?= e($lic['billing_period'] ?: 'yearly') ?><?php
          if ($lic['price'] !== null) echo ' · ' . money($lic['price']) . ' ₺'; ?> · bitiş
          <?= panel_dt($lic['expires_at'] ?? null, 'd.m.Y') ?></p>
      </section>
    <?php endif; $railLicence = ob_get_clean(); ?>

    <?php
    /* The branch column is only drawn for a customer that HAS branches. A
       single-shop customer is every customer until they are not, and a column
       of em-dashes down the whole table is the panel admitting it printed
       something it had nothing to say about. */
    $hasBranches = false;
    try { $hasBranches = (int) val('SELECT COUNT(*) FROM np_branches WHERE tenant_id=?', [$id]) > 0; }
    catch (Throwable $ex) { $hasBranches = false; }
    $cols = $hasBranches ? 7 : 6;
    ?>
    <div class="detail">
    <div>
    <!-- ================= tills ============= -->
    <div class="sec-head" style="margin-top:0"><h3>Kasa bilgisayarları</h3>
      <span class="sub"><?= $used ?> kurulu<?= $cur ? ' · yayındaki sürüm v' . e($cur['version']) : '' ?></span></div>
    <div class="scroll-x"><table class="grid">
      <tr><th>Kasa</th><th>Sürüm</th><?= $hasBranches ? '<th>Şube</th>' : '' ?><th>IP</th><th class="r">İlk kurulum</th>
          <th class="r">Son bağlantı</th><th class="r">İşlem</th></tr>
      <?php foreach ($devs as $d):
        $old = $cur && (string)$d['app_version'] !== '' && version_compare($d['app_version'], $cur['version'], '<'); ?>
        <tr>
          <?php /* The name is the way into that till's diagnostics: what the
                   machine itself reports about its printers, disk and day-end.
                   Support starts from a named till, not from a list. */ ?>
          <td><a class="t-name" href="index.php?p=teshis&tenant=<?= $id ?>&device=<?= rawurlencode($d['device_id']) ?>"><?= e($d['device_name'] ?: $d['device_id']) ?></a>
              <?= $d['is_blocked'] ? ' <span class="pill pill-suspended">engelli</span>' : '' ?>
              <div class="t-sub mono"><?= e($d['device_id']) ?></div></td>
          <td><?= $d['app_version'] ? e($d['app_version']) : '<span class="muted">bildirmedi</span>' ?>
              <?= $old ? ' <span class="pill pill-trial">eski</span>' : '' ?>
              <div class="t-sub"><?= e($d['os']) ?></div></td>
          <?php if ($hasBranches): ?><td><?= $d['branch_code']
            ? '<b>' . e($d['branch_code']) . '</b><div class="t-sub">' . e($d['branch_name']) . '</div>'
            : '<span class="muted">şubesiz</span>' ?></td><?php endif; ?>
          <td class="muted mono"><?= e($d['last_ip']) ?></td>
          <td class="r muted nums"><?= panel_dt($d['first_seen_at'], 'd.m.Y') ?></td>
          <td class="r muted"><?= e(panel_ago($d['last_seen_at'])) ?></td>
          <td class="r"><form method="post" class="inline">
            <input type="hidden" name="csrf" value="<?= csrf() ?>">
            <input type="hidden" name="action" value="device_block">
            <input type="hidden" name="id" value="<?= (int)$d['id'] ?>">
            <input type="hidden" name="blocked" value="<?= $d['is_blocked'] ? 0 : 1 ?>">
            <input type="hidden" name="back_tenant" value="<?= $id ?>">
            <button class="btn btn-sm <?= $d['is_blocked'] ? 'btn-ghost' : 'btn-danger' ?>"><?= $d['is_blocked'] ? 'Engeli kaldır' : 'Engelle' ?></button>
          </form></td>
        </tr>
      <?php endforeach;
      if (!$devs) empty_row($cols, 'Hiç kurulum yok',
          'Lisans anahtarı kasaya girildiğinde kasa kendini buraya kaydeder.'); ?>
    </table></div>

    <!-- ================= money ============= -->
    <?php /*
       Faturalar on the customer page, not only on the money screens.

       "What have they been billed and what have they paid" is asked during the
       same phone call as "when does their licence expire", and sending the
       vendor to another screen for it is how a customer gets chased for an
       invoice they settled last week. Matrah, KDV and genel toplam are three
       separate columns here for the same reason they are three columns
       everywhere else: a single "tutar" is the mistake this whole area exists
       to avoid.
    */ ?>
    <div class="sec-head"><h3>Faturalar</h3>
      <span class="sub"><?= $bal === null ? 'para tabloları yüklenmemiş'
          : (para_tl($bal['invoiced']) . ' kesildi · ' . para_tl($bal['paid']) . ' tahsil edildi') ?>
        <?php if ($bal !== null): ?> · <a href="index.php?p=faturalar&tenant=<?= $id ?>">tümü</a><?php endif; ?></span></div>
    <?php if ($bal === null): ?>
      <section class="card"><p class="hint" style="margin:0">Fatura ve ödeme tabloları yüklenmemiş:
        <code>sql/para_schema.sql</code> dosyasını <a href="guncelle.php">panel güncelleme</a>
        ekranından uygulayın.</p></section>
    <?php else: ?>
    <div class="scroll-x"><table class="grid">
      <tr><th>Fatura</th><th>Dönem</th><th class="r">Matrah</th><th class="r">KDV</th>
          <th class="r">Toplam</th><th class="r">Tahsil</th><th class="r">Kalan</th><th>Durum</th></tr>
      <?php foreach ($invs as $iv):
        $ivTot = para_k($iv['total']); $ivPaid = para_k($iv['paid']);
        $ivLate = para_ageing_days($iv); ?>
        <tr>
          <td><a class="t-name" href="index.php?p=fatura&id=<?= (int)$iv['id'] ?>"><?= e($iv['no']) ?></a>
              <div class="t-sub"><?= panel_dt($iv['issued_at'], 'd.m.Y') ?><?php
                if ($ivLate !== null && $ivTot > $ivPaid) echo ' · <b>' . $ivLate . ' gün gecikti</b>'; ?></div></td>
          <td class="nums muted"><?= $iv['period_start']
                ? panel_dt($iv['period_start'], 'd.m.Y') . '<div class="t-sub">'
                  . panel_dt($iv['period_end'], 'd.m.Y') . '</div>' : '—' ?></td>
          <td class="r nums"><?= e(para_tl(para_k($iv['amount']))) ?></td>
          <td class="r nums muted"><?= e(para_tl(para_invoice_vat_k($iv))) ?></td>
          <td class="r nums"><b><?= e(para_tl($ivTot)) ?></b></td>
          <td class="r nums"><?= $ivPaid ? e(para_tl($ivPaid)) : '<span class="muted">—</span>' ?></td>
          <td class="r nums"><?= $ivTot > $ivPaid ? e(para_tl($ivTot - $ivPaid)) : '<span class="muted">—</span>' ?></td>
          <td><span class="pill <?= e(para_status_pill($iv['status'])) ?>"><?= e(para_status_label($iv['status'])) ?></span></td>
        </tr>
      <?php endforeach;
      if (!$invs) empty_row(8, 'Bu işletmeye fatura kesilmemiş',
          'Lisans ücretinden bir fatura kesin — tutar, dönem ve KDV lisanstan doldurulur.',
          ['href' => 'index.php?p=fatura&id=0&tenant=' . $id, 'label' => 'Fatura kes']); ?>
    </table></div>
    <?php endif; ?>

    <?php
    $bks  = all('SELECT * FROM np_backups WHERE tenant_id=? ORDER BY id DESC LIMIT 8', [$id]);
    $reps = all("SELECT * FROM np_reports WHERE tenant_id=? AND entity='daily_closing' ORDER BY id DESC LIMIT 8", [$id]);

    /* The chain door. It has to live on the customer card because the second
       branch has to be created somewhere, and for a one-shop customer it
       deliberately says nothing about menus or versions - just that they are
       one shop. The screens that only make sense for a chain stay behind it. */
    $brs = [];
    try {
        $brs = all('SELECT b.*, (SELECT COUNT(*) FROM np_devices d WHERE d.branch_id=b.id) devices
                      FROM np_branches b WHERE b.tenant_id=? ORDER BY b.code', [$id]);
    } catch (Throwable $ex) {
        /* Code updated, sql/chain_schema.sql not imported yet. One card says
           so; the rest of the customer page keeps working, which is the whole
           posture of this panel. */
        error_log('panel branches: ' . $ex->getMessage());
        $brs = null;
    }

    /* What we have done to this account. Filtered on np_audit.tenant_id, which
       sql/panel_ops_schema.sql adds; on a panel that has not run the migration
       yet the card says so rather than showing another customer's history. */
    $acts = null;
    try {
        $acts = all('SELECT * FROM np_audit WHERE tenant_id=? ORDER BY id DESC LIMIT 12', [$id]);
    } catch (Throwable $ex) { error_log('panel tenant audit: ' . $ex->getMessage()); }
    ?>

    <div class="f2" style="margin-top:18px">
      <section class="card"><h3>Bulut yedekleri<span class="sp"></span>
        <a href="index.php?p=backups">tümü</a></h3><table>
        <?php foreach ($bks as $b): ?>
          <tr><td class="muted"><?= panel_dt($b['created_at']) ?><div class="t-sub mono"><?= e($b['filename']) ?></div></td>
              <td class="r nums"><?= panel_mb((int)$b['size_bytes']) ?></td></tr>
        <?php endforeach;
        if (!$bks) { echo '<tr><td>'; empty_state('Hiç yedek gelmemiş', 'Kasa her gece kapanışta yükler.'); echo '</td></tr>'; } ?>
      </table></section>

      <section class="card"><h3>Gün sonları</h3><table>
        <?php foreach ($reps as $r): $z = json_decode((string)$r['payload'], true); ?>
          <tr><td><?= panel_dt($z['date'] ?? $r['created_at'], 'd.m.Y') ?>
                  <div class="t-sub"><?= (int)($z['orders'] ?? 0) ?> adisyon</div></td>
              <td class="r"><b><?= money($z['net'] ?? 0) ?> ₺</b></td></tr>
        <?php endforeach;
        if (!$reps) { echo '<tr><td>'; empty_state('Gün sonu gelmemiş', 'Kasa gün sonunu kapattığında yollar.'); echo '</td></tr>'; } ?>
      </table></section>

      <section class="card"><h3>Şubeler<span class="sp"></span>
        <a href="index.php?p=branches&id=<?= $id ?>">yönet</a></h3><table>
        <?php if ($brs === null): ?>
          <tr><td class="muted">Şube tabloları yüklenmemiş: <code>sql/chain_schema.sql</code></td></tr>
        <?php elseif (!$brs): ?>
          <tr><td><?php empty_state('Tek şube', 'Zincir ekranları ikinci şubede açılır.',
              ['href' => 'index.php?p=branches&id=' . $id, 'label' => 'Şube ekle']); ?></td></tr>
        <?php else: foreach ($brs as $b): ?>
          <tr><td><b><?= e($b['code']) ?></b> <span class="muted"><?= e($b['name']) ?></span>
                  <div class="t-sub"><?= e($b['city']) ?></div></td>
              <td class="r muted"><?= (int)$b['devices'] ?> kasa<?= $b['menu_version'] ? ' · v' . (int)$b['menu_version'] : '' ?></td></tr>
        <?php endforeach; endif; ?>
        <?php /* The report link appears only for an actual chain: a one-shop
                 customer must not be offered a screen that compares branches
                 they do not have. */
        if ($brs && count($brs) >= 2): ?>
          <tr><td colspan="2"><a href="index.php?p=rapor&id=<?= $id ?>">şube raporu</a> ·
              <a href="index.php?p=menu&id=<?= $id ?>">ana menü</a></td></tr>
        <?php endif; ?>
      </table></section>

      <section class="card"><h3>Bu işletmede yapılanlar<span class="sp"></span>
        <a href="index.php?p=audit">tüm kayıtlar</a></h3><table>
        <?php if ($acts === null): ?>
          <tr><td class="muted">İşletme bazlı kayıt için <code>sql/panel_ops_schema.sql</code> içe aktarılmalı
              (<a href="guncelle.php">panel güncelleme</a>).</td></tr>
        <?php else: foreach ($acts as $a): ?>
          <tr><td><span class="mono"><?= e($a['action']) ?></span>
                  <div class="t-sub"><?= e($a['actor']) ?> · <?= panel_dt($a['created_at']) ?></div></td>
              <td class="r muted mono" style="max-width:200px"><?= e(mb_substr((string)$a['detail'], 0, 60)) ?></td></tr>
        <?php endforeach;
        if (!$acts) { echo '<tr><td>'; empty_state('Henüz işlem yok', 'Lisans ve cihaz işlemleri burada iz bırakır.'); echo '</td></tr>'; }
        endif; ?>
      </table></section>
    </div>
    </div><!-- /main column -->

    <aside class="rail">
      <?= $railLicence ?>
      <?php if ($bal !== null): ?>
      <section class="card">
        <h3>Hesap<span class="sp"></span>
          <a href="index.php?p=faturalar&tenant=<?= $id ?>">faturalar</a></h3>
        <table>
          <tr><td>Kesilen <span class="t-sub">KDV dahil</span></td>
              <td class="r nums"><?= e(para_tl($bal['invoiced'])) ?></td></tr>
          <tr><td>Matrah <span class="t-sub">KDV hariç</span></td>
              <td class="r nums muted"><?= e(para_tl($bal['net'])) ?></td></tr>
          <tr><td>KDV</td><td class="r nums muted"><?= e(para_tl($bal['vat'])) ?></td></tr>
          <tr><td>Tahsil edilen</td><td class="r nums"><?= e(para_tl($bal['paid'])) ?></td></tr>
          <tr><td><b>Bakiye</b></td><td class="r nums"><b><?= e(para_tl($bal['balance'])) ?></b></td></tr>
          <?php if ($bal['overdue'] > 0): ?>
            <tr><td>Gecikmiş</td><td class="r nums warn"><b><?= e(para_tl($bal['overdue'])) ?></b></td></tr>
          <?php endif; ?>
        </table>
        <div class="ctl"><span><b>Fatura ve tahsilat</b><i>bakiye bu satırların toplamıdır</i></span>
          <div class="ctl-act">
            <a class="btn btn-sm" href="index.php?p=fatura&id=0&tenant=<?= $id ?>">Fatura kes</a>
            <a class="btn btn-sm btn-ghost" href="index.php?p=odeme&tenant=<?= $id ?>">Ödeme kaydet</a>
          </div>
        </div>
        <?php if ($pays): ?>
          <p class="hint" style="margin:12px 0 0;padding-top:11px;border-top:1px solid var(--line-2)">
            Son tahsilat: <?= panel_dt($pays[0]['paid_at'], 'd.m.Y') ?> ·
            <?= e(para_tl(para_k($pays[0]['amount']))) ?> ·
            <?= e(para_method_label($pays[0]['method'])) ?></p>
        <?php endif; ?>
      </section>
      <?php endif; ?>

      <?php if ($resellers !== null): ?>
      <section class="card">
        <h3>Bayi</h3>
        <p class="hint" style="margin-top:0">Bu müşteriyi kim sattı. Bayi kendi kapısından
          (<code>/bayi/</code>) yalnızca kendine bağlı müşterileri görür.</p>
        <form method="post">
          <input type="hidden" name="csrf" value="<?= csrf() ?>">
          <input type="hidden" name="action" value="tenant_reseller">
          <input type="hidden" name="tenant_id" value="<?= $id ?>">
          <label>Satışı yapan bayi
            <select name="reseller_id">
              <option value="0">— doğrudan satış (bayisiz) —</option>
              <?php foreach ($resellers as $rs): ?>
                <option value="<?= (int)$rs['id'] ?>" <?= (int)($t['reseller_id'] ?? 0) === (int)$rs['id'] ? 'selected' : '' ?>>
                  <?= e($rs['name']) ?> (<?= e($rs['code']) ?>)</option>
              <?php endforeach; ?>
            </select></label>
          <button class="btn btn-sm">Kaydet</button>
          <?php if ($reseller): ?>
            <p class="hint" style="margin:10px 0 0">Komisyon oranı
              %<?= e(number_format((float)$reseller['commission_pct'], 2, ',', '.')) ?> ·
              <a href="index.php?p=bayi&id=<?= (int)$reseller['id'] ?>">bayi sayfası</a></p>
          <?php endif; ?>
        </form>
      </section>
      <?php endif; ?>

      <section class="card">
        <h3>Kısayollar</h3>
        <table>
          <tr><td><a href="index.php?p=branches&id=<?= $id ?>">Şubeler</a></td>
              <td class="r muted"><?= $brs === null ? '—' : count($brs) ?></td></tr>
          <?php if ($brs && count($brs) >= 2): ?>
            <tr><td><a href="index.php?p=menu&id=<?= $id ?>">Ana menü</a></td><td class="r muted">zincir</td></tr>
            <tr><td><a href="index.php?p=rapor&id=<?= $id ?>">Şube raporu</a></td><td class="r muted">zincir</td></tr>
          <?php endif; ?>
          <?php /* The support screen for this customer's tills: what version they
                   run, which printer is failing, how much disk is left. It belongs
                   in the shortcuts rather than in a tab of its own, because it is
                   read while the phone is ringing and not while browsing. */ ?>
          <tr><td><a href="index.php?p=teshis&tenant=<?= $id ?>">Kasa teşhis</a></td>
              <td class="r muted"><?= count($devs) ?> kasa</td></tr>
          <tr><td><a href="index.php?p=backups">Yedekler</a></td><td class="r muted"><?= count($bks) ?></td></tr>
          <tr><td><a href="index.php?p=audit">İşlem kayıtları</a></td>
              <td class="r muted"><?= $acts === null ? '—' : count($acts) ?></td></tr>
        </table>
      </section>
    </aside>
    </div><!-- /detail -->

    <script>
    /* A licence key is a credential. It is masked until asked for, so it is not
       sitting on screen in a shared office or a screen share, and copyable in
       one press because reading twenty-four characters down a telephone is how
       they get typed in wrong. */
    (function () {
      var el = document.getElementById('lkey'); if (!el) return;
      var shown = false;
      document.getElementById('lkeyShow').onclick = function () {
        shown = !shown;
        el.textContent = shown ? el.dataset.key : '••••••••••••••••••••';
        this.textContent = shown ? 'Gizle' : 'Göster';
      };
      document.getElementById('lkeyCopy').onclick = function () {
        var b = this;
        navigator.clipboard.writeText(el.dataset.key).then(function () {
          b.textContent = 'Kopyalandı'; setTimeout(function () { b.textContent = 'Kopyala'; }, 1600);
        }).catch(function () { b.textContent = 'Kopyalanamadı'; });
      };
    })();
    </script>
    <?php
} /* end of existing-tenant block */
?>

<!-- ================= the record itself ============= -->
<div class="sec-head"><h3><?= $id ? 'İşletme kaydı' : 'İşletme bilgileri' ?></h3>
  <span class="sub">fatura ve iletişim bilgileri</span></div>
<div class="cols-2">
  <form method="post" class="card">
    <input type="hidden" name="csrf" value="<?= csrf() ?>">
    <input type="hidden" name="action" value="tenant_save">
    <input type="hidden" name="id" value="<?= $id ?>">
    <div class="f2">
      <label>Ünvan<input name="company_name" required value="<?= e($t['company_name'] ?? '') ?>"></label>
      <label>Kod<input name="code" value="<?= e($t['code'] ?? '') ?>" placeholder="otomatik"></label>
      <label>Yetkili<input name="owner_name" value="<?= e($t['owner_name'] ?? '') ?>"></label>
      <label>Telefon<input name="phone" value="<?= e($t['phone'] ?? '') ?>"></label>
      <label>E-posta (giriş)<input name="email" type="email" required value="<?= e($t['email'] ?? '') ?>"></label>
      <?php if (!$id): ?><label>Şifre<input name="password" type="text" required></label><?php endif; ?>
      <label>Vergi no<input name="tax_number" value="<?= e($t['tax_number'] ?? '') ?>"></label>
      <label>Vergi dairesi<input name="tax_office" value="<?= e($t['tax_office'] ?? '') ?>"></label>
      <label>Şehir<input name="city" value="<?= e($t['city'] ?? '') ?>"></label>
    </div>
    <label>Adres<input name="address" value="<?= e($t['address'] ?? '') ?>"></label>
    <label>Not<textarea name="notes" placeholder="Bu müşteriyle ilgili hatırlanması gerekenler"><?= e($t['notes'] ?? '') ?></textarea></label>
    <label class="chk"><input type="checkbox" name="is_active" <?= ($t === null || $t['is_active']) ? 'checked' : '' ?>> Hesap aktif</label>
    <?php if ($id): ?><p class="hint">Şifre buradan değil, yukarıdaki <b>Şifreyi sıfırla</b> ile değiştirilir —
      böylece her sıfırlama kayıtlara düşer.</p><?php endif; ?>
    <button class="btn">Kaydet</button>
  </form>

  <?php if ($id && $lic): ?>
  <form method="post" class="card">
    <input type="hidden" name="csrf" value="<?= csrf() ?>">
    <input type="hidden" name="action" value="licence_save">
    <input type="hidden" name="licence_id" value="<?= (int)$lic['id'] ?>">
    <input type="hidden" name="tenant_id" value="<?= $id ?>">
    <h3>Lisans ayrıntıları</h3>
    <p class="hint" style="margin-top:0">Günlük işler için yukarıdaki hızlı düğmeler yeterli.
      Burası plan, ücret ve özellik bayrakları gibi seyrek değişen alanlar için.</p>
    <div class="f2">
      <label>Plan<input name="plan" value="<?= e($lic['plan']) ?>"></label>
      <label>Durum<select name="status">
        <?php foreach (['trial' => 'Deneme', 'active' => 'Aktif', 'suspended' => 'Askıda', 'expired' => 'Süresi doldu'] as $k => $v): ?>
          <option value="<?= $k ?>" <?= $lic['status'] === $k ? 'selected' : '' ?>><?= $v ?></option>
        <?php endforeach; ?></select></label>
      <label>Kasa sayısı<input name="seats" type="number" value="<?= (int)$lic['seats'] ?>"></label>
      <label>Bitiş<input name="expires_at" type="date" value="<?= e(substr((string)$lic['expires_at'], 0, 10)) ?>"></label>
      <label>Çevrimdışı gün<input name="grace_days" type="number" value="<?= (int)$lic['grace_days'] ?>"></label>
      <label>Ücret<input name="price" value="<?= e($lic['price']) ?>"></label>
      <label>Dönem<select name="billing_period">
        <?php foreach (['yearly' => 'Yıllık', 'monthly' => 'Aylık'] as $k => $v): ?>
          <option value="<?= $k ?>" <?= ($lic['billing_period'] ?: 'yearly') === $k ? 'selected' : '' ?>><?= $v ?></option>
        <?php endforeach; ?></select></label>
    </div>
    <label>Özellikler (JSON)<textarea name="features"><?= e($lic['features'] ?: '{}') ?></textarea></label>
    <button class="btn">Lisansı kaydet</button>
  </form>
  <?php endif; ?>
</div>
