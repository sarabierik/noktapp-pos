<?php
/**
 * Uyarılar - the rules, what has already gone out, and the cron line.
 *
 * ---------------------------------------------------------------------------
 * What this screen is FOR
 * ---------------------------------------------------------------------------
 * Not for reading alerts. If the owner has to open a screen to find out that a
 * licence expires on Friday, the alerts have failed and this page is just
 * another dashboard he will stop visiting. The e-mail is the product. This
 * page exists to answer three questions he will have exactly once each:
 *
 *   Is it switched on and running?   (the cron's last run, at the top)
 *   What will it warn me about?      (the four rules and their thresholds)
 *   How do I set it up?              (the cPanel line, ready to paste)
 *
 * ---------------------------------------------------------------------------
 * Why the "gönderilenler" list is here at all
 * ---------------------------------------------------------------------------
 * Because de-duplication is invisible when it works. Without this list, an
 * owner who saw one e-mail about a customer on Monday and none on Tuesday
 * cannot tell whether the alert is suppressed-because-already-said or broken.
 * The list prints the occasion key beside each row, which is the thing that
 * decides it, so "why did I not hear about this again" has an answer on the
 * page rather than in a support call to us.
 */
require_once __DIR__ . '/../uyari.php';

if (!uyari_ready()) {
    page_head('Uyarılar', ['eyebrow' => 'Sistem']);
    echo '<section class="card">';
    empty_state('Uyarı tabloları yüklenmemiş',
        'sql/uyari_schema.sql henüz uygulanmamış. Panel güncelleme ekranını bir kez açıp '
        . '"Güncellemeyi uygula" deyin; veriniz değişmez.',
        ['href' => 'guncelle.php', 'label' => 'Panel güncelleme']);
    echo '</section>';
    return;
}

$kinds  = uyari_kinds();
$rules  = uyari_rules();
$recent = uyari_recent(40);
$last   = uyari_last_run();
$dry    = $_SESSION['uyari_dry'] ?? null;
unset($_SESSION['uyari_dry']);

$active = 0;
foreach ($rules as $r) if ($r['is_active']) $active++;

$sent24 = (int) val('SELECT COUNT(*) FROM np_alert_sent WHERE sent_at > DATE_SUB(NOW(), INTERVAL 1 DAY)');
$sentAll = (int) val('SELECT COUNT(*) FROM np_alert_sent');

/* How long since the cron last called. Anything over about three hours on an
   hourly job means the cron line is not installed or the host stopped it, and
   that is the single most important thing this page can say. */
$lastAgo = $last ? (time() - strtotime($last)) : null;
$cronOk = $lastAgo !== null && $lastAgo < 3 * 3600;

page_head('Uyarılar', ['eyebrow' => 'Sistem',
    'sub' => 'Kurallar saatte bir değerlendirilir; aynı olay için yalnızca bir e-posta gönderilir.',
    'actions' => '<form method="post" class="inline">'
               . '<input type="hidden" name="csrf" value="' . csrf() . '">'
               . '<input type="hidden" name="action" value="uyari_dry">'
               . '<button class="btn btn-ghost btn-sm">Prova et</button></form>'
               . '<form method="post" class="inline" style="margin-left:6px">'
               . '<input type="hidden" name="csrf" value="' . csrf() . '">'
               . '<input type="hidden" name="action" value="uyari_run">'
               . '<button class="btn btn-sm">Şimdi çalıştır</button></form>']);
?>

<?php if (!$cronOk): ?>
  <div class="flash bad">
    <?= $last
        ? 'Cron son olarak ' . e(panel_ago($last)) . ' çalıştı. Saatlik bir görev için bu çok uzun — '
          . 'aşağıdaki satır cPanel’de kurulu mu?'
        : 'Cron hiç çalışmamış. Aşağıdaki satırı cPanel > Cron Jobs ekranına ekleyene kadar '
          . 'hiçbir uyarı gönderilmez.' ?>
  </div>
<?php endif; ?>

