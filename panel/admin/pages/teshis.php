<?php
/**
 * Kasa teşhis - what is actually inside a customer's till.
 *
 * ---------------------------------------------------------------------------
 * The screen exists so that a phone call does not start with an interrogation
 * ---------------------------------------------------------------------------
 * "Which version are you on? Is the printer the one by the pass or the one in
 * the kitchen? How much room is left on the C drive? When did you last close
 * the day?" - the customer does not know any of that, and every minute spent
 * finding out is a minute of a restaurant not serving. The till already knows
 * all of it and now says so on the heartbeat, so the owner reads the answers
 * before he picks up.
 *
 * Three views, one file, because they are one thought at different depths:
 *   ?p=teshis                          every till, worst first
 *   ?p=teshis&tenant=12                one customer's tills
 *   ?p=teshis&tenant=12&device=abc     one till, in full, with its history
 *
 * ---------------------------------------------------------------------------
 * Why the history is on the page and not behind a link
 * ---------------------------------------------------------------------------
 * A snapshot says "the disk has 900 MB free", which is alarming or normal
 * depending on something a snapshot cannot contain. Four rows above it saying
 * 4.1 GB, 3.0 GB, 1.9 GB, 900 MB is a diagnosis. The fault the owner is being
 * rung about is nearly always the end of a slope, so the slope is printed
 * under the current state rather than one click away from it.
 *
 * ---------------------------------------------------------------------------
 * "bilinmiyor" is not "iyi"
 * ---------------------------------------------------------------------------
 * A till on an older build sends no document at all. It gets its own state and
 * its own sentence, never a clean bill of health: telling the owner a machine
 * looks fine when it has told us nothing is worse than telling him nothing,
 * because he acts on it.
 */
require_once __DIR__ . '/../../lib/teshis.php';

if (!teshis_ready()) {
    page_head('Kasa teşhis', ['eyebrow' => 'Destek']);
    echo '<section class="card">';
    empty_state('Teşhis tabloları yüklenmemiş',
        'sql/teshis_schema.sql henüz uygulanmamış. Panel güncelleme ekranını bir kez açıp '
        . '"Güncellemeyi uygula" deyin; veriniz değişmez.',
        ['href' => 'guncelle.php', 'label' => 'Panel güncelleme']);
    echo '</section>';
    return;
}

$tenantId = (int) ($_GET['tenant'] ?? 0);
$deviceId = substr((string) ($_GET['device'] ?? ''), 0, 64);

/* ==================================================================== *
 *  ONE TILL
 * ==================================================================== */
