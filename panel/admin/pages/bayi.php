<?php
/**
 * One reseller: their customers, what those customers have been billed and
 * paid, and the commission that follows.
 *
 * This is the ADMIN's view of a reseller. The reseller's own view of the same
 * data lives at /bayi/ and is a different door with a different session - see
 * bayi/index.php. The two read the same lib/para.php functions so the figure
 * the vendor quotes and the figure the reseller sees cannot drift.
 */
require_once __DIR__ . '/../../lib/para.php';

para_touch_overdue();

$id = (int) ($_GET['id'] ?? 0);
$b = $id ? bayi_get($id) : null;

if (!$b) {
    page_head('Bayi bulunamadı', ['eyebrow' => 'Bayiler', 'sub' => 'Bu kayıt silinmiş ya da adres yanlış olabilir.']);
    echo '<section class="card">';
    empty_state('Kayıt yok', 'Aradığınız bayi bulunamadı. Listeden seçebilirsiniz.',
        ['href' => 'index.php?p=bayiler', 'label' => 'Bayiler']);
    echo '</section>';
    return;
}

$tot = bayi_totals($id);
$customers = bayi_customers($id);
$invoices = bayi_invoices($id, null, 60);
$months = bayi_commission_months($id, 6);

page_head($b['name'], [
    'eyebrow' => 'Bayi · ' . $b['code'],
    'sub' => trim(($b['contact'] ? $b['contact'] . ' · ' : '') . $b['email']
             . ($b['phone'] ? ' · ' . $b['phone'] : '') . ($b['city'] ? ' · ' . $b['city'] : '')),
    'actions' => ($b['is_active'] ? '' : '<span class="pill pill-suspended">pasif</span>')
               . '<a class="btn btn-ghost btn-sm" href="index.php?p=bayiler">Bayiler</a>',
]);
?>

<div class="stats">
  <div class="stat"><span>Müşteri</span><b><?= (int) $tot['customers'] ?></b>
    <small><?= (int) $tot['live'] ?> aktif hesap</small></div>
  <div class="stat"><span>Kesilen</span><b style="font-size:23px"><?= e(para_tl($tot['invoiced'])) ?></b>
    <small>KDV dahil, iptaller hariç</small></div>
  <div class="stat"><span>Tahsil edilen</span><b style="font-size:23px"><?= e(para_tl($tot['collected'])) ?></b>
    <small><?= e(para_tl($tot['open'])) ?> hâlâ açık</small></div>
  <div class="stat"><span>Komisyon</span><b style="font-size:23px"><?= e(para_tl($tot['commission'])) ?></b>
    <small><?= e(number_format($tot['pct'], 2, ',', '.')) ?> % × <?= e(para_tl($tot['base'])) ?> matrah</small></div>
</div>