<div class="stats">
  <div class="stat"><span>Cron son çalışma</span>
    <b style="font-size:23px" class="<?= $cronOk ? '' : 'bad' ?>"><?= $last ? e(panel_ago($last)) : 'hiç' ?></b>
    <small><?= $last ? e(panel_dt($last)) : 'cPanel görevi henüz kurulmadı' ?></small></div>
  <div class="stat"><span>Açık kural</span><b style="font-size:23px"><?= $active ?> / <?= count($rules) ?></b>
    <small>kapalı bir kural hiç değerlendirilmez</small></div>
  <div class="stat"><span>Son 24 saatte gönderilen</span><b style="font-size:23px"><?= $sent24 ?></b>
    <small>tekrar edenler gönderilmez</small></div>
  <div class="stat"><span>Toplam uyarı</span><b style="font-size:23px"><?= $sentAll ?></b>
    <small>bu panelin ömrü boyunca</small></div>
</div>

<?php if ($dry): ?>
  <div class="flash">
    <b>Prova sonucu — hiçbir e-posta gönderilmedi, hiçbir kayıt yazılmadı.</b>
    <?php foreach ($dry['rules'] ?? [] as $r): ?>
      <div><?= e($kinds[$r['kind']]['label'] ?? $r['kind']) ?>:
        <?= (int) $r['found'] ?> aday · <b><?= (int) $r['sent'] ?></b> gönderilecek ·
        <?= (int) $r['skipped'] ?> daha önce gönderilmiş<?= $r['note'] ? ' · ' . e($r['note']) : '' ?></div>
    <?php endforeach; ?>
  </div>
<?php endif; ?>

<div class="detail">
<div>
  <div class="sec-head" style="margin-top:0"><h3>Kurallar</h3>
    <span class="sub">eşikler gün cinsindendir</span></div>

  <?php foreach ($rules as $r):
    $k = $kinds[$r['kind']] ?? ['label' => $r['kind'], 'unit' => 'gün', 'help' => ''];
    $cands = [];
    try { if ($r['is_active']) $cands = uyari_candidates($r); }
    catch (Throwable $ex) { error_log('uyari candidates: ' . $ex->getMessage()); }
    $seen = $cands ? uyari_sent_set((int) $r['id']) : [];
    $pending = 0;
    foreach ($cands as $c) if (!isset($seen[$c['tenant_id'] . '|' . $c['subject_key']])) $pending++;
    ?>
    <section class="card">
      <h3><?= e($k['label']) ?><span class="sp"></span>
        <?= $r['is_active']
            ? '<span class="pill pill-active">açık</span>'
            : '<span class="pill pill-suspended">kapalı</span>' ?></h3>
      <p class="hint" style="margin-top:0"><?= e($k['help']) ?></p>

      <?php if ($r['channel'] !== 'email'): ?>
        <p class="hint"><b>Kanal “<?= e($r['channel']) ?>” — atlanıyor.</b>
          Şu an yalnızca e-posta gönderilebilir. WhatsApp seçildiğinde bu kural kendiliğinden çalışmaya başlar.</p>
      <?php endif; ?>

      <form method="post">
        <input type="hidden" name="csrf" value="<?= csrf() ?>">
        <input type="hidden" name="action" value="uyari_rule_save">
        <input type="hidden" name="id" value="<?= (int) $r['id'] ?>">
        <div class="ctl"><span><b>Eşik</b><i><?= e($k['unit']) ?></i></span>
          <div class="ctl-act">
            <input type="number" name="threshold" min="1" max="365" value="<?= (int) $r['threshold'] ?>">
            <span class="muted">gün</span>
          </div></div>
        <div class="ctl"><span><b>Alıcı</b><i>boş bırakılırsa panelin tüm yöneticilerine gider</i></span>
          <div class="ctl-act">
            <input type="text" name="target" value="<?= e($r['target'] ?? '') ?>" placeholder="ornek@firma.com">
          </div></div>
        <div class="ctl"><span><b>Durum</b><i>kapalı kural değerlendirilmez</i></span>
          <div class="ctl-act">
            <label class="chk"><input type="checkbox" name="is_active" value="1"
                   <?= $r['is_active'] ? 'checked' : '' ?>> Açık</label>
            <button class="btn btn-sm">Kaydet</button>
          </div></div>
      </form>

      <p class="hint" style="margin:12px 0 0;padding-top:11px;border-top:1px solid var(--line-2)">
        <?php if (!$r['is_active']): ?>
          Kural kapalı olduğu için aday hesaplanmıyor.
        <?php else: ?>
          Şu an <b><?= count($cands) ?></b> işletme bu kurala giriyor;
          <b><?= $pending ?></b> tanesi için henüz uyarı gönderilmemiş.
          <?php if ($cands && $pending === 0): ?>
            Hepsi daha önce bildirildi — durum değişmedikçe tekrar gönderilmez.
          <?php endif; ?>
        <?php endif; ?>
      </p>
    </section>
  <?php endforeach; ?>

  <section class="card">
    <h3>Gönderilenler<span class="sp"></span>
      <span class="muted" style="font-size:12.5px">son <?= count($recent) ?> kayıt</span></h3>
    <p class="hint" style="margin-top:0"><b>Olay anahtarı</b>, aynı uyarının ikinci kez
      gönderilmesini engelleyen şeydir. Anahtar değişirse — lisans yenilenir, kasa geri döner
      ve yeniden susar, yedek gelir ve yeniden kesilir — aynı kural yeniden uyarır.</p>
    <div class="scroll-x"><table class="grid">
      <tr><th>Zaman</th><th>Kural</th><th>İşletme</th><th>Olay anahtarı</th></tr>
      <?php foreach ($recent as $s): ?>
        <tr><td class="muted nums"><?= e(panel_dt($s['sent_at'])) ?></td>
            <td><?= e($kinds[$s['kind']]['label'] ?? ($s['kind'] ?: '—')) ?></td>
            <td><?= $s['company_name']
                    ? '<a class="t-name" href="index.php?p=tenant&id=' . (int) $s['tenant_id'] . '">'
                      . e($s['company_name']) . '</a>'
                    : '<span class="muted">silinmiş işletme</span>' ?></td>
            <td class="muted mono"><?= e($s['subject_key']) ?></td></tr>
      <?php endforeach;
      if (!$recent) empty_row(4, 'Henüz uyarı gönderilmedi',
        'Cron kurulduktan sonra ilk uygun durumda buraya bir satır düşer. Boş olması, '
        . 'uyarılacak bir şey olmadığı anlamına da gelebilir.'); ?>
    </table></div>
  </section>
