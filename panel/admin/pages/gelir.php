<?php
/**
 * Gelir - income by month: billed, collected, still late.
 *
 * ---------------------------------------------------------------------------
 * Why this is a table and not a chart
 * ---------------------------------------------------------------------------
 * The obvious drawing here is three series a month - kesilen, tahsilat,
 * geciken - and this product cannot draw it. assets/panel.css states the
 * constraint at the top of the file: #FF7A1A and #EA580C are ONE hue, 8.2
 * apart in OKLab where 15 is the floor for "a reader can tell these apart",
 * and the light one is 2.61:1 on white, under the 3:1 a graphical mark needs.
 * Three series need three colours a reader can name; there is one usable data
 * tone. A grouped bar chart drawn in it would be three bars the reader has to
 * count positions to identify - slower than reading the figure, and wrong more
 * often.
 *
 * So the figures are printed, which is what they are for: an accountant reads
 * "184.320,00" off a table and cannot read it off a bar. The single-hue meter
 * carries the ONE ratio that genuinely benefits from a shape - how much of a
 * month's billing has since been collected - and prints its own percentage
 * beside it, so the bar never has to be measured to be read.
 */
require_once __DIR__ . '/../../lib/para.php';

para_touch_overdue();

$months = para_income_by_month(12);
$age = para_ageing();

$yInv = 0; $yCol = 0; $yNet = 0; $yLate = 0;
foreach ($months as $m) { $yInv += $m['invoiced']; $yCol += $m['collected']; $yNet += $m['net']; $yLate += $m['overdue']; }


/* Who owes the most right now. A total with no names behind it is a rumour,
   which is the rule the rest of this panel already follows. */
