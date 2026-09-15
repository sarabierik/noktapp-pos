<?php
/**
 * Faturalar - the whole book, with how late each row is.
 *
 * Ageing is the point of this screen. A list of invoices sorted by date says
 * what was billed; a list that says "42 gün gecikti" says who to ring this
 * morning, which is the only reason the vendor opens it.
 *
 * Every figure is printed in three parts - matrah, KDV, toplam - and labelled,
 * because a single "tutar" column is how a KDV-inclusive figure ends up being
 * treated as a net one somewhere downstream.
 */
require_once __DIR__ . '/../../lib/para.php';

/* Cheap, idempotent, and it means the screen is never showing an invoice as
   `sent` on the morning after its due date passed. */
para_touch_overdue();

$status = $_GET['s'] ?? '';
$tenant = (int) ($_GET['tenant'] ?? 0);

$where = []; $args = [];
if (in_array($status, ['draft', 'sent', 'paid', 'overdue', 'cancelled'], true)) { $where[] = 'i.status=?'; $args[] = $status; }
if ($tenant) { $where[] = 'i.tenant_id=?'; $args[] = $tenant; }
$sql = "SELECT i.*, t.company_name, t.code tenant_code,
               COALESCE((SELECT SUM(p.amount) FROM np_payments p WHERE p.invoice_id=i.id),0) paid
          FROM np_invoices i JOIN np_tenants t ON t.id=i.tenant_id"
     . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
     . ' ORDER BY i.issued_at DESC, i.id DESC LIMIT 300';
$rows = all($sql, $args);

