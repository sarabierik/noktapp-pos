<?php
/**
 * Update distribution - what is published, which build is current, whether the
 * installer is actually on disk, and who has taken it.
 *
 * Included from index.php inside the page dispatch.
 *
 * The check that matters most here is the least obvious one: a published row
 * whose installer was never uploaded. latest.yml goes on advertising that
 * build, every till that tries to update fails, and nothing anywhere says why.
 * So the file is stat'ed and the size compared against the record.
 */

$rows = all('SELECT * FROM np_versions ORDER BY released_at DESC');
$cur  = panel_current_version();
$adoption = panel_try('panel_version_adoption', ['current' => null, 'total' => 0, 'rows' => []]);
$outdated = panel_try('panel_list_outdated', []);
$uptodate = (int) panel_try('panel_count_up_to_date', 0);

/* Installer parts sitting in indir/ that no np_versions row mentions - a file
   uploaded and then forgotten is invisible otherwise. */
$dir = rtrim((string) cfg('release_dir'), '/');
$known = [];
foreach ($rows as $r) $known[$r['filename']] = true;
$orphans = [];
foreach (@scandir($dir) ?: [] as $f) {
    if ($f[0] === '.' || $f === 'latest.yml.php' || isset($known[$f])) continue;
    if (is_file($dir . '/' . $f)) $orphans[] = ['name' => $f, 'size' => filesize($dir . '/' . $f)];
}

/*
 * An old build whose installer has been rotated out of indir/ is housekeeping,
 * not a fault - you do not keep every past installer for ever. The alarm is
 * for the CURRENT one: if that file is gone, latest.yml advertises a download
 * that 404s and every till in the field fails to update, silently.
 *
 * The first version of this page counted them all together, so publishing
 * 3.5.1 over 3.5.0 lit a red banner saying tills could not update at the exact
 * moment they could. A banner that cries about normal housekeeping is a banner
 * people learn to scroll past, and then it is worth nothing on the day it is
 * telling the truth.
 */
$stale = 0;
$curBroken = null;
foreach ($rows as $r) {
    $fi = panel_release_file($r);
    if ($fi['present']) continue;
    if ($r['is_current']) $curBroken = $r; else $stale++;
}

page_head('Sürümler', [
    'eyebrow' => 'Güncelleme dağıtımı',
    'sub' => ($cur ? 'Yayındaki sürüm v' . $cur['version'] : 'Henüz güncel sürüm işaretlenmemiş')
             . ' · ' . count($rows) . ' kayıtlı sürüm · ' . (int)$adoption['total'] . ' kasa',
    'actions' => '<a class="btn btn-ghost btn-sm" href="../indir/latest.yml" target="_blank">latest.yml</a>',
]);

if ($curBroken): ?>
  <div class="flash bad"><b>Güncel sürümün (v<?= e($curBroken['version']) ?>) kurulum dosyası
    <code>indir/</code> klasöründe yok.</b>
    <code><?= e($curBroken['filename']) ?></code> yüklenene kadar hiçbir kasa güncelleme alamaz.
    Dosyayı yükleyin ya da dosyası duran bir sürümü "Güncel yap" ile öne alın.</div>
<?php endif; ?>
<?php if ($stale): ?>
  <div class="flash"><?= $stale ?> eski sürümün kurulum dosyası artık <code>indir/</code> klasöründe
    değil. Bu normaldir — yeni sürüm yayınlandığında eskisinin dosyası genellikle silinir.
    Kayıtları listeden <b>Sil</b> ile temizleyebilirsiniz.</div>
<?php endif; ?>

<div class="cols-2">
  <!-- -------- adoption: who has taken it -------- -->
  <section class="card">
    <h3>Kim hangi sürümde</h3>
    <?php if (!$adoption['rows']): ?>
      <?php empty_state('Hiçbir kasa sürüm bildirmedi',
          'Kasalar her yarım saatte bir sürümlerini bildirir. Kurulum yapıldıktan sonra dağılım burada görünür.'); ?>
    <?php else: ?>
      <p class="hint" style="margin-top:-4px"><?= $uptodate ?> işletmenin bütün kasaları güncel,
        <a href="index.php?p=liste&k=outdated"><?= count($outdated) ?> işletme</a> geride.</p>
      <table>
        <?php foreach ($adoption['rows'] as $r): ?>
          <tr>
            <td style="width:34%"><b><?= $r['unknown'] ? 'bildirmedi' : 'v' . e($r['v']) ?></b>
              <?php if ($r['current']) echo ' <span class="pill pill-active">güncel</span>';
                    elseif ($r['behind']) echo ' <span class="pill pill-trial">eski</span>';
                    elseif ($r['ahead']) echo ' <span class="pill">ileri</span>'; ?>
              <div class="t-sub"><?= (int)$r['tenants'] ?> işletme</div></td>
            <td><?php meter($r['share'], (int)$r['devices'] . ' kasa · %' . number_format($r['share'] * 100, 0),
                            !$r['current']); ?></td>
          </tr>
        <?php endforeach; ?>
      </table>
    <?php endif; ?>
  </section>

  <!-- -------- publish -------- -->
  <form method="post" class="card">
    <input type="hidden" name="csrf" value="<?= csrf() ?>">
    <input type="hidden" name="action" value="version_save">
    <h3>Yeni sürüm yayınla</h3>
    <p class="hint" style="margin-top:0">Önce kurulum dosyasını <code>indir/</code> klasörüne yükleyin,
      sonra burada kaydedin. <code>latest.yml</code> kendiliğinden üretilir; kasalar onu okur.</p>
    <div class="f2">
      <label>Sürüm<input name="version" placeholder="2.0.1" required></label>
      <label>Kanal<input name="channel" value="stable"></label>
    </div>
    <label>Dosya adı<input name="filename" placeholder="NoktAppPOS-Setup-2.0.1.exe" required
      list="indir-files"></label>
    <datalist id="indir-files">
      <?php foreach ($orphans as $o): ?><option value="<?= e($o['name']) ?>"></option><?php endforeach; ?>
    </datalist>
    <div class="f2">
      <label>Boyut (byte)<input name="size_bytes" type="number" placeholder="boş = dosyadan okunur"></label>
      <label>sha512<input name="sha512" placeholder="boş = dosyadan hesaplanır"></label>
    </div>
    <label>Sürüm notları<textarea name="release_notes" placeholder="Bu sürümde ne değişti?"></textarea></label>
    <label class="chk"><input type="checkbox" name="is_current" checked> Güncel sürüm olarak yayınla</label>
    <button class="btn">Yayınla</button>
  </form>