if ($tenantId && $deviceId !== '') {
    $r = teshis_one($tenantId, $deviceId);
    if (!$r) {
        page_head('Kasa bulunamadı', ['eyebrow' => 'Kasa teşhis',
            'sub' => 'Bu kasa silinmiş ya da adres yanlış olabilir.']);
        echo '<section class="card">';
        empty_state('Böyle bir kasa yok',
            'Kasa kimliği yalnızca kendi işletmesi içinde geçerlidir; başka bir işletmenin '
            . 'kasasına bu adresten ulaşılamaz.',
            ['href' => 'index.php?p=teshis', 'label' => 'Kasa teşhis']);
        echo '</section>';
        return;
    }

    $d = $r['doc'];
    $hist = teshis_history($tenantId, $deviceId);
    [$hk, $hlabel, $hwhy] = $r['health'];
    $pillClass = ['ok' => 'pill-active', 'bad' => 'pill-suspended',
                  'stale' => 'pill-trial', 'unknown' => 'pill-trial'][$hk];

    page_head($r['device_name'] ?: $r['device_id'], [
        'eyebrow' => 'Kasa teşhis · ' . $r['company_name'],
        'sub' => $hwhy,
        'actions' => '<span class="pill ' . $pillClass . '">' . e($hlabel) . '</span>'
                   . '<a class="btn btn-ghost btn-sm" href="index.php?p=tenant&id=' . $tenantId . '">İşletme</a>'
                   . '<a class="btn btn-ghost btn-sm" href="index.php?p=teshis&tenant=' . $tenantId . '">Bu işletmenin kasaları</a>',
    ]);
    ?>
    <div class="stats">
      <div class="stat"><span>Son teşhis belgesi</span>
        <b style="font-size:23px"><?= $r['received_at'] ? e(panel_ago($r['received_at'])) : '—' ?></b>
        <small><?= $r['received_at'] ? e(panel_dt($r['received_at'])) : 'bu kasa hiç belge göndermedi' ?></small></div>
      <div class="stat"><span>Boş disk</span>
        <b style="font-size:23px" class="<?= ($r['disk_free_mb'] !== null && $r['disk_free_mb'] < 2048) ? 'bad' : '' ?>">
          <?= e(teshis_mb($r['disk_free_mb'] === null ? null : (int) $r['disk_free_mb'])) ?></b>
        <small><?= isset($d['disk_total_mb']) && $d['disk_total_mb']
              ? e(teshis_mb((int) $d['disk_total_mb'])) . ' toplam' : 'veri sürücüsü' ?></small></div>
      <div class="stat"><span>Veritabanı</span>
        <b style="font-size:23px"><?= e(teshis_mb($r['db_size_mb'] === null ? null : (int) $r['db_size_mb'])) ?></b>
        <small><?= e($r['engine_version'] ?: 'motor sürümü bilinmiyor') ?></small></div>
      <div class="stat"><span>Açık adisyon</span>
        <b style="font-size:23px"><?= $r['open_bills'] === null ? '—' : (int) $r['open_bills'] ?></b>
        <small>gün sonu <?= $r['last_close_date'] ? e(panel_dt($r['last_close_date'], 'd.m.Y')) : 'yok' ?></small></div>
    </div>

    <div class="detail">
    <div>
      <section class="card">
        <h3>Makine</h3>
        <p class="hint" style="margin-top:0">Kasanın kendi bildirdiği kurulum bilgileri.
          Bu sayfada hiçbir müşteri, misafir ya da adisyon bilgisi yoktur — kasa yalnızca
          sayı ve makine bilgisi gönderir.</p>
        <table class="grid">
          <?php /* The heartbeat's own app_version if the till reported one, else
                   the document's. They are the same number in practice; an
                   older till that pushes a document without one is why the
                   fallback runs this way round and not the other. */ ?>
          <tr><td>Uygulama sürümü</td>
              <td class="r"><?= e($r['app_version'] ?: ($d['app_version'] ?? '') ?: '—') ?></td></tr>
          <tr><td>Veritabanı motoru</td><td class="r"><?= e($r['engine_version'] ?: '—') ?></td></tr>
          <tr><td>İşletim sistemi</td><td class="r"><?= e($r['os'] ?: '—') ?></td></tr>
          <?php if (!empty($d['node'])): ?>
            <tr><td>Çalışma ortamı</td><td class="r muted mono">Node <?= e($d['node']) ?></td></tr>
          <?php endif; ?>
          <?php if (isset($d['uptime_h'])): ?>
            <tr><td>Bilgisayar açık kalma</td><td class="r"><?= (int) $d['uptime_h'] ?> saat</td></tr>
          <?php endif; ?>
          <tr><td>İstasyon sayısı</td><td class="r"><?= $r['stations'] === null ? '—' : (int) $r['stations'] ?></td></tr>
          <tr><td>Son IP</td><td class="r muted mono"><?= e($r['last_ip'] ?: '—') ?></td></tr>
          <tr><td>Son bağlantı (heartbeat)</td><td class="r muted"><?= e(panel_ago($r['last_seen_at'])) ?></td></tr>
          <tr><td>İlk görülme</td><td class="r muted"><?= e(panel_dt($r['first_seen_at'], 'd.m.Y')) ?></td></tr>
          <tr><td>Kasa kimliği</td><td class="r muted mono"><?= e($r['device_id']) ?></td></tr>
        </table>
      </section>

      <section class="card">
        <h3>Yazıcılar<span class="sp"></span>
          <?= (int) $r['printers_bad'] > 0
              ? '<span class="pill pill-suspended">' . (int) $r['printers_bad'] . ' hatalı</span>'
              : '' ?></h3>
        <p class="hint" style="margin-top:0">Son durum, o yazıcının istasyonuna giden en son
          yazdırma işinin sonucudur. <b>hata</b>, işin gönderilemediği anlamına gelir —
          kablo, ağ ya da kapalı yazıcı.</p>
        <div class="scroll-x"><table class="grid">
          <tr><th>Yazıcı</th><th>Tür</th><th>Adres</th><th>İstasyon</th><th class="r">Son iş</th></tr>
          <?php foreach (($d['printers'] ?? []) as $p):
            $last = $p['last'] ?? null;
            $pill = $last === 'failed' ? 'pill-suspended' : ($last === 'pending' ? 'pill-trial' : 'pill-active');
            $txt = ['done' => 'başarılı', 'failed' => 'hata', 'pending' => 'kuyrukta', 'yok' => 'hiç iş yok'][$last] ?? '—'; ?>
            <tr><td class="t-name"><?= e($p['name'] ?: '—') ?></td>
                <td><?= e($p['type'] ?: '—') ?></td>
                <td class="muted mono"><?= e($p['target'] ?: '—') ?></td>
                <td class="muted"><?= e($p['station'] ?: '—') ?></td>
                <td class="r"><span class="pill <?= $pill ?>"><?= e($txt) ?></span>
                  <?php if (!empty($p['last_at'])): ?>
                    <div class="t-sub"><?= e(panel_dt($p['last_at'])) ?></div>
                  <?php endif; ?></td></tr>
          <?php endforeach;
          if (empty($d['printers'])) {
            empty_row(5, $r['received_at'] ? 'Tanımlı yazıcı yok' : 'Yazıcı bilgisi gelmedi',
              $r['received_at']
                ? 'Bu kasada hiç yazıcı tanımlı değil. Fiş ve mutfak çıktısı alınamaz.'
                : 'Kasa teşhis belgesi göndermeden yazıcı listesi bilinemez. Sürümü güncel mi?');
          } ?>
        </table></div>
        <?php if ($r['print_pending'] !== null): ?>
          <div class="ctl"><span><b>Bekleyen yazdırma işi</b>
            <i>kuyrukta duran iş, yazıcının cevap vermediği anlamına gelir</i></span>
            <span class="ctl-act"><b style="font-size:19px"><?= (int) $r['print_pending'] ?></b></span></div>
        <?php endif; ?>
      </section>

      <section class="card">
        <h3>Son hata satırları</h3>
        <p class="hint" style="margin-top:0">Kasanın kendi günlüğünden, en son
          <?= NP_DIAG_LINES ?> hata satırı. E-posta, telefon ve kimlik numarası
          benzeri her şey kasada ve panelde iki kez temizlenir.</p>
        <?php if (!empty($d['log'])): ?>
          <div class="scroll-x"><table class="grid">
            <?php foreach ($d['log'] as $line): ?>
              <tr><td class="mono" style="font-size:12.5px"><?= e($line) ?></td></tr>
            <?php endforeach; ?>
          </table></div>
        <?php else:
          echo '<div class="scroll-x"><table class="grid">';
          empty_row(1, $r['received_at'] ? 'Hata satırı yok' : 'Günlük gelmedi',
            $r['received_at']
              ? 'Son 24 saatte kasanın günlüğüne hata düşmemiş. Aranan sorun kayıtlı bir hata değil.'
              : 'Kasa teşhis belgesi göndermemiş.');
          echo '</table></div>';
        endif; ?>
      </section>

      <section class="card">
        <h3>Geçmiş<span class="sp"></span><span class="muted" style="font-size:12.5px">
          son <?= NP_DIAG_KEEP ?> belge</span></h3>
        <p class="hint" style="margin-top:0">Aynı belgenin önceki hâlleri. Bir arıza çoğu zaman
          bir eğimin sonudur: burada disk, kuyruk ve hata sayısının nasıl gittiği görülür.</p>
        <div class="scroll-x"><table class="grid">
          <tr><th>Zaman</th><th>Sürüm</th><th class="r">Boş disk</th><th class="r">VT</th>
              <th class="r">Hatalı yazıcı</th><th class="r">Kuyruk</th>
              <th class="r">Açık adisyon</th><th class="r">Hata (24s)</th></tr>
          <?php foreach ($hist as $h): $x = $h['doc'];
            $bad = 0; foreach (($x['printers'] ?? []) as $p) if (($p['last'] ?? '') === 'failed') $bad++; ?>
            <tr><td class="muted nums"><?= e(panel_dt($h['received_at'])) ?></td>
                <td class="muted"><?= e($x['app_version'] ?? '—') ?></td>
                <td class="r nums"><?= e(teshis_mb(isset($x['disk_free_mb']) ? (int) $x['disk_free_mb'] : null)) ?></td>
                <td class="r nums muted"><?= e(teshis_mb(isset($x['db_size_mb']) ? (int) $x['db_size_mb'] : null)) ?></td>
                <td class="r nums"><?= $bad ?: '<span class="muted">0</span>' ?></td>
                <td class="r nums muted"><?= (int) ($x['print_pending'] ?? 0) ?></td>
                <td class="r nums muted"><?= (int) ($x['open_bills'] ?? 0) ?></td>
                <td class="r nums"><?= (int) ($x['errors_24h'] ?? 0) ?></td></tr>
          <?php endforeach;
          if (!$hist) empty_row(8, 'Geçmiş yok',
            'Kasa ilk teşhis belgesini gönderdiğinde burada birikmeye başlar; her belge en fazla '
            . 'saatte bir gelir.'); ?>
        </table></div>
      </section>
    </div>

    <aside class="rail">
      <section class="card">
        <h3>Durum</h3>
        <p class="hint" style="margin-top:0"><?= e($hwhy) ?></p>
        <table>
          <tr><td>Teşhis</td><td class="r"><span class="pill <?= $pillClass ?>"><?= e($hlabel) ?></span></td></tr>
          <tr><td>Hatalı yazıcı</td><td class="r"><?= $r['printers_bad'] === null ? '—' : (int) $r['printers_bad'] ?></td></tr>
          <tr><td>Bekleyen çıktı</td><td class="r"><?= $r['print_pending'] === null ? '—' : (int) $r['print_pending'] ?></td></tr>
          <tr><td>24 saatte hata</td><td class="r"><?= $r['errors'] === null ? '—' : (int) $r['errors'] ?></td></tr>
          <?php if ($r['is_blocked']): ?>
            <tr><td>Kasa</td><td class="r"><span class="pill pill-suspended">engelli</span></td></tr>
          <?php endif; ?>
        </table>
      </section>

      <section class="card">
        <h3>ÖKC</h3>
        <?php if (!empty($r['okc'])): ?>
          <table>
            <tr><td>Durum</td><td class="r"><span class="pill pill-active">tanımlı</span></td></tr>
            <tr><td>Sağlayıcı</td><td class="r"><?= e($d['okc_provider'] ?? '—') ?></td></tr>
            <tr><td>Cihaz</td><td class="r"><?= (int) ($d['okc_devices'] ?? 0) ?></td></tr>
            <tr><td>Son bilinen durum</td><td class="r muted"><?= e($d['okc_status'] ?? '—') ?></td></tr>
          </table>
          <p class="hint" style="margin:10px 0 0">Cihaz seri numarası kasada kalır, panele
            gönderilmez.</p>
        <?php else: ?>
          <p class="hint" style="margin-top:0">Bu kasada ÖKC tanımlı değil. Ödemeler yazarkasadan
            geçmiyor demektir; müşteri fiş kesiyorsa başka bir cihazdan kesiyordur.</p>
        <?php endif; ?>
      </section>

      <section class="card">
        <h3>Gün sonu ve yedek</h3>
        <table>
          <tr><td>Son gün sonu</td>
              <td class="r"><?= $r['last_close_date'] ? e(panel_dt($r['last_close_date'], 'd.m.Y')) : '—' ?></td></tr>
          <?php if (!empty($d['last_close_seq'])): ?>
            <tr><td>Kapanış sırası</td><td class="r muted"><?= (int) $d['last_close_seq'] ?></td></tr>
          <?php endif; ?>
          <tr><td>Kasadaki son yedek</td>
              <td class="r muted"><?= !empty($d['backup_at']) ? e(panel_dt($d['backup_at'])) : '—' ?>
                <?= !empty($d['backup_mb']) ? '<div class="t-sub">' . e(teshis_mb((int) $d['backup_mb'])) . '</div>' : '' ?></td></tr>
        </table>
        <p class="hint" style="margin:10px 0 0">Buradaki yedek kasanın kendi diskindeki dosyadır.
          Bulut yedeği ayrıdır ve <a href="index.php?p=backups">Yedekler</a> ekranında görülür.</p>
      </section>

      <section class="card">
        <h3>Kısayollar</h3>
        <table>
          <tr><td><a href="index.php?p=tenant&id=<?= $tenantId ?>">İşletme sayfası</a></td>
              <td class="r muted"><?= e($r['tenant_code']) ?></td></tr>
          <tr><td><a href="index.php?p=teshis&tenant=<?= $tenantId ?>">Bu işletmenin kasaları</a></td><td></td></tr>
          <tr><td><a href="index.php?p=devices">Tüm kasalar</a></td><td></td></tr>
        </table>
      </section>
    </aside>
    </div>
    <?php
    return;
}