$debtors = all("SELECT t.id, t.company_name, t.code,
                       SUM(i.total - COALESCE((SELECT SUM(p.amount) FROM np_payments p WHERE p.invoice_id=i.id),0)) owed,
                       MIN(i.due_at) oldest, COUNT(*) invoices
                  FROM np_invoices i JOIN np_tenants t ON t.id=i.tenant_id
                 WHERE i.status IN ('sent','overdue')
              GROUP BY t.id HAVING owed > 0 ORDER BY owed DESC LIMIT 10");

$best = all("SELECT t.id, t.company_name, COALESCE(SUM(p.amount),0) paid
               FROM np_payments p JOIN np_tenants t ON t.id=p.tenant_id
              WHERE p.paid_at >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)
           GROUP BY t.id ORDER BY paid DESC LIMIT 8");

page_head('Gelir', ['eyebrow' => 'Para',
    'sub' => 'Son 12 ay · kesilen, tahsil edilen ve geciken, ay ay',
    'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=faturalar">Faturalar</a>'
               . '<a class="btn btn-ghost btn-sm" href="index.php?p=odemeler">Ödemeler</a>']);
?>

<div class="stats">
  <div class="stat"><span>12 ayda kesilen</span><b style="font-size:23px"><?= e(para_tl($yInv)) ?></b>
    <small><?= e(para_tl($yNet)) ?> matrah · <?= e(para_tl($yInv - $yNet)) ?> KDV</small></div>
  <div class="stat"><span>12 ayda tahsil edilen</span><b style="font-size:23px"><?= e(para_tl($yCol)) ?></b>
    <small>bu dönemde banka ve kasaya giren</small></div>
  <a class="stat" href="index.php?p=faturalar&s=overdue"><span>Gecikmiş alacak</span>
    <b style="font-size:23px" class="<?= $age['late'] > 0 ? 'bad' : '' ?>"><?= e(para_tl($age['late'])) ?></b>
    <small>vadesi geçmiş ve hâlâ açık</small></a>
  <div class="stat"><span>Toplam açık bakiye</span><b style="font-size:23px"><?= e(para_tl($age['open'])) ?></b>
    <small>kesilmiş, henüz tahsil edilmemiş</small></div>
</div>

<div class="detail">
<div>
  <div class="sec-head" style="margin-top:0"><h3>Ay ay gelir</h3>
    <span class="sub">tutarlar KDV dahil · matrah ayrıca yazılıdır</span></div>
  <div class="scroll-x"><table class="grid">
    <tr><th>Ay</th><th class="r">Kesilen</th><th class="r">Matrah</th>
        <th class="r">Tahsilat</th><th class="r">Geciken</th><th>Dönem tahsilatı</th></tr>
    <?php foreach (array_reverse($months) as $m):
      /* Two different collection figures, deliberately kept apart:
         `collected` is cash that arrived in that month, whatever it was for;
         `period_collected` is how much of THAT month's billing has since been
         paid. They are not the same number and adding them up would be a lie
         about both. The meter shows the second, against that month's billing. */
      $share = $m['invoiced'] > 0 ? min(1, $m['period_collected'] / $m['invoiced']) : 0;
      $pct = $m['invoiced'] > 0 ? round($share * 100) : null; ?>
      <tr>
        <?php /* The invoice count rides under the month rather than taking a
                 column of its own: seven money columns and a bar do not fit the
                 content measure, and the count is context, not a figure anybody
                 reads across. */ ?>
        <td><b><?= e(para_month_label($m['month'])) ?></b>
            <div class="t-sub"><?= $m['count'] ? (int) $m['count'] . ' fatura' : 'fatura yok' ?></div></td>
        <td class="r nums"><b><?= e(para_tl($m['invoiced'])) ?></b></td>
        <td class="r nums muted"><?= e(para_tl($m['net'])) ?></td>
        <td class="r nums"><?= e(para_tl($m['collected'])) ?></td>
        <td class="r nums <?= $m['overdue'] > 0 ? 'warn' : '' ?>">
            <?= $m['overdue'] > 0 ? e(para_tl($m['overdue'])) : '<span class="muted">—</span>' ?></td>
        <td style="min-width:126px"><?php
          /* The meter's label is the percentage alone: the lira figure it
             would otherwise repeat is already two columns to the left, and
             printing it twice is what pushed this table past its column. */
          if ($pct === null) echo '<span class="muted">fatura yok</span>';
          else meter($share, '%' . $pct); ?></td>
      </tr>
    <?php endforeach; ?>
  </table></div>
  <p class="hint" style="margin-top:10px">
    <b>Kesilen</b> o ay düzenlenen faturaların toplamıdır (tahakkuk).
    <b>Tahsilat</b> o ay para olarak girendir — hangi ayın faturası olduğuna bakılmaksızın.
    <b>Dönem tahsilatı</b> ise o ayın faturalarının bugüne kadar ne kadarının ödendiğidir.
    Üçü aynı soruyu sormaz; tek bir “gelir” rakamına indirmek üçünü de bozar.
  </p>
</div>

<aside class="rail">
  <section class="card">
    <h3>Yaşlandırma</h3>
    <p class="hint" style="margin-top:0">Gecikmiş alacağın ne kadar beklediği.</p>
    <table>
      <?php foreach ($age['buckets'] as $k => $v): ?>
        <tr><td><b><?= e($k) ?> gün</b>
          <?php meter($age['late'] > 0 ? $v / $age['late'] : 0, para_tl($v)); ?></td></tr>
      <?php endforeach; ?>
    </table>
  </section>

  <section class="card">
    <h3>En çok borcu olanlar<span class="sp"></span>
      <a href="index.php?p=faturalar&s=overdue">tümü</a></h3>
    <table>
      <?php foreach ($debtors as $d):
        $owed = para_k($d['owed']);
        $late = $d['oldest'] ? (int) floor((strtotime(date('Y-m-d')) - strtotime($d['oldest'])) / 86400) : 0; ?>
        <tr><td><a href="index.php?p=faturalar&tenant=<?= (int) $d['id'] ?>"><?= e($d['company_name']) ?></a>
                <div class="t-sub"><?= (int) $d['invoices'] ?> açık fatura<?= $late > 0 ? ' · en eskisi ' . $late . ' gün' : '' ?></div></td>
            <td class="r nums"><b><?= e(para_tl($owed)) ?></b></td></tr>
      <?php endforeach;
      if (!$debtors) { echo '<tr><td>'; empty_state('Açık alacak yok',
          'Kesilmiş her fatura tahsil edilmiş durumda. Bu ekran boşken yapılacak bir iş yok demektir.');
          echo '</td></tr>'; } ?>
    </table>
  </section>

  <section class="card">
    <h3>Son 12 ayda en çok ödeyen</h3>
    <table>
      <?php foreach ($best as $b): ?>
        <tr><td><a href="index.php?p=tenant&id=<?= (int) $b['id'] ?>"><?= e($b['company_name']) ?></a></td>
            <td class="r nums"><?= e(para_tl(para_k($b['paid']))) ?></td></tr>
      <?php endforeach;
      if (!$best) { echo '<tr><td>'; empty_state('Tahsilat yok', 'Son bir yılda kayıtlı ödeme bulunmuyor.'); echo '</td></tr>'; } ?>
    </table>
  </section>
</aside>
</div>