</div>

<?php if ($orphans): ?>
  <div class="sec-head"><h3>Klasörde olup kaydı olmayan dosyalar</h3>
    <span class="sub">indir/ içinde duruyor ama hiçbir sürüme bağlı değil</span></div>
  <div class="scroll-x"><table class="grid">
    <tr><th>Dosya</th><th class="r">Boyut</th><th></th></tr>
    <?php foreach ($orphans as $o): ?>
      <tr><td class="mono"><?= e($o['name']) ?></td>
          <td class="r nums"><?= panel_mb((int)$o['size']) ?></td>
          <td class="muted">yukarıdaki formda dosya adı olarak seçilebilir</td></tr>
    <?php endforeach; ?>
  </table></div>
<?php endif; ?>

<div class="sec-head"><h3>Yayınlanmış sürümler</h3>
  <span class="sub">kurulum dosyası, dağıtım durumu ve kaç kasada olduğu</span></div>
<div class="scroll-x"><table class="grid">
  <tr><th>Sürüm</th><th>Kanal</th><th>Kurulum dosyası</th><th class="r">Boyut</th>
      <th class="r">Kasa</th><th class="r">Yayın</th><th class="r">İşlem</th></tr>
  <?php
  $byVersion = [];
  foreach ($adoption['rows'] as $ar) $byVersion[$ar['v']] = $ar;
  foreach ($rows as $r):
    $fi = panel_release_file($r);
    $a = $byVersion[$r['version']] ?? null; ?>
    <tr>
      <td><b>v<?= e($r['version']) ?></b>
          <?= $r['is_current'] ? ' <span class="pill pill-active">güncel</span>' : '' ?>
          <?php if ($r['release_notes']): ?>
            <div class="t-sub"><?= e(mb_substr((string)$r['release_notes'], 0, 70)) ?></div>
          <?php endif; ?></td>
      <td><?= e($r['channel']) ?></td>
      <td class="mono"><?= e($r['filename']) ?>
          <?php if (!$fi['present']): ?>
            <div><span class="pill pill-suspended">dosya yok</span></div>
          <?php elseif ($fi['mismatch']): ?>
            <div><span class="pill pill-trial">boyut tutmuyor</span>
              <span class="t-sub">diskte <?= panel_mb($fi['size']) ?></span></div>
          <?php endif; ?></td>
      <td class="r nums"><?= panel_mb((int)($r['size_bytes'] ?: $fi['size'])) ?></td>
      <td class="r"><?= $a ? (int)$a['devices'] : '<span class="muted">0</span>' ?></td>
      <td class="r muted nums"><?= panel_dt($r['released_at'], 'd.m.Y') ?></td>
      <td class="r"><?php if (!$r['is_current']): ?>
        <?php /* Making a record current whose installer is not on disk breaks
                 every till's update the moment it is pressed, so the button is
                 not offered - it says why instead. */ ?>
        <?php if ($fi['present']): ?>
          <form method="post" class="inline">
            <input type="hidden" name="csrf" value="<?= csrf() ?>">
            <input type="hidden" name="action" value="version_current">
            <input type="hidden" name="version_id" value="<?= (int)$r['id'] ?>">
            <button class="btn btn-sm btn-ghost">Güncel yap</button></form>
        <?php else: ?>
          <span class="muted" style="font-size:12px">dosya yüklenmeden güncel yapılamaz</span>
        <?php endif; ?>
        <form method="post" class="inline" onsubmit="return confirm('v<?= e($r['version']) ?> kaydı silinsin mi? Kurulum dosyası silinmez.')">
          <input type="hidden" name="csrf" value="<?= csrf() ?>">
          <input type="hidden" name="action" value="version_delete">
          <input type="hidden" name="version_id" value="<?= (int)$r['id'] ?>">
          <button class="btn btn-sm btn-ghost">Sil</button></form>
      <?php endif; ?></td>
    </tr>
  <?php endforeach;
  if (!$rows) empty_row(7, 'Henüz sürüm yayınlanmamış',
      'Kurulum dosyasını indir/ klasörüne yükleyin, sonra yukarıdaki formla kaydedin. Kasalar güncellemeyi latest.yml üzerinden alır.'); ?>
</table></div>