$age = para_ageing();
$thisMonth = date('Y-m');
$billed = para_k(val("SELECT COALESCE(SUM(total),0) FROM np_invoices
                       WHERE status<>'cancelled' AND DATE_FORMAT(issued_at,'%Y-%m')=?", [$thisMonth]));
$got = para_k(val("SELECT COALESCE(SUM(amount),0) FROM np_payments
                    WHERE DATE_FORMAT(paid_at,'%Y-%m')=?", [$thisMonth]));

/* What a renewal run would do right now, so the button is never a surprise. */
$cands = para_renewal_candidates(30);
$newCands = 0;
foreach ($cands as $c) if (!$c['exists']) $newCands++;

$tsel = $tenant ? one('SELECT company_name FROM np_tenants WHERE id=?', [$tenant]) : null;

page_head('Faturalar', ['eyebrow' => 'Para',
    'sub' => $tsel ? $tsel['company_name'] . ' · ' . count($rows) . ' fatura'
                   : count($rows) . ' fatura gösteriliyor · ' . para_tl($age['open']) . ' açık bakiye',
    'actions' => '<a class="btn btn-sm" href="index.php?p=fatura&id=0'
               . ($tenant ? '&tenant=' . $tenant : '') . '">Yeni fatura</a>'
               . '<a class="btn btn-ghost btn-sm" href="index.php?p=odemeler">Ödemeler</a>']);
?>

<div class="stats">
  <a class="stat" href="index.php?p=faturalar&s=overdue"><span>Gecikmiş alacak</span>
    <b style="font-size:23px" class="<?= $age['late'] > 0 ? 'bad' : '' ?>"><?= e(para_tl($age['late'])) ?></b>
    <small>vadesi geçmiş ve hâlâ açık</small></a>
  <div class="stat"><span>Toplam açık bakiye</span><b style="font-size:23px"><?= e(para_tl($age['open'])) ?></b>
    <small>taslaklar hariç, kesilmiş ve tahsil edilmemiş</small></div>
  <div class="stat"><span><?= e(para_month_label($thisMonth)) ?> kesilen</span>
    <b style="font-size:23px"><?= e(para_tl($billed)) ?></b><small>KDV dahil</small></div>
  <div class="stat"><span><?= e(para_month_label($thisMonth)) ?> tahsil</span>
    <b style="font-size:23px"><?= e(para_tl($got)) ?></b><small>bu ay banka/kasaya giren</small></div>
</div>

<?php /*
   This screen does NOT use the customer page's rail.

   The invoice list is ten columns wide - a number, a customer, a period, three
   figures that must stay separate (matrah, KDV, genel toplam), what has been
   collected, what is left, a status and a due date - and none of them can be
   dropped without making a money column ambiguous. In a 776px main column
   beside a rail it was 315px too wide and the reader was scrolling a table to
   see whether an invoice was late. So the summary cards sit ABOVE the list, in
   the order the question is actually asked - how bad is the debt, is there a
   renewal run waiting - and the list gets the whole measure.
*/ ?>
<div class="cols">

  <section class="card">
    <h3>Yaşlandırma</h3>
    <p class="hint" style="margin-top:0">Vadesi geçmiş ve hâlâ tahsil edilmemiş tutarın
      ne kadar beklediği. Taslaklar sayılmaz.</p>
    <table>
      <?php foreach ($age['buckets'] as $k => $v):
        $share = $age['late'] > 0 ? $v / $age['late'] : 0; ?>
        <tr><td><b><?= e($k) ?> gün</b>
            <?php meter($share, para_tl($v)); ?></td></tr>
      <?php endforeach; ?>
      <tr><td><b>Toplam gecikmiş</b><span class="sp"></span>
          <div class="t-sub"><?= e(para_tl($age['late'])) ?> · toplam açık <?= e(para_tl($age['open'])) ?></div></td></tr>
    </table>
  </section>

  <section class="card">
    <h3>Yenileme faturaları</h3>
    <p class="hint" style="margin-top:0">Önümüzdeki 30 gün içinde lisansı bitecek ve ücreti tanımlı
      her işletme için bir sonraki dönemin faturasını taslak olarak keser. Lisans ücreti
      <b>KDV dahil</b> kabul edilir; matrah bu tutarın içinden çıkarılır.</p>
    <table>
      <tr><td>Süresi bitecek</td><td class="r"><?= count($cands) ?></td></tr>
      <tr><td>Faturası kesilmemiş</td><td class="r"><b><?= $newCands ?></b></td></tr>
      <tr><td>Zaten kesilmiş</td><td class="r muted"><?= count($cands) - $newCands ?></td></tr>
    </table>
    <div class="ctl"><span><b>Toplu kes</b><i>iki kez çalıştırmak zararsızdır</i></span>
      <form method="post" class="inline ctl-act">
        <input type="hidden" name="csrf" value="<?= csrf() ?>">
        <input type="hidden" name="action" value="fatura_renew">
        <select name="days">
          <option value="30">30 gün içinde bitenler</option>
          <option value="60">60 gün içinde bitenler</option>
          <option value="90">90 gün içinde bitenler</option>
        </select>
        <button class="btn btn-sm">Oluştur</button>
      </form>
    </div>
    <p class="hint" style="margin:10px 0 0">Aynı işletmeye aynı dönem için ikinci bir fatura
      kesilemez — bunu veritabanı engeller, ekran değil.</p>
  </section>

  <?php if ($cands): ?>
  <section class="card">
    <h3>Sırada bekleyenler</h3>
    <table>
      <?php foreach (array_slice($cands, 0, 10) as $c): ?>
        <tr><td><a href="index.php?p=tenant&id=<?= (int) $c['tenant_id'] ?>"><?= e($c['company_name']) ?></a>
                <div class="t-sub"><?= panel_dt($c['period_start'], 'd.m.Y') ?> –
                  <?= panel_dt($c['period_end'], 'd.m.Y') ?></div></td>
            <td class="r"><?= $c['exists']
                ? '<span class="pill pill-active">kesildi</span>'
                : '<span class="nums">' . e(para_tl(para_k($c['price']))) . '</span>' ?></td></tr>
      <?php endforeach; ?>
    </table>
  </section>
  <?php endif; ?>
</div>


  <?php /* The filter row. It POSTs nothing and carries no secret, so it is a
           set of links rather than a form - each one is a bookmarkable list. */ ?>
  <div class="sec-head"><h3>Fatura listesi</h3>
    <span class="sub"><?php
      $f = ['' => 'tümü', 'draft' => 'taslak', 'sent' => 'gönderildi', 'overdue' => 'gecikti',
            'paid' => 'ödendi', 'cancelled' => 'iptal'];
      $out = [];
      foreach ($f as $k => $label) {
          $href = 'index.php?p=faturalar' . ($k ? '&s=' . $k : '') . ($tenant ? '&tenant=' . $tenant : '');
          $out[] = $k === $status ? '<b>' . e($label) . '</b>' : '<a href="' . e($href) . '">' . e($label) . '</a>';
      }
      echo implode(' · ', $out);
    ?></span></div>

  <div class="scroll-x"><table class="grid">
    <tr><th>Fatura</th><th>İşletme</th><th>Dönem</th><th class="r">Matrah</th><th class="r">KDV</th>
        <th class="r">Toplam</th><th class="r">Tahsil</th><th class="r">Kalan</th>
        <th>Durum</th><th class="r">Vade</th></tr>
    <?php foreach ($rows as $r):
      $totK = para_k($r['total']); $paidK = para_k($r['paid']);
      $left = $totK - $paidK;
      $late = para_ageing_days($r); ?>
      <tr>
        <td><a class="t-name" href="index.php?p=fatura&id=<?= (int) $r['id'] ?>"><?= e($r['no']) ?></a>
            <div class="t-sub"><?= panel_dt($r['issued_at'], 'd.m.Y') ?></div></td>
        <td><a href="index.php?p=tenant&id=<?= (int) $r['tenant_id'] ?>"><?= e($r['company_name']) ?></a>
            <div class="t-sub"><?= e($r['tenant_code']) ?></div></td>
        <td class="nums muted"><?= $r['period_start']
              ? panel_dt($r['period_start'], 'd.m.Y') . '<div class="t-sub">' . panel_dt($r['period_end'], 'd.m.Y') . '</div>'
              : '—' ?></td>
        <td class="r nums"><?= e(para_tl(para_k($r['amount']))) ?></td>
        <td class="r nums muted"><?= e(para_tl(para_invoice_vat_k($r))) ?>
            <div class="t-sub">%<?= e(rtrim(rtrim(number_format((float) $r['vat_rate'], 2, ',', '.'), '0'), ',')) ?></div></td>
        <td class="r nums"><b><?= e(para_tl($totK)) ?></b></td>
        <td class="r nums"><?= $paidK ? e(para_tl($paidK)) : '<span class="muted">—</span>' ?></td>
        <td class="r nums <?= ($left > 0 && $late) ? 'warn' : '' ?>"><?= $left > 0 ? e(para_tl($left)) : '<span class="muted">—</span>' ?></td>
        <td><span class="pill <?= e(para_status_pill($r['status'])) ?>"><?= e(para_status_label($r['status'])) ?></span></td>
        <td class="r nums"><?= $r['due_at'] ? panel_dt($r['due_at'], 'd.m.Y') : '—' ?>
            <?= $late !== null && $left > 0 ? '<div class="t-sub"><b>' . $late . ' gün gecikti</b></div>' : '' ?></td>
      </tr>
    <?php endforeach;
    if (!$rows) empty_row(10, 'Bu listede fatura yok',
        $status || $tenant
          ? 'Seçtiğiniz süzgeçte fatura bulunmuyor. Tümünü görmek için süzgeci kaldırın.'
          : 'Henüz fatura kesilmemiş. Bir müşteriye fatura kesin ya da süresi dolmak üzere olan '
          . 'lisanslar için yenileme faturalarını topluca oluşturun.',
        ['href' => 'index.php?p=fatura&id=0', 'label' => 'Yeni fatura']); ?>
  </table></div>

