<?php
/**
 * Ödemeler - what actually arrived.
 *
 * Kept as its own screen rather than a tab on Faturalar because the two answer
 * different questions. Faturalar is what customers owe; this is what the bank
 * received, in the order it received it, and it is the list the vendor
 * reconciles against a statement.
 */
require_once __DIR__ . '/../../lib/para.php';

para_touch_overdue();

$tenant = (int) ($_GET['tenant'] ?? 0);
$method = $_GET['m'] ?? '';

$where = []; $args = [];
if ($tenant) { $where[] = 'p.tenant_id=?'; $args[] = $tenant; }
if (in_array($method, ['havale', 'nakit', 'kredi_karti', 'diger'], true)) { $where[] = 'p.method=?'; $args[] = $method; }
$rows = all('SELECT p.*, t.company_name, t.code tenant_code, i.no invoice_no, i.status invoice_status
               FROM np_payments p
               JOIN np_tenants t ON t.id=p.tenant_id
          LEFT JOIN np_invoices i ON i.id=p.invoice_id'
          . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
          . ' ORDER BY p.paid_at DESC, p.id DESC LIMIT 300', $args);

$thisMonth = date('Y-m');
$monthK = para_k(val("SELECT COALESCE(SUM(amount),0) FROM np_payments WHERE DATE_FORMAT(paid_at,'%Y-%m')=?", [$thisMonth]));
$yearK = para_k(val("SELECT COALESCE(SUM(amount),0) FROM np_payments WHERE YEAR(paid_at)=?", [(int) date('Y')]));
$openK = para_ageing()['open'];
$byMethod = all("SELECT method, COUNT(*) c, COALESCE(SUM(amount),0) t FROM np_payments
                  WHERE paid_at >= DATE_SUB(CURDATE(), INTERVAL 365 DAY) GROUP BY method ORDER BY t DESC");
$methodTotal = 0;
foreach ($byMethod as $m) $methodTotal += para_k($m['t']);

$tsel = $tenant ? one('SELECT company_name FROM np_tenants WHERE id=?', [$tenant]) : null;

page_head('Ödemeler', ['eyebrow' => 'Para',
    'sub' => $tsel ? $tsel['company_name'] . ' · ' . count($rows) . ' tahsilat'
                   : count($rows) . ' tahsilat gösteriliyor',
    'actions' => '<a class="btn btn-sm" href="index.php?p=odeme">Ödeme kaydet</a>'
               . '<a class="btn btn-ghost btn-sm" href="index.php?p=faturalar">Faturalar</a>']);
?>

<div class="stats">
  <div class="stat"><span><?= e(para_month_label($thisMonth)) ?> tahsilat</span>
    <b style="font-size:23px"><?= e(para_tl($monthK)) ?></b><small>bu ay giren para</small></div>
  <div class="stat"><span><?= (int) date('Y') ?> tahsilat</span>
    <b style="font-size:23px"><?= e(para_tl($yearK)) ?></b><small>yıl başından bugüne</small></div>
  <a class="stat" href="index.php?p=faturalar&s=overdue"><span>Bekleyen alacak</span>
    <b style="font-size:23px" class="<?= $openK > 0 ? 'warn' : '' ?>"><?= e(para_tl($openK)) ?></b>
    <small>kesilmiş ve hâlâ tahsil edilmemiş</small></a>
  <div class="stat"><span>Kayıtlı tahsilat</span>
    <b><?= (int) val('SELECT COUNT(*) FROM np_payments') ?></b><small>tüm zamanlar</small></div>
</div>

<div class="detail">
<div>
  <div class="sec-head" style="margin-top:0"><h3>Tahsilat listesi</h3>
    <span class="sub"><?php
      $out = [];
      foreach (['' => 'tümü', 'havale' => 'Havale/EFT', 'nakit' => 'Nakit',
                'kredi_karti' => 'Kredi kartı', 'diger' => 'Diğer'] as $k => $label) {
          $href = 'index.php?p=odemeler' . ($k ? '&m=' . $k : '') . ($tenant ? '&tenant=' . $tenant : '');
          $out[] = $k === $method ? '<b>' . e($label) . '</b>' : '<a href="' . e($href) . '">' . e($label) . '</a>';
      }
      echo implode(' · ', $out);
    ?></span></div>

  <div class="scroll-x"><table class="grid">
    <tr><th>Tarih</th><th>İşletme</th><th>Fatura</th><th>Yöntem</th><th>Referans</th><th class="r">Tutar</th></tr>
    <?php foreach ($rows as $r): ?>
      <tr>
        <td class="nums"><?= panel_dt($r['paid_at'], 'd.m.Y') ?></td>
        <td><a class="t-name" href="index.php?p=tenant&id=<?= (int) $r['tenant_id'] ?>"><?= e($r['company_name']) ?></a>
            <div class="t-sub"><?= e($r['tenant_code']) ?></div></td>
        <td><?php if ($r['invoice_id']): ?>
              <a href="index.php?p=fatura&id=<?= (int) $r['invoice_id'] ?>"><?= e($r['invoice_no']) ?></a>
              <div class="t-sub"><?= e(para_status_label((string) $r['invoice_status'])) ?></div>
            <?php else: ?>
              <span class="muted">faturasız</span><div class="t-sub">avans / mahsup</div>
            <?php endif; ?></td>
        <td><?= e(para_method_label($r['method'])) ?></td>
        <td class="muted mono"><?= e($r['reference'] ?: '—') ?></td>
        <td class="r nums"><b><?= e(para_tl(para_k($r['amount']))) ?></b></td>
      </tr>
    <?php endforeach;
    if (!$rows) empty_row(6, 'Tahsilat kaydı yok',
        'Bir fatura tahsil edildiğinde fatura sayfasından kaydedin; kayıt hem burada hem de '
      . 'işletmenin kendi sayfasındaki bakiyede görünür.',
        ['href' => 'index.php?p=faturalar', 'label' => 'Faturalar']); ?>
  </table></div>
</div>

<aside class="rail">
  <section class="card">
    <h3>Son 12 ayın yöntem dağılımı</h3>
    <table>
      <?php foreach ($byMethod as $m):
        $k = para_k($m['t']); ?>
        <tr><td><b><?= e(para_method_label($m['method'])) ?></b>
            <div class="t-sub"><?= (int) $m['c'] ?> tahsilat</div>
            <?php meter($methodTotal > 0 ? $k / $methodTotal : 0, para_tl($k)); ?></td></tr>
      <?php endforeach;
      if (!$byMethod) { echo '<tr><td>'; empty_state('Veri yok', 'Son bir yılda kayıtlı tahsilat bulunmuyor.'); echo '</td></tr>'; } ?>
    </table>
  </section>
  <section class="card">
    <h3>Nasıl kaydedilir</h3>
    <p class="hint" style="margin:0">En kısa yol faturayı açıp sağdaki <b>Ödeme kaydet</b> kutusunu
      kullanmaktır: tutar kalan bakiyeyle dolu gelir ve fatura tamamı tahsil edildiğinde
      kendiliğinden “ödendi” olur. Kısmi ödeme faturayı kapatmaz.</p>
  </section>
</aside>
</div>
