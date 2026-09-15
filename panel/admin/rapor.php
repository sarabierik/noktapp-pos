<?php
/**
 * The head-office consolidated report - what an area manager with ten
 * branches opens in the morning.
 *
 * It sits beside the other chain screens and follows the same rule: it does
 * not exist until the tenant has a second branch. A single-shop customer -
 * which is nearly all of them - gets no screen, no tab and no query.
 *
 * The order of the page is the order of the question being asked. WHICH
 * BRANCHES HAVE NOT CLOSED THEIR DAY is first, because it is the one thing
 * this screen can answer that nothing else in the product can: every other
 * figure here could be pieced together branch by branch, but "the Kaleiçi till
 * has sent nothing since Friday" cannot be, and a branch that is missing
 * reads exactly like a branch that is fine until something says otherwise.
 * Turnover comes second.
 */
require_once __DIR__ . '/../lib/rapor.php';

function rapor_is_page(string $p): bool { return $p === 'rapor'; }

/**
 * Has sql/rapor_schema.sql been imported?
 *
 * The panel's posture is that code updated ahead of its migration says so and
 * keeps working, rather than rendering a header and then stopping - which on
 * shared hosting, with display_errors off, is a blank page and nothing to go
 * on. One cheap query buys a sentence that names the file to import.
 */
function rapor_ready(): bool {
    try { val('SELECT 1 FROM np_branch_days LIMIT 1'); return true; }
    catch (Throwable $e) { error_log('rapor: ' . $e->getMessage()); return false; }
}

/** The range from the query string, defaulting to today. */
function rapor_range(): array {
    $to = $_GET['to'] ?? date('Y-m-d');
    $from = $_GET['from'] ?? $to;
    /* Anything unparseable becomes today rather than an error page: a date in
       a URL gets truncated by mail clients and re-typed by hand. */
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $from)) $from = date('Y-m-d');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $to)) $to = date('Y-m-d');
    if ($from > $to) [$from, $to] = [$to, $from];
    return [$from, $to];
}

/**
 * CSV and PDF, before a single byte of HTML.
 *
 * Called from index.php while it is still deciding what to render. It returns
 * for everything that is not an export, so the normal page falls straight
 * through. Both exports build the SAME rapor_pack() the screen renders, so a
 * figure can never differ between the page and the file taken off it.
 */
function rapor_export(): void {
    if (($_GET['p'] ?? '') !== 'rapor') return;
    $fmt = $_GET['export'] ?? '';
    if ($fmt !== 'csv' && $fmt !== 'pdf') return;

    $tid = (int) ($_GET['id'] ?? 0);
    $t = $tid ? one('SELECT * FROM np_tenants WHERE id=?', [$tid]) : null;
    /* The same gate as the screen. An export is a second door onto the same
       data and it gets the same lock: no tenant, no chain, no file. */
    if (!$t || !chain_enabled($tid)) { http_response_code(404); exit('Rapor bulunamadı'); }
    if (!rapor_ready()) { http_response_code(503); exit('Şube raporu tabloları yüklenmemiş: sql/rapor_schema.sql'); }

    [$from, $to] = rapor_range();
    rapor_catch_up($tid);
    $pack = rapor_pack($tid, $from, $to);
    $name = 'sube-raporu-' . $t['code'] . '-' . $from . '_' . $to;
    audit('rapor.export', $t['code'], ['format' => $fmt, 'from' => $from, 'to' => $to]);

    if ($fmt === 'csv') {
        $body = rapor_csv($pack, $t);
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $name . '.csv"');
    } else {
        $body = rapor_pdf($pack, $t);
        header('Content-Type: application/pdf');
        header('Content-Disposition: attachment; filename="' . $name . '.pdf"');
    }
    header('Content-Length: ' . strlen($body));
    header('X-Content-Type-Options: nosniff');
    echo $body;
    exit;
}