</div>

<aside class="rail">
  <section class="card">
    <h3>cPanel cron satırı</h3>
    <p class="hint" style="margin-top:0">cPanel &gt; <b>Cron Jobs</b> &gt; <i>Add New Cron Job</i>.
      Zamanlama <b>Once Per Hour</b>, komut olarak da aşağıdaki satır.</p>
    <div class="key"><?= e(uyari_cron_line()) ?></div>
    <p class="hint">Anahtar <b>başlıkta</b> gider, adreste değil. Adres satırına yazılan bir
      anahtar; tarayıcı geçmişine, sunucu erişim kayıtlarına ve cron listesinin kendisine
      düşer. Anahtarı adreste taşıyan çağrılar bu yüzden reddedilir.</p>
    <div class="ctl"><span><b>Anahtarı yenile</b>
        <i>eski anahtarla yapılan çağrılar hemen reddedilir</i></span>
      <form method="post" class="inline ctl-act">
        <input type="hidden" name="csrf" value="<?= csrf() ?>">
        <input type="hidden" name="action" value="uyari_secret">
        <button class="btn btn-sm btn-danger">Yenile</button>
      </form>
    </div>
    <p class="hint" style="margin:12px 0 0">Yenileyince cron satırını yeniden yapıştırmayı unutmayın;
      aksi hâlde uyarılar sessizce durur.</p>
  </section>

  <section class="card">
    <h3>Nasıl çalışır</h3>
    <table>
      <tr><td>Sıklık</td><td class="r">saatte bir</td></tr>
      <tr><td>Kanal</td><td class="r">yalnızca e-posta</td></tr>
      <tr><td>Gönderen</td><td class="r muted mono"><?= e((string) cfg('mail.from')) ?></td></tr>
      <tr><td>Tekrar</td><td class="r">aynı olay için bir kez</td></tr>
    </table>
    <p class="hint" style="margin:12px 0 0">Gerekenden sık çağrılması zararsızdır: kısa aralıkla
      gelen ikinci çağrı hiçbir şey yapmaz, ve yapsa bile aynı uyarı ikinci kez gönderilemez.</p>
  </section>

  <section class="card">
    <h3>Alıcılar</h3>
    <p class="hint" style="margin-top:0">Kuralda alıcı yazılmamışsa uyarılar bu adreslere gider.</p>
    <table>
      <?php foreach (all('SELECT name, email FROM np_admins WHERE is_active=1 ORDER BY id') as $a): ?>
        <tr><td><?= e($a['name']) ?></td><td class="r muted mono"><?= e($a['email']) ?></td></tr>
      <?php endforeach; ?>
    </table>
  </section>
</aside>
</div>