/* ==================================================================== *
 *  THE LIST - every till, or one customer's
 * ==================================================================== */
$rows = teshis_list($tenantId ?: null);
$t = $tenantId ? one('SELECT id, company_name, code FROM np_tenants WHERE id=?', [$tenantId]) : null;

$n = ['ok' => 0, 'bad' => 0, 'stale' => 0, 'unknown' => 0];
foreach ($rows as $r) $n[$r['health'][0]]++;

/* Worst first: a support screen sorted by name is a directory. The order is
   "needs me", "told me nothing", "old news", "fine" - and inside each, the
   least recently heard from. */
$rank = ['bad' => 0, 'unknown' => 1, 'stale' => 2, 'ok' => 3];
usort($rows, function ($a, $b) use ($rank) {
    $c = $rank[$a['health'][0]] <=> $rank[$b['health'][0]];
    if ($c !== 0) return $c;
    return strcmp((string) $a['last_seen_at'], (string) $b['last_seen_at']);
});

page_head($t ? $t['company_name'] . ' · kasalar' : 'Kasa teşhis', [
    'eyebrow' => $t ? 'Kasa teşhis · ' . $t['code'] : 'Destek',
    'sub' => count($rows) . ' kasa · ' . $n['ok'] . ' sorunsuz · ' . $n['bad'] . ' ilgi bekliyor · '
           . ($n['unknown'] + $n['stale']) . ' bilgi yok ya da eski',
    'actions' => ($t ? '<a class="btn btn-ghost btn-sm" href="index.php?p=tenant&id=' . (int) $t['id'] . '">İşletme</a>'
                     . '<a class="btn btn-ghost btn-sm" href="index.php?p=teshis">Tüm kasalar</a>'
                     : '<a class="btn btn-ghost btn-sm" href="index.php?p=devices">Kasa listesi</a>'),
]);
?>

