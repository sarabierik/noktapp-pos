<?php
/**
 * Bir tahsilat - and, with no id, the form that records one from scratch.
 *
 * The everyday route is the invoice page, where the amount arrives prefilled
 * with what is still owed. This screen exists for the other case: money that
 * turned up in the bank before anyone worked out which invoice it was for. It
 * therefore lets the invoice be left blank (an avans), and the customer's
 * balance still moves - pretending otherwise would put the panel out of step
 * with the statement.
 */
require_once __DIR__ . '/../../lib/para.php';

para_touch_overdue();
$id = (int) ($_GET['id'] ?? 0);
$pay = $id ? one('SELECT p.*, t.company_name, t.code tenant_code, i.no invoice_no, i.status invoice_status
                    FROM np_payments p JOIN np_tenants t ON t.id=p.tenant_id
               LEFT JOIN np_invoices i ON i.id=p.invoice_id WHERE p.id=?', [$id]) : null;

if ($id && !$pay) {
    page_head('Ödeme bulunamadı', ['eyebrow' => 'Para', 'sub' => 'Bu kayıt silinmiş ya da adres yanlış olabilir.']);
    echo '<section class="card">';
    empty_state('Kayıt yok', 'Aradığınız tahsilat bulunamadı. Ödeme listesinden seçebilirsiniz.',
        ['href' => 'index.php?p=odemeler', 'label' => 'Ödemeler']);
    echo '</section>';
    return;
}

/* ------------------------------ one payment ------------------------------ */
if ($pay) {
    $bal = para_tenant_balance((int) $pay['tenant_id']);
    page_head('Tahsilat', [
        'eyebrow' => 'Para · ' . $pay['company_name'],
        'sub' => panel_dt($pay['paid_at'], 'd.m.Y') . ' · ' . para_method_label($pay['method']),
        'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=odemeler">Ödemeler</a>']);
    ?>
    <div class="detail"><div>
      <section class="card">
        <h3><?= e(para_tl(para_k($pay['amount']))) ?></h3>
        <table>
          <tr><td>İşletme</td><td class="r"><a href="index.php?p=tenant&id=<?= (int) $pay['tenant_id'] ?>"><?= e($pay['company_name']) ?></a></td></tr>
          <tr><td>Fatura</td><td class="r"><?= $pay['invoice_id']
              ? '<a href="index.php?p=fatura&id=' . (int) $pay['invoice_id'] . '">' . e($pay['invoice_no']) . '</a>'
              : '<span class="muted">faturasız (avans)</span>' ?></td></tr>
          <tr><td>Yöntem</td><td class="r"><?= e(para_method_label($pay['method'])) ?></td></tr>
          <tr><td>Referans</td><td class="r mono"><?= e($pay['reference'] ?: '—') ?></td></tr>
          <tr><td>Not</td><td class="r"><?= e($pay['note'] ?: '—') ?></td></tr>
          <tr><td>Kaydedildi</td><td class="r muted"><?= panel_dt($pay['created_at']) ?></td></tr>
        </table>
      </section>
    </div>
    <aside class="rail">
      <section class="card"><h3>İşletmenin hesabı</h3>
        <table>
          <tr><td>Kesilen</td><td class="r nums"><?= e(para_tl($bal['invoiced'])) ?></td></tr>
          <tr><td>Tahsil edilen</td><td class="r nums"><?= e(para_tl($bal['paid'])) ?></td></tr>
          <tr><td><b>Bakiye</b></td><td class="r nums"><b><?= e(para_tl($bal['balance'])) ?></b></td></tr>
        </table>
      </section>
      <section class="card"><h3>Kaydı sil</h3>
        <p class="hint" style="margin-top:0">Silindiğinde bağlı faturanın durumu yeniden hesaplanır —
          ödenmiş görünen bir fatura yeniden açılabilir.</p>
        <form method="post" onsubmit="return confirm('Bu ödeme kaydı silinsin mi?')">
          <input type="hidden" name="csrf" value="<?= csrf() ?>">
          <input type="hidden" name="action" value="odeme_delete">
          <input type="hidden" name="id" value="<?= (int) $pay['id'] ?>">
          <button class="btn btn-sm btn-danger">Ödemeyi sil</button>
        </form>
      </section>
    </aside></div>
    <?php
    return;
}

/* ------------------------------- new payment ------------------------------ */
$tid = (int) ($_GET['tenant'] ?? 0);
$open = all("SELECT i.id, i.no, i.total, i.tenant_id, t.company_name,
                    COALESCE((SELECT SUM(p.amount) FROM np_payments p WHERE p.invoice_id=i.id),0) paid
               FROM np_invoices i JOIN np_tenants t ON t.id=i.tenant_id
              WHERE i.status IN ('sent','overdue')" . ($tid ? ' AND i.tenant_id=' . $tid : '') . "
              ORDER BY i.due_at, i.id LIMIT 200");

page_head('Ödeme kaydet', ['eyebrow' => 'Para',
    'sub' => 'Bankaya ya da kasaya giren bir tahsilatı kaydedin',
    'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=odemeler">Vazgeç</a>']);
?>
<div class="detail">
<div>
  <section class="card">
    <h3>Tahsilat</h3>
    <form method="post">
      <input type="hidden" name="csrf" value="<?= csrf() ?>">
      <input type="hidden" name="action" value="odeme_add">
      <label>İşletme
        <select name="tenant_id" required>
          <option value="">— işletme seçin —</option>
          <?php foreach (all('SELECT id, code, company_name FROM np_tenants ORDER BY is_active DESC, company_name') as $o): ?>
            <option value="<?= (int) $o['id'] ?>" <?= $tid === (int) $o['id'] ? 'selected' : '' ?>>
              <?= e($o['company_name']) ?> (<?= e($o['code']) ?>)</option>
          <?php endforeach; ?>
        </select></label>
      <label>Fatura
        <select name="invoice_id">
          <option value="0">— faturasız (avans / mahsup) —</option>
          <?php foreach ($open as $o): $left = para_k($o['total']) - para_k($o['paid']); ?>
            <option value="<?= (int) $o['id'] ?>"><?= e($o['no']) ?> · <?= e($o['company_name']) ?>
              · kalan <?= e(para_tl($left)) ?></option>
          <?php endforeach; ?>
        </select></label>
      <p class="hint">Fatura seçilirse ödeme o faturaya işlenir ve tamamı kapandığında fatura
        “ödendi” olur. Seçilen faturanın işletmesi ile yukarıdaki işletme aynı olmalıdır —
        değilse kayıt reddedilir.</p>
      <div class="f2">
        <label>Tutar ₺<input name="amount" inputmode="decimal" required></label>
        <label>Tarih<input name="paid_at" type="date" value="<?= e(date('Y-m-d')) ?>"></label>
        <label>Yöntem<select name="method">
          <?php foreach (['havale', 'nakit', 'kredi_karti', 'diger'] as $m): ?>
            <option value="<?= e($m) ?>"><?= e(para_method_label($m)) ?></option>
          <?php endforeach; ?></select></label>
        <label>Referans<input name="reference" placeholder="dekont no"></label>
      </div>
      <label>Not<textarea name="note"></textarea></label>
      <button class="btn">Ödemeyi kaydet</button>
    </form>
  </section>
</div>
<aside class="rail">
  <section class="card">
    <h3>Açık faturalar</h3>
    <table>
      <?php foreach (array_slice($open, 0, 12) as $o): $left = para_k($o['total']) - para_k($o['paid']); ?>
        <tr><td><a href="index.php?p=fatura&id=<?= (int) $o['id'] ?>"><?= e($o['no']) ?></a>
                <div class="t-sub"><?= e($o['company_name']) ?></div></td>
            <td class="r nums"><?= e(para_tl($left)) ?></td></tr>
      <?php endforeach;
      if (!$open) { echo '<tr><td>'; empty_state('Açık fatura yok', 'Kesilmiş ve tahsil edilmemiş fatura bulunmuyor.'); echo '</td></tr>'; } ?>
    </table>
  </section>
</aside>
</div>
