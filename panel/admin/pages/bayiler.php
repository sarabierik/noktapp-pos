<?php
/**
 * Bayiler - who sells for us, and what that has come to.
 *
 * Included from index.php after layout_head(), so $me and every panel helper
 * are in scope and nothing here may redirect. Writes go through
 * admin/para.php.
 *
 * The list answers three questions in the order the vendor asks them: how many
 * customers has this reseller brought, what have those customers been billed,
 * and what do I owe him. The commission rule is printed under the table rather
 * than left to be inferred from the number, because a reseller who cannot
 * reproduce his own commission rings up about it.
 */
require_once __DIR__ . '/../../lib/para.php';

para_touch_overdue();
$rows = bayi_list();

$totCust = 0; $totInv = 0; $totCom = 0; $live = 0;
foreach ($rows as $r) {
    $totCust += (int) $r['customers'];
    $totInv += $r['invoiced'];
    $totCom += $r['commission'];
    if ($r['is_active']) $live++;
}
/* Customers nobody sold - the vendor's own. Shown as a figure because a
   reseller list that only counts reseller customers quietly implies every
   customer came through one. */
$direct = (int) val('SELECT COUNT(*) FROM np_tenants WHERE reseller_id IS NULL');

page_head('Bayiler', ['eyebrow' => 'Müşteriler',
    'sub' => count($rows) . ' bayi · ' . $totCust . ' müşteri bayi üzerinden geldi',
    'actions' => '<a class="btn btn-ghost btn-sm" href="../bayi/" target="_blank" rel="noopener">Bayi girişi</a>']);
?>

<div class="stats">
  <div class="stat"><span>Bayi</span><b><?= count($rows) ?></b>
    <small><?= $live ?> aktif · <?= count($rows) - $live ?> pasif</small></div>
  <div class="stat"><span>Bayili müşteri</span><b><?= $totCust ?></b>
    <small><?= $direct ?> müşteri doğrudan satıldı</small></div>
  <div class="stat"><span>Bayi üzerinden kesilen</span><b style="font-size:23px"><?= e(para_tl($totInv)) ?></b>
    <small>KDV dahil, iptaller hariç</small></div>
  <div class="stat"><span>Hak edilen komisyon</span><b style="font-size:23px"><?= e(para_tl($totCom)) ?></b>
    <small>ödenmiş faturaların matrahı üzerinden</small></div>
</div>

<div class="scroll-x"><table class="grid">
  <tr><th>Bayi</th><th>İletişim</th><th class="r">Müşteri</th><th class="r">Kesilen</th>
      <th class="r">Tahsil edilen</th><th class="r">Komisyon oranı</th><th class="r">Komisyon</th></tr>
  <?php foreach ($rows as $r): ?>
    <tr>
      <td><a class="t-name" href="index.php?p=bayi&id=<?= (int) $r['id'] ?>"><?= e($r['name']) ?></a>
          <div class="t-sub"><?= e($r['code']) ?><?= $r['city'] ? ' · ' . e($r['city']) : '' ?>
            <?= $r['is_active'] ? '' : ' · <b>pasif</b>' ?></div></td>
      <td><?= e($r['email']) ?><div class="t-sub"><?= e($r['contact'] ?: '') ?>
          <?= $r['phone'] ? ' · ' . e($r['phone']) : '' ?></div></td>
      <td class="r"><?= (int) $r['customers'] ?><div class="t-sub"><?= (int) $r['live'] ?> aktif</div></td>
      <td class="r nums"><?= e(para_tl($r['invoiced'])) ?></td>
      <td class="r nums"><?= e(para_tl($r['collected'])) ?></td>
      <td class="r nums"><?= e(number_format((float) $r['commission_pct'], 2, ',', '.')) ?> %</td>
      <td class="r nums"><b><?= e(para_tl($r['commission'])) ?></b></td>
    </tr>
  <?php endforeach;
  if (!$rows) empty_row(7, 'Henüz bayi yok',
      'Bir bayi ekleyin, sonra işletme sayfasındaki “Bayi” kutusundan müşteriyi ona bağlayın. '
    . 'Bayi kendi kapısından (/bayi/) girip yalnızca kendi müşterilerini görür.'); ?>
</table></div>

<div class="detail" style="margin-top:18px">
  <div>
    <section class="card">
      <h3>Yeni bayi</h3>
      <p class="hint" style="margin-top:0">Bayi burada oluşturulur, müşteriye ise işletme sayfasından
        bağlanır. Kaydettikten sonra bayi <code>/bayi/</code> adresinden kendi e-postası ve
        şifresiyle girer; panelin yönetici kapısına giremez.</p>
      <form method="post">
        <input type="hidden" name="csrf" value="<?= csrf() ?>">
        <input type="hidden" name="action" value="bayi_save">
        <input type="hidden" name="id" value="0">
        <div class="f2">
          <label>Bayi ünvanı<input name="name" required></label>
          <label>Kod<input name="code" placeholder="otomatik"></label>
          <label>Yetkili<input name="contact"></label>
          <label>Telefon<input name="phone"></label>
          <label>E-posta (giriş)<input name="email" type="email" required></label>
          <label>Şifre<input name="password" type="text" required minlength="6"></label>
          <label>Şehir<input name="city"></label>
          <label>Komisyon oranı %<input name="commission_pct" type="number" step="0.01" min="0" max="100" value="10"></label>
        </div>
        <label>Not<textarea name="notes" placeholder="Sözleşme, bölge, hatırlanması gerekenler"></textarea></label>
        <button class="btn">Bayiyi kaydet</button>
      </form>
    </section>
  </div>

  <aside class="rail">
    <section class="card">
      <h3>Komisyon nasıl hesaplanıyor</h3>
      <table>
        <tr><td><b>Matrah üzerinden</b>
          <div class="t-sub">KDV devletin payıdır, komisyona girmez. Hesap faturanın
            KDV hariç tutarı üzerinden yapılır.</div></td></tr>
        <tr><td><b>Yalnızca tahsil edilmiş fatura</b>
          <div class="t-sub">Ödenmemiş fatura gelir değildir. Kısmi ödeme de fatura kapanana kadar
            komisyon doğurmaz — bayi kendi hesabını kendi bankasından doğrulayabilsin diye.</div></td></tr>
        <tr><td><b>Oran bayiye özeldir</b>
          <div class="t-sub">Oranı bayi sayfasından değiştirdiğinizde geçmiş de yeni orana göre
            yeniden hesaplanır; ödenmiş komisyon panelde tutulmaz.</div></td></tr>
      </table>
    </section>
    <section class="card">
      <h3>Bayi kapısı</h3>
      <table>
        <tr><td>Adres</td><td class="r mono">/bayi/</td></tr>
        <tr><td>Gördüğü</td><td class="r">yalnızca kendi müşterileri</td></tr>
        <tr><td>Görmediği</td><td class="r">diğer bayiler, işin geneli</td></tr>
      </table>
      <p class="hint" style="margin:10px 0 0">Bayi oturumu ile yönetici oturumu ayrı çerezlerdir;
        biri diğerinin ekranını açamaz.</p>
    </section>
  </aside>
</div>