<div class="detail">
<div>
  <div class="sec-head" style="margin-top:0"><h3>Bu bayinin müşterileri</h3>
    <span class="sub"><?= count($customers) ?> işletme</span></div>
  <div class="scroll-x"><table class="grid">
    <tr><th>İşletme</th><th>Plan</th><th>Lisans</th><th class="r">Bitiş</th>
        <th class="r">Kasa</th><th class="r">Bakiye</th></tr>
    <?php foreach ($customers as $c):
      $bal = para_tenant_balance((int) $c['id']); ?>
      <tr>
        <td><a class="t-name" href="index.php?p=tenant&id=<?= (int) $c['id'] ?>"><?= e($c['company_name']) ?></a>
            <div class="t-sub"><?= e($c['code']) ?><?= $c['city'] ? ' · ' . e($c['city']) : '' ?></div></td>
        <td><?= e($c['plan'] ?: '—') ?></td>
        <td><span class="pill pill-<?= e($c['lic_status'] ?: 'out') ?>"><?= e($c['lic_status'] ?: '—') ?></span></td>
        <td class="r nums"><?= panel_dt($c['expires_at'], 'd.m.Y') ?></td>
        <td class="r"><?= (int) $c['devices'] ?></td>
        <td class="r nums <?= $bal['balance'] > 0 ? 'warn' : '' ?>"><?= e(para_tl($bal['balance'])) ?></td>
      </tr>
    <?php endforeach;
    if (!$customers) empty_row(6, 'Bu bayinin müşterisi yok',
        'Bir işletmeyi bu bayiye bağlamak için işletme sayfasını açın ve sağdaki “Bayi” kutusundan seçin.',
        ['href' => 'index.php?p=tenants', 'label' => 'İşletmeler']); ?>
  </table></div>

  <div class="sec-head"><h3>Faturalar</h3>
    <span class="sub">bu bayinin müşterilerine kesilen son <?= count($invoices) ?> fatura</span></div>
  <div class="scroll-x"><table class="grid">
    <tr><th>Fatura</th><th>İşletme</th><th class="r">Matrah</th><th class="r">KDV</th>
        <th class="r">Toplam</th><th>Durum</th><th class="r">Tahsil</th></tr>
    <?php foreach ($invoices as $i):
      $vat = para_invoice_vat_k($i); ?>
      <tr>
        <td><a class="t-name" href="index.php?p=fatura&id=<?= (int) $i['id'] ?>"><?= e($i['no']) ?></a>
            <div class="t-sub"><?= panel_dt($i['issued_at'], 'd.m.Y') ?></div></td>
        <td><?= e($i['company_name']) ?></td>
        <td class="r nums"><?= e(para_tl(para_k($i['amount']))) ?></td>
        <td class="r nums"><?= e(para_tl($vat)) ?></td>
        <td class="r nums"><b><?= e(para_tl(para_k($i['total']))) ?></b></td>
        <td><span class="pill <?= e(para_status_pill($i['status'])) ?>"><?= e(para_status_label($i['status'])) ?></span></td>
        <td class="r nums"><?= e(para_tl(para_k($i['paid']))) ?></td>
      </tr>
    <?php endforeach;
    if (!$invoices) empty_row(7, 'Fatura yok',
        'Bu bayinin müşterilerine henüz fatura kesilmemiş.',
        ['href' => 'index.php?p=faturalar', 'label' => 'Faturalar']); ?>
  </table></div>

  <div class="sec-head"><h3>Aya göre komisyon</h3>
    <span class="sub">ödenmiş faturaların matrahı × <?= e(number_format($tot['pct'], 2, ',', '.')) ?> %</span></div>
  <div class="scroll-x"><table class="grid">
    <tr><th>Ay</th><th class="r">Ödenmiş fatura</th><th class="r">Matrah</th><th class="r">Komisyon</th></tr>
    <?php foreach (array_reverse($months) as $m): ?>
      <tr><td><?= e(para_month_label($m['month'])) ?></td>
          <td class="r"><?= (int) $m['count'] ?></td>
          <td class="r nums"><?= e(para_tl($m['base'])) ?></td>
          <td class="r nums"><b><?= e(para_tl($m['commission'])) ?></b></td></tr>
    <?php endforeach; ?>
  </table></div>
</div>

<aside class="rail">
  <section class="card">
    <h3>Bayi kaydı</h3>
    <form method="post">
      <input type="hidden" name="csrf" value="<?= csrf() ?>">
      <input type="hidden" name="action" value="bayi_save">
      <input type="hidden" name="id" value="<?= $id ?>">
      <label>Ünvan<input name="name" required value="<?= e($b['name']) ?>"></label>
      <label>Kod<input name="code" value="<?= e($b['code']) ?>"></label>
      <label>Yetkili<input name="contact" value="<?= e($b['contact']) ?>"></label>
      <label>E-posta (giriş)<input name="email" type="email" required value="<?= e($b['email']) ?>"></label>
      <label>Telefon<input name="phone" value="<?= e($b['phone']) ?>"></label>
      <label>Şehir<input name="city" value="<?= e($b['city']) ?>"></label>
      <label>Komisyon oranı %<input name="commission_pct" type="number" step="0.01" min="0" max="100"
             value="<?= e(number_format((float) $b['commission_pct'], 2, '.', '')) ?>"></label>
      <label>Not<textarea name="notes"><?= e($b['notes']) ?></textarea></label>
      <label class="chk"><input type="checkbox" name="is_active" <?= $b['is_active'] ? 'checked' : '' ?>> Bayi aktif</label>
      <p class="hint">Pasif bayi <code>/bayi/</code> kapısından giremez; müşterileri panelde kalır.</p>
      <button class="btn">Kaydet</button>
    </form>
  </section>

  <section class="card">
    <h3>Giriş</h3>
    <div class="ctl"><span><b>Bayi şifresi</b><i>bir kez gösterilir</i></span>
      <form method="post" class="inline ctl-act"
            onsubmit="return confirm('Bayinin giriş şifresi sıfırlansın mı?')">
        <input type="hidden" name="csrf" value="<?= csrf() ?>">
        <input type="hidden" name="action" value="bayi_password">
        <input type="hidden" name="id" value="<?= $id ?>">
        <input name="password" type="text" placeholder="rastgele">
        <button class="btn btn-sm btn-danger">Sıfırla</button>
      </form>
    </div>
    <div class="ctl"><span><b>Kapı</b><i>bayi buradan girer</i></span>
      <div class="ctl-act"><a class="btn btn-sm btn-ghost" href="../bayi/" target="_blank" rel="noopener">/bayi/ aç</a></div>
    </div>
    <p class="hint" style="margin:12px 0 0">Bayi girişi yönetici girişinden ayrıdır: farklı oturum
      çerezi kullanır, panelin yönetici ekranlarına erişemez ve yalnızca kendi müşterilerini
      sorgulayabilir.</p>
  </section>
</aside>
</div>
