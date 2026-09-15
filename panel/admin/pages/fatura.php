<?php
/**
 * One invoice - and, with id=0, the form that issues one.
 *
 * The form's whole job is to stop the KDV being applied from the wrong end.
 * It asks explicitly which figure is being typed ("KDV dahil" or "KDV hariç"),
 * prefills the licence price as the KDV-INCLUSIVE figure it was quoted as, and
 * shows the resulting matrah / KDV / toplam live before anything is saved.
 * There is no default guess: an invoice built from the wrong end is out by a
 * sixth, and nobody notices until the accountant does.
 */
require_once __DIR__ . '/../../lib/para.php';

para_touch_overdue();
$id = (int) ($_GET['id'] ?? 0);
$inv = $id ? one('SELECT i.*, t.company_name, t.code tenant_code, t.email, t.tax_number, t.tax_office,
                         t.address, t.city, t.reseller_id
                    FROM np_invoices i JOIN np_tenants t ON t.id=i.tenant_id WHERE i.id=?', [$id]) : null;

if ($id && !$inv) {
    page_head('Fatura bulunamadı', ['eyebrow' => 'Para', 'sub' => 'Bu kayıt silinmiş ya da adres yanlış olabilir.']);
    echo '<section class="card">';
    empty_state('Kayıt yok', 'Aradığınız fatura bulunamadı. Fatura listesinden seçebilirsiniz.',
        ['href' => 'index.php?p=faturalar', 'label' => 'Faturalar']);
    echo '</section>';
    return;
}

/* ====================================================================== */
/* the form                                                                */
/* ====================================================================== */
if (!$inv) {
    $tid = (int) ($_GET['tenant'] ?? 0);
    $t = $tid ? one('SELECT * FROM np_tenants WHERE id=?', [$tid]) : null;
    $lic = $t ? one('SELECT * FROM np_licences WHERE tenant_id=? ORDER BY id DESC LIMIT 1', [$tid]) : null;

    $period = $lic && $lic['expires_at'] ? para_renewal_period($lic) : ['period_start' => '', 'period_end' => ''];
    $price = $lic && $lic['price'] !== null ? (float) $lic['price'] : 0;
    $prefillGross = $price > 0;

    page_head('Yeni fatura', ['eyebrow' => 'Para',
        'sub' => $t ? $t['company_name'] . ' için fatura kesiliyor'
                    : 'Önce faturanın kesileceği işletmeyi seçin',
        'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=faturalar">Vazgeç</a>']);
    ?>
    <div class="detail">
    <div>
      <section class="card">
        <h3>Fatura bilgileri</h3>
        <form method="post" id="fatform">
          <input type="hidden" name="csrf" value="<?= csrf() ?>">
          <input type="hidden" name="action" value="fatura_create">

          <label>İşletme
            <select name="tenant_id" required>
              <option value="">— işletme seçin —</option>
              <?php foreach (all('SELECT id, code, company_name FROM np_tenants ORDER BY is_active DESC, company_name') as $o): ?>
                <option value="<?= (int) $o['id'] ?>" <?= $tid === (int) $o['id'] ? 'selected' : '' ?>>
                  <?= e($o['company_name']) ?> (<?= e($o['code']) ?>)</option>
              <?php endforeach; ?>
            </select></label>

          <?php /*
             The one control that matters. The licence price is a figure the
             customer was QUOTED, so it arrives here as "KDV dahil" - the tax
             is taken back out of it, never added on top. Typing a matrah
             instead is the other radio, and the preview under them prints both
             sides so the choice is visible before it is saved.
          */ ?>
          <fieldset>
            <div class="ctl"><span><b>Girilen tutar</b><i>KDV Türkiye'de fiyatın içindedir; hangi ucundan girdiğinizi seçin</i></span>
              <div class="ctl-act">
                <label class="chk"><input type="radio" name="basis" value="gross" id="bGross"
                       <?= $prefillGross ? 'checked' : '' ?>> KDV dahil (genel toplam)</label>
                <label class="chk"><input type="radio" name="basis" value="net" id="bNet"
                       <?= $prefillGross ? '' : 'checked' ?>> KDV hariç (matrah)</label>
              </div>
            </div>
          </fieldset>

          <div class="f2">
            <label>Tutar ₺<input name="amount" id="fAmount" required inputmode="decimal"
                   value="<?= $price > 0 ? e(number_format($price, 2, '.', '')) : '' ?>"></label>
            <label>KDV oranı %<input name="vat_rate" id="fRate" type="number" step="0.01" min="0" max="100"
                   value="<?= e(number_format(PARA_VAT_RATE, 2, '.', '')) ?>"></label>
            <label>Fatura tarihi<input name="issued_at" type="date" value="<?= e(date('Y-m-d')) ?>"></label>
            <label>Vade<input name="due_at" type="date"
                   value="<?= e(date('Y-m-d', strtotime('+' . PARA_DUE_DAYS . ' day'))) ?>"></label>
            <label>Dönem başlangıcı<input name="period_start" type="date" value="<?= e($period['period_start']) ?>"></label>
            <label>Dönem bitişi<input name="period_end" type="date" value="<?= e($period['period_end']) ?>"></label>
          </div>

          <label>Açıklama<input name="note" value="<?= $lic ? e('Lisans · ' . $lic['plan']) : '' ?>"></label>
          <label>Durum
            <select name="status">
              <option value="draft">Taslak — henüz gönderilmedi</option>
              <option value="sent">Gönderildi — tahsilat bekleniyor</option>
            </select></label>

          <div class="keyline">
            <code id="fPreview">matrah — · KDV — · genel toplam —</code>
          </div>
          <p class="hint">Aynı işletmeye aynı dönem için ikinci bir fatura kesilemez;
            veritabanı buna izin vermez, böylece yenileme iki kez çalıştırılsa da tek fatura kesilir.</p>
          <button class="btn">Faturayı kes</button>
        </form>
      </section>
    </div>

    <aside class="rail">
      <?php if ($t): ?>
      <section class="card">
        <h3>İşletme</h3>
        <table>
          <tr><td><a href="index.php?p=tenant&id=<?= (int) $t['id'] ?>"><b><?= e($t['company_name']) ?></b></a>
              <div class="t-sub"><?= e($t['code']) ?><?= $t['city'] ? ' · ' . e($t['city']) : '' ?></div></td></tr>
          <tr><td>Vergi no<span class="sp"></span>
              <div class="t-sub"><?= e($t['tax_number'] ?: '—') ?> · <?= e($t['tax_office'] ?: '—') ?></div></td></tr>
          <?php if ($lic): ?>
            <tr><td>Lisans
                <div class="t-sub"><?= e($lic['plan']) ?> · <?= e($lic['billing_period'] ?: 'yearly') ?>
                  · bitiş <?= panel_dt($lic['expires_at'], 'd.m.Y') ?></div></td></tr>
            <tr><td>Lisans ücreti<span class="sp"></span>
                <div class="t-sub"><?= $lic['price'] !== null
                    ? e(para_tl(para_k($lic['price']))) . ' — KDV dahil kabul edilir'
                    : 'tanımlı değil' ?></div></td></tr>
          <?php endif; ?>
        </table>
      </section>
      <?php else: ?>
      <section class="card">
        <h3>Ön dolgu</h3>
        <p class="hint" style="margin:0">Bir işletme seçtiğinizde lisans ücreti, planı ve bir sonraki
          dönemi buradan otomatik doldurulur. Doğrudan işletme sayfasındaki <b>Fatura kes</b>
          düğmesini kullanmak en kısa yol.</p>
      </section>
      <?php endif; ?>

      <section class="card">
        <h3>KDV kuralı</h3>
        <table>
          <tr><td><b>KDV dahil bir tutardan</b>
              <div class="t-sub mono">KDV = tutar × oran / (100 + oran)</div></td></tr>
          <tr><td><b>KDV hariç bir matrahtan</b>
              <div class="t-sub mono">KDV = matrah × oran / 100</div></td></tr>
          <tr><td class="muted">Fatura satırında <b>matrah</b> ve <b>genel toplam</b> saklanır;
              KDV her zaman ikisinin farkıdır, ayrıca yuvarlanmaz.</td></tr>
        </table>
      </section>
    </aside>
    </div>

    <script>
    /* The preview only restates what lib/para.php will compute; it never
       decides anything. The server splits the figure again on save, in integer
       kurus, so a browser with JavaScript off issues exactly the same invoice
       - this line is a courtesy, not a calculation the record depends on. */
    (function () {
      var a = document.getElementById('fAmount'), r = document.getElementById('fRate'),
          g = document.getElementById('bGross'), out = document.getElementById('fPreview');
      if (!a || !out) return;
      function tl(k) { return (k / 100).toLocaleString('tr-TR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' ₺'; }
      function draw() {
        var v = Math.round(parseFloat(String(a.value).replace(',', '.')) * 100) || 0,
            rate = parseFloat(String(r.value).replace(',', '.')) || 0, net, vat, tot;
        if (g.checked) { vat = Math.round(v * rate / (100 + rate)); net = v - vat; tot = v; }
        else { net = v; vat = Math.round(v * rate / 100); tot = net + vat; }
        out.textContent = 'matrah ' + tl(net) + '  ·  KDV ' + tl(vat) + '  ·  genel toplam ' + tl(tot);
      }
      ['input', 'change'].forEach(function (ev) {
        a.addEventListener(ev, draw); r.addEventListener(ev, draw);
        document.getElementById('bGross').addEventListener(ev, draw);
        document.getElementById('bNet').addEventListener(ev, draw);
      });
      draw();
    })();
    </script>
    <?php
    return;
}

/* ====================================================================== */
/* one invoice                                                             */
/* ====================================================================== */
$netK = para_k($inv['amount']);
$totK = para_k($inv['total']);
$vatK = $totK - $netK;
$paidK = para_paid_k($id);
$leftK = $totK - $paidK;
$late = para_ageing_days($inv);
$pays = all('SELECT * FROM np_payments WHERE invoice_id=? ORDER BY paid_at DESC, id DESC', [$id]);
$bal = para_tenant_balance((int) $inv['tenant_id']);
$reseller = $inv['reseller_id'] ? bayi_get((int) $inv['reseller_id']) : null;

page_head('Fatura ' . $inv['no'], [
    'eyebrow' => 'Para · ' . $inv['company_name'],
    'sub' => panel_dt($inv['issued_at'], 'd.m.Y') . ' tarihli'
           . ($inv['due_at'] ? ' · vade ' . panel_dt($inv['due_at'], 'd.m.Y') : '')
           . ($late !== null && $leftK > 0 ? ' · ' . $late . ' gün gecikti' : ''),
    'actions' => '<span class="pill ' . e(para_status_pill($inv['status'])) . '">'
               . e(para_status_label($inv['status'])) . '</span>'
               . '<a class="btn btn-ghost btn-sm" href="index.php?p=tenant&id=' . (int) $inv['tenant_id'] . '">İşletme</a>'
               . '<a class="btn btn-ghost btn-sm" href="index.php?p=faturalar">Faturalar</a>']);
?>

<div class="stats">
  <div class="stat"><span>Matrah (KDV hariç)</span><b style="font-size:23px"><?= e(para_tl($netK)) ?></b>
    <small>faturanın vergisiz tutarı</small></div>
  <div class="stat"><span>KDV %<?= e(rtrim(rtrim(number_format((float) $inv['vat_rate'], 2, ',', '.'), '0'), ',')) ?></span>
    <b style="font-size:23px"><?= e(para_tl($vatK)) ?></b>
    <small>genel toplam eksi matrah</small></div>
  <div class="stat"><span>Genel toplam (KDV dahil)</span><b style="font-size:23px"><?= e(para_tl($totK)) ?></b>
    <small>müşteriden istenen tutar</small></div>
  <div class="stat"><span>Kalan</span>
    <b style="font-size:23px" class="<?= $leftK > 0 && $late ? 'bad' : ($leftK > 0 ? 'warn' : '') ?>"><?= e(para_tl($leftK)) ?></b>
    <small><?= e(para_tl($paidK)) ?> tahsil edildi</small></div>
</div>

<div class="detail">
<div>
  <section class="card">
    <h3>Fatura dökümü</h3>
    <table>
      <tr><td>Fatura no</td><td class="r mono"><?= e($inv['no']) ?></td></tr>
      <tr><td>İşletme</td><td class="r"><a href="index.php?p=tenant&id=<?= (int) $inv['tenant_id'] ?>"><?= e($inv['company_name']) ?></a>
          <div class="t-sub"><?= e($inv['tax_number'] ?: '—') ?> · <?= e($inv['tax_office'] ?: '—') ?></div></td></tr>
      <?php if ($reseller): ?>
      <tr><td>Bayi</td><td class="r"><a href="index.php?p=bayi&id=<?= (int) $reseller['id'] ?>"><?= e($reseller['name']) ?></a></td></tr>
      <?php endif; ?>
      <tr><td>Dönem</td><td class="r nums"><?= $inv['period_start']
          ? panel_dt($inv['period_start'], 'd.m.Y') . ' – ' . panel_dt($inv['period_end'], 'd.m.Y')
          : '<span class="muted">dönemsiz</span>' ?></td></tr>
      <tr><td><b>Matrah</b> <span class="t-sub">KDV hariç</span></td><td class="r nums"><?= e(para_tl($netK)) ?></td></tr>
      <tr><td><b>KDV</b> <span class="t-sub">%<?= e(number_format((float) $inv['vat_rate'], 2, ',', '.')) ?> · fiyatın içinden</span></td>
          <td class="r nums"><?= e(para_tl($vatK)) ?></td></tr>
      <tr><td><b>Genel toplam</b> <span class="t-sub">KDV dahil</span></td>
          <td class="r nums"><b><?= e(para_tl($totK)) ?></b></td></tr>
      <?php if ($inv['note']): ?><tr><td>Açıklama</td><td class="r"><?= e($inv['note']) ?></td></tr><?php endif; ?>
    </table>
  </section>

  <div class="sec-head"><h3>Bu faturaya yapılan ödemeler</h3>
    <span class="sub"><?= count($pays) ?> tahsilat · <?= e(para_tl($paidK)) ?></span></div>
  <div class="scroll-x"><table class="grid">
    <tr><th>Tarih</th><th>Yöntem</th><th>Referans</th><th class="r">Tutar</th><th class="r">İşlem</th></tr>
    <?php foreach ($pays as $p): ?>
      <tr><td class="nums"><?= panel_dt($p['paid_at'], 'd.m.Y') ?></td>
          <td><?= e(para_method_label($p['method'])) ?></td>
          <td class="muted mono"><?= e($p['reference'] ?: '—') ?></td>
          <td class="r nums"><b><?= e(para_tl(para_k($p['amount']))) ?></b></td>
          <td class="r"><form method="post" class="inline"
                onsubmit="return confirm('Bu ödeme kaydı silinsin mi?')">
            <input type="hidden" name="csrf" value="<?= csrf() ?>">
            <input type="hidden" name="action" value="odeme_delete">
            <input type="hidden" name="id" value="<?= (int) $p['id'] ?>">
            <button class="btn btn-sm btn-danger">Sil</button></form></td></tr>
    <?php endforeach;
    if (!$pays) empty_row(5, 'Henüz tahsilat yok',
        'Para geldiğinde sağdaki kutudan kaydedin; fatura tamamı tahsil edildiğinde kendiliğinden '
      . '“ödendi” olur, kısmi ödeme onu kapatmaz.'); ?>
  </table></div>
</div>

<aside class="rail">
  <section class="card">
    <h3>Ödeme kaydet</h3>
    <p class="hint" style="margin-top:0">Kısmi ödeme faturayı kapatmaz; kalan
      <b><?= e(para_tl($leftK)) ?></b> açık kalır.</p>
    <form method="post">
      <input type="hidden" name="csrf" value="<?= csrf() ?>">
      <input type="hidden" name="action" value="odeme_add">
      <input type="hidden" name="tenant_id" value="<?= (int) $inv['tenant_id'] ?>">
      <input type="hidden" name="invoice_id" value="<?= $id ?>">
      <label>Tutar ₺<input name="amount" inputmode="decimal" required
             value="<?= $leftK > 0 ? e(number_format($leftK / 100, 2, '.', '')) : '' ?>"></label>
      <label>Tarih<input name="paid_at" type="date" value="<?= e(date('Y-m-d')) ?>"></label>
      <label>Yöntem<select name="method">
        <?php foreach (['havale', 'nakit', 'kredi_karti', 'diger'] as $m): ?>
          <option value="<?= e($m) ?>"><?= e(para_method_label($m)) ?></option>
        <?php endforeach; ?></select></label>
      <label>Referans<input name="reference" placeholder="dekont no, son 4 hane"></label>
      <button class="btn">Ödemeyi kaydet</button>
    </form>
  </section>

  <section class="card">
    <h3>Durum</h3>
    <?php foreach ([['sent', 'Gönderildi olarak işaretle', 'btn-ghost'],
                    ['draft', 'Taslağa geri al', 'btn-ghost'],
                    ['cancelled', 'Faturayı iptal et', 'btn-danger']] as [$to, $label, $cls]):
      if ($inv['status'] === $to) continue; ?>
      <div class="ctl"><span><b><?= e(para_status_label($to)) ?></b><i><?php
        echo $to === 'cancelled'
          ? 'iptal edilen fatura hiçbir toplama girmez, numarası yanar'
          : ($to === 'sent' ? 'vadesi geçtiğinde kendiliğinden “gecikti” olur'
                            : 'müşteriye gitmemiş faturaya geri alır'); ?></i></span>
        <form method="post" class="inline ctl-act"
              <?= $to === 'cancelled' ? 'onsubmit="return confirm(\'Fatura iptal edilsin mi?\')"' : '' ?>>
          <input type="hidden" name="csrf" value="<?= csrf() ?>">
          <input type="hidden" name="action" value="fatura_status">
          <input type="hidden" name="id" value="<?= $id ?>">
          <input type="hidden" name="status" value="<?= e($to) ?>">
          <button class="btn btn-sm <?= e($cls) ?>"><?= e($label) ?></button>
        </form>
      </div>
    <?php endforeach; ?>
    <?php if ($inv['status'] === 'paid'): ?>
      <p class="hint" style="margin:12px 0 0">Bu fatura tamamen tahsil edilmiş durumda. Durumu
        değiştirmek için önce ödemeyi kaldırın.</p>
    <?php endif; ?>
  </section>

  <section class="card">
    <h3>İşletmenin hesabı</h3>
    <table>
      <tr><td>Kesilen</td><td class="r nums"><?= e(para_tl($bal['invoiced'])) ?></td></tr>
      <tr><td>Tahsil edilen</td><td class="r nums"><?= e(para_tl($bal['paid'])) ?></td></tr>
      <tr><td><b>Bakiye</b></td><td class="r nums"><b><?= e(para_tl($bal['balance'])) ?></b></td></tr>
      <tr><td colspan="2"><a href="index.php?p=faturalar&tenant=<?= (int) $inv['tenant_id'] ?>">bu işletmenin tüm faturaları</a></td></tr>
    </table>
  </section>
</aside>
</div>