/** The state pill. Never green - the palette has no green in it on purpose. */
function rapor_pill(string $state): string {
    if ($state === 'sessiz')   return '<span class="pill pill-suspended">sessiz</span>';
    if ($state === 'bekliyor') return '<span class="pill pill-trial">bekliyor</span>';
    if ($state === 'pasif')    return '<span class="pill">pasif</span>';
    return '<span class="pill pill-active">kapandı</span>';
}

function rapor_page(): void {
    $tid = (int) ($_GET['id'] ?? 0);
    $t = $tid ? one('SELECT * FROM np_tenants WHERE id=?', [$tid]) : null;
    if (!$t) {
        page_head('İşletme bulunamadı', ['sub' => 'Bu kayıt silinmiş ya da adres yanlış olabilir.']);
        echo '<section class="card">';
        empty_state('Kayıt yok', 'Aradığınız işletme bulunamadı.',
            ['href' => 'index.php?p=tenants', 'label' => 'İşletmeler']);
        echo '</section>';
        return;
    }

    /* The gate, identical to the other chain screens: invisible AND
       unreachable by typing the URL until there is a second branch. */
    if (!chain_enabled($tid)) {
        page_head($t['company_name'], ['eyebrow' => 'İşletme',
            'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=tenant&id=' . $tid . '">İşletme kartı</a>']);
        echo '<section class="card">';
        empty_state('Bu işletme tek şube olarak çalışıyor',
            'Şube raporu birden fazla şubeyi karşılaştırır, bu yüzden ikinci şube eklenene kadar açılmaz.',
            ['href' => 'index.php?p=branches&id=' . $tid, 'label' => 'Şubeler']);
        echo '</section>';
        return;
    }

    if (!rapor_ready()) {
        page_head('Şube raporu', ['eyebrow' => $t['company_name']]);
        echo '<div class="flash">Rapor tabloları henüz yüklenmemiş. phpMyAdmin → panel veritabanı → '
           . '<code>sql/rapor_schema.sql</code> dosyasını import edin, sonra bir kez '
           . '<code>php sql/rapor_backfill.php</code> çalıştırın. Diğer ekranlar etkilenmez.</div>';
        return;
    }

    /* Self-healing: the endpoint materialises on the way in, so in a healthy
       system this finds nothing. It exists so a panel whose table was rebuilt,
       or whose migration was imported late, catches up the first time somebody
       opens the screen rather than quietly showing the chain a branch short. */
    rapor_catch_up($tid);

    [$from, $to] = rapor_range();
    $pack = rapor_pack($tid, $from, $to);
    $sheet = rapor_sheet($pack);
    $qs = 'index.php?p=rapor&id=' . $tid . '&from=' . $from . '&to=' . $to;

    $today = date('Y-m-d');
    $presets = [
        'Bugün'      => [$today, $today],
        'Dün'        => [date('Y-m-d', strtotime('-1 day')), date('Y-m-d', strtotime('-1 day'))],
        'Son 7 gün'  => [date('Y-m-d', strtotime('-6 day')), $today],
        'Son 30 gün' => [date('Y-m-d', strtotime('-29 day')), $today],
        'Bu ay'      => [date('Y-m-01'), $today],
    ];
    ?>
    <?php page_head('Şube raporu', ['eyebrow' => $t['company_name'],
        'sub' => 'Önce hangi şubelerin gün sonunu göndermediği, sonra ciro. Eksik bir şube sıfır ciro değildir.',
        'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=tenant&id=' . $tid . '">İşletme kartı</a>']);
    chain_tabs($tid, 'rapor'); ?>

    <div class="row">
      <?php foreach ($presets as $label => [$pf, $pt]): $on = ($pf === $from && $pt === $to); ?>
        <a class="btn btn-sm<?= $on ? '' : ' btn-ghost' ?>"
           href="index.php?p=rapor&id=<?= $tid ?>&from=<?= $pf ?>&to=<?= $pt ?>"><?= e($label) ?></a>
      <?php endforeach; ?>
      <form method="get" class="inline">
        <input type="hidden" name="p" value="rapor">
        <input type="hidden" name="id" value="<?= $tid ?>">
        <input type="date" name="from" value="<?= e($from) ?>" style="width:150px;height:32px;margin:0">
        <input type="date" name="to" value="<?= e($to) ?>" style="width:150px;height:32px;margin:0">
        <button class="btn btn-sm btn-ghost">Göster</button>
      </form>
      <span class="sp"></span>
      <a class="btn btn-sm btn-ghost" href="<?= e($qs) ?>&export=csv">CSV</a>
      <a class="btn btn-sm btn-ghost" href="<?= e($qs) ?>&export=pdf">PDF</a>
    </div>

    <?php
    /* ---------------- the reason the screen exists ---------------- */
    $closed = count(array_filter($pack['status'], fn($s) => $s['state'] === 'kapandi'));
    $open = count($pack['open']);
    $silent = count($pack['silent']);
    ?>
    <section class="card" style="margin-bottom:18px">
      <div class="row"><h3 style="margin:0">Gün sonu durumu · <?= e(rapor_dmy($pack['as_of'])) ?></h3>
        <span class="sp"></span>
        <span class="muted"><?= $closed ?> kapandı · <?= $open ?> bekliyor · <?= $silent ?> sessiz
          <span style="color:var(--line)">|</span> <?= count($pack['status']) ?> aktif şube</span></div>
      <?php if ($silent): ?>
        <div class="flash" style="border-color:#F5C6C2;background:#FDECEA;color:#B42318">
          <b><?= $silent ?> şubeden gün sonu gelmiyor.</b>
          Bu şubeler raporda sıfır ciroyla değil, <b>sessiz</b> olarak görünür — kasa kapalı,
          lisansı durmuş veya internete çıkamıyor olabilir.
        </div>
      <?php elseif ($open === 0): ?>
        <div class="muted">Tüm şubeler <?= e(rapor_dmy($pack['as_of'])) ?> gün sonunu göndermiştir.</div>
      <?php endif; ?>
      <table>
        <?php foreach ($pack['status'] as $s):
          $seen = $s['device_seen'] ? strtotime((string) $s['device_seen']) : 0; ?>
          <tr>
            <td style="width:34%"><b><?= e($s['code']) ?></b> <span class="muted"><?= e($s['name']) ?></span></td>
            <td><?= rapor_pill($s['state']) ?></td>
            <td class="muted"><?php
              if ($s['state'] === 'sessiz') {
                  echo $s['last_day']
                      ? 'son gün sonu ' . e(rapor_dmy($s['last_day'])) . ' · ' . (int) $s['gap'] . ' gündür yok'
                      : 'hiç gün sonu göndermedi';
              } elseif ($s['state'] === 'bekliyor') {
                  echo 'son gün sonu ' . e(rapor_dmy($s['last_day']));
              } else {
                  echo 'gün sonu alındı';
              } ?></td>
            <td class="r muted"><?= $seen ? 'kasa ' . e(date('d.m.Y H:i', $seen)) : 'kasa hiç görülmedi' ?></td>
          </tr>
        <?php endforeach; ?>
      </table>
    </section>

    <div class="stats">
      <div class="stat"><span>Ciro (KDV dahil)</span><b><?= rapor_money($pack['total']['net']) ?> ₺</b></div>
      <div class="stat"><span>KDV (fiyatlara dahil)</span><b><?= rapor_money($pack['total']['vat']) ?> ₺</b></div>
      <div class="stat"><span>Adisyon · ortalama</span><b><?= (int) $pack['total']['orders'] ?></b>
        <span><?= rapor_money($pack['total']['average']) ?> ₺</span></div>
      <div class="stat"><span>Önceki döneme göre</span>
        <b class="<?= $pack['total']['trend'] !== null && $pack['total']['trend'] < 0 ? 'warn' : '' ?>"><?php
          echo $pack['total']['trend'] === null ? '—'
             : (($pack['total']['trend'] > 0 ? '+' : '') . rapor_csv_num($pack['total']['trend'], 1) . '%'); ?></b>
        <span><?= e(rapor_dmy($pack['prev_from'])) ?> – <?= e(rapor_dmy($pack['prev_to'])) ?>:
          <?= rapor_money($pack['total']['prev_net']) ?> ₺</span></div>
    </div>

    <div class="cols" style="margin-bottom:18px">
      <section class="card"><h3>En yüksek ciro</h3>
        <?php if ($pack['best']): ?>
          <p style="font-size:20px;margin:0 0 4px"><b><?= e($pack['best']['code']) ?></b>
            <span class="muted"><?= e($pack['best']['name']) ?></span></p>
          <p style="margin:0"><b><?= rapor_money($pack['best']['net']) ?> ₺</b>
            <span class="muted">· <?= (int) $pack['best']['orders'] ?> adisyon ·
              ort. <?= rapor_money($pack['best']['average']) ?> ₺</span></p>
        <?php else: ?><p class="muted">Bu dönemde hiçbir şubeden gün sonu gelmedi.</p><?php endif; ?>
      </section>
      <section class="card"><h3>En düşük ciro</h3>
        <?php if ($pack['worst']): ?>
          <p style="font-size:20px;margin:0 0 4px"><b><?= e($pack['worst']['code']) ?></b>
            <span class="muted"><?= e($pack['worst']['name']) ?></span></p>
          <p style="margin:0"><b><?= rapor_money($pack['worst']['net']) ?> ₺</b>
            <span class="muted">· <?= (int) $pack['worst']['orders'] ?> adisyon ·
              ort. <?= rapor_money($pack['worst']['average']) ?> ₺</span></p>
          <p class="muted" style="margin:8px 0 0">Yalnızca gün sonu gönderen şubeler karşılaştırılır;
            sessiz bir şube “en düşük” değildir, rakamı olmayan şubedir.</p>
        <?php else: ?><p class="muted">Karşılaştırılacak ikinci şube yok.</p><?php endif; ?>
      </section>
    </div>

    <h3>Şube karşılaştırma · <?= e(rapor_dmy($from)) ?> – <?= e(rapor_dmy($to)) ?></h3>
    <div style="overflow-x:auto">
    <table class="grid">
      <tr><?php foreach ($sheet['cols'] as $c): ?>
        <th class="<?= rapor_is_numeric_col($c['t']) ? 'r' : '' ?>"><?= e($c['tr']) ?></th>
      <?php endforeach; ?></tr>
      <?php $n = count($sheet['rows']);
      foreach ($sheet['rows'] as $i => $r):
        $isTotal = ($i === $n - 1);
        $row = $isTotal ? null : $pack['rows'][$i]; ?>
        <tr<?= $isTotal ? ' style="background:#FAFAFA"' : '' ?>>
          <?php foreach ($sheet['cols'] as $c):
            $v = $r[$c['k']];
            $cls = rapor_is_numeric_col($c['t']) ? 'r' : '';
            if ($c['k'] === 'state' && !$isTotal) {
                echo '<td>' . rapor_pill($row['state']) . ' <span class="muted">' . e($v) . '</span></td>';
                continue;
            }
            if ($c['k'] === 'trend' && $v !== null) {
                $neg = $v < 0;
                echo '<td class="r"' . ($neg ? ' style="color:#B42318"' : '') . '>'
                   . e(rapor_cell($v, $c['t'])) . '</td>';
                continue;
            }
            echo '<td class="' . $cls . '">' . ($isTotal ? '<b>' : '')
               . e(rapor_cell($v, $c['t'])) . ($isTotal ? '</b>' : '') . '</td>';
          endforeach; ?>
        </tr>
      <?php endforeach; ?>
    </table>
    </div>
    <p class="muted" style="margin-top:12px">
      KDV kasanın adisyon adisyon hesapladığı tutardır; fiyatlara dahildir ve burada yeniden hesaplanmaz.
      İptal edilen ve rapor dışı bırakılan adisyonlar hiçbir rakama dahil değildir.
      Maliyet ve kâr yalnızca kasanın gönderdiği günlerde doludur.
      Bir gün birden fazla kez kapatıldıysa yalnızca son kapanış sayılır.
    </p>
    <?php
}