<div class="stats">
  <div class="stat"><span>Kasa</span><b><?= count($rows) ?></b>
    <small>panelin tanıdığı kurulum</small></div>
  <div class="stat"><span>İlgi bekliyor</span>
    <b class="<?= $n['bad'] ? 'bad' : '' ?>"><?= $n['bad'] ?></b>
    <small>yazıcı, kuyruk, disk ya da gün sonu</small></div>
  <div class="stat"><span>Sorun görünmüyor</span><b><?= $n['ok'] ?></b>
    <small>son belgede dikkat çeken yok</small></div>
  <div class="stat"><span>Belge yok / eski</span>
    <b class="<?= ($n['unknown'] + $n['stale']) ? 'warn' : '' ?>"><?= $n['unknown'] + $n['stale'] ?></b>
    <small>eski sürüm ya da <?= NP_DIAG_STALE_HOURS ?> saatten eski bilgi</small></div>
</div>

<p class="hint">Bir kasa teşhis belgesi göndermemişse durumu <b>bilinmiyor</b>'dur —
  <b>sorunsuz</b> değil. Panel, kendisine hiçbir şey söylememiş bir makine için iyi haber uyduramaz.</p>

<div class="scroll-x"><table class="grid">
  <tr><th>İşletme</th><th>Kasa</th><th>Durum</th><th>Sürüm</th>
      <th class="r">Boş disk</th><th class="r">VT</th><th class="r">Yazıcı</th>
      <th class="r">Kuyruk</th><th class="r">Açık</th><th class="r">Son belge</th></tr>
  <?php foreach ($rows as $r):
    [$hk, $hlabel, ] = $r['health'];
    $pill = ['ok' => 'pill-active', 'bad' => 'pill-suspended',
             'stale' => 'pill-trial', 'unknown' => 'pill-trial'][$hk];
    $href = 'index.php?p=teshis&tenant=' . (int) $r['tenant_id'] . '&device=' . rawurlencode($r['device_id']); ?>
    <tr>
      <td><a class="t-name" href="index.php?p=tenant&id=<?= (int) $r['tenant_id'] ?>"><?= e($r['company_name']) ?></a>
          <div class="t-sub"><?= e($r['tenant_code']) ?></div></td>
      <td><a class="t-name" href="<?= e($href) ?>"><?= e($r['device_name'] ?: $r['device_id']) ?></a>
          <div class="t-sub mono"><?= e(mb_substr($r['device_id'], 0, 18)) ?></div></td>
      <td><a href="<?= e($href) ?>"><span class="pill <?= $pill ?>"><?= e($hlabel) ?></span></a></td>
      <td><?= e($r['app_version'] ?: '—') ?></td>
      <td class="r nums"><?= e(teshis_mb($r['disk_free_mb'] === null ? null : (int) $r['disk_free_mb'])) ?></td>
      <td class="r nums muted"><?= e(teshis_mb($r['db_size_mb'] === null ? null : (int) $r['db_size_mb'])) ?></td>
      <td class="r nums"><?php
        if ($r['printers'] === null) echo '<span class="muted">—</span>';
        else echo (int) $r['printers'] . ((int) $r['printers_bad'] > 0
             ? ' <span class="pill pill-suspended">' . (int) $r['printers_bad'] . '</span>' : ''); ?></td>
      <td class="r nums muted"><?= $r['print_pending'] === null ? '—' : (int) $r['print_pending'] ?></td>
      <td class="r nums muted"><?= $r['open_bills'] === null ? '—' : (int) $r['open_bills'] ?></td>
      <td class="r muted"><?= $r['received_at'] ? e(panel_ago($r['received_at'])) : '—' ?></td>
    </tr>
  <?php endforeach;
  if (!$rows) empty_row(10, 'Kasa yok',
      $t ? 'Bu işletmede kurulu kasa görünmüyor. Kasa ilk lisans doğrulamasında kendiliğinden kaydolur.'
         : 'Henüz hiçbir kasa panele bağlanmadı. Bir bilgisayara NOKTApp POS kurulup lisans girildiğinde burada belirir.',
      ['href' => 'index.php?p=devices', 'label' => 'Kasa listesi']); ?>
</table></div>
