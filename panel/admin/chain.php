<?php
/**
 * Head-office screens for a chain: branches, the master menu, the published
 * versions and the per-branch exceptions.
 *
 * These hang off the tenant page rather than the top navigation, and every one
 * of them except the branch list refuses to render until the tenant actually
 * has two branches. A customer with one shop is the overwhelming majority and
 * must not be shown a menu editor whose whole point is keeping ten shops in
 * step. The branch list is the single exception, because it is where the
 * second branch gets created.
 */
require_once __DIR__ . '/../lib/chain.php';

const CHAIN_PAGES = ['branches', 'menu', 'menuversions', 'exceptions'];

function chain_is_page(string $p): bool { return in_array($p, CHAIN_PAGES, true); }

/** Turn a name into a master code head office can read out loud. */
function chain_make_code(int $tenantId, string $table, string $name, string $prefix): string {
    $tr = ['ı'=>'i','İ'=>'I','ş'=>'s','Ş'=>'S','ğ'=>'g','Ğ'=>'G','ü'=>'u','Ü'=>'U','ö'=>'o','Ö'=>'O','ç'=>'c','Ç'=>'C'];
    $base = strtoupper(preg_replace('/[^A-Za-z0-9]+/', '_', strtr($name, $tr)));
    $base = trim(substr($base, 0, 40), '_');
    if ($base === '') $base = $prefix;
    $code = $base;
    $n = 1;
    while (val("SELECT id FROM {$table} WHERE tenant_id=? AND master_code=?", [$tenantId, $code])) {
        $code = $base . '_' . (++$n);
    }
    return $code;
}

/**
 * How far the live master menu has drifted from the last published version.
 * This is what the Yayınla box counts, so head office can see it has unsaved
 * intent before it presses the button, and can see there is nothing to publish
 * when there is nothing to publish.
 */
function chain_pending_changes(int $tenantId): array {
    $v = chain_current_version($tenantId);
    $prev = [];
    if ($v > 0) {
        foreach (all('SELECT entity, master_code, row_hash FROM np_menu_version_items
                       WHERE tenant_id=? AND version=?', [$tenantId, $v]) as $r) {
            $prev[$r['entity'] . "\0" . $r['master_code']] = $r['row_hash'];
        }
    }
    $changed = 0; $seen = [];
    foreach (all('SELECT * FROM np_menu_categories WHERE tenant_id=? AND is_active=1', [$tenantId]) as $r) {
        $k = "category\0" . $r['master_code']; $seen[$k] = true;
        if (($prev[$k] ?? null) !== sha1(chain_encode(chain_category_payload($r)))) $changed++;
    }
    foreach (all('SELECT p.*, c.master_code AS category_code FROM np_menu_products p
             LEFT JOIN np_menu_categories c ON c.id=p.category_id AND c.tenant_id=p.tenant_id
                  WHERE p.tenant_id=? AND p.is_active=1', [$tenantId]) as $r) {
        $k = "product\0" . $r['master_code']; $seen[$k] = true;
        if (($prev[$k] ?? null) !== sha1(chain_encode(chain_product_payload($r)))) $changed++;
    }
    $withdrawn = 0;
    foreach ($prev as $k => $_) if (!isset($seen[$k])) $withdrawn++;
    return ['version' => $v, 'changed' => $changed, 'withdrawn' => $withdrawn];
}

/* ===================== actions ===================== */
/**
 * Called from the panel's POST dispatcher after check_csrf(). Every branch
 * here redirects and exits, so falling through means "not one of ours".
 */
function chain_actions(string $a): void {
    $tid = (int) ($_POST['tenant_id'] ?? 0);
    if (!$tid || !in_array($a, ['branch_save','branch_toggle','device_branch','mcat_save','mcat_delete',
                                'mprod_save','mprod_delete','menu_publish','override_save','override_clear'], true)) {
        return;
    }
    /* The tenant is read from the POST, so prove it exists before anything
       below writes a row keyed on it. */
    if (!one('SELECT id FROM np_tenants WHERE id=?', [$tid])) { http_response_code(404); exit('İşletme bulunamadı'); }
    $me = admin_user()['email'] ?? 'system';
    $back = 'index.php?p=branches&id=' . $tid;

    if ($a === 'branch_save') {
        $id = (int) ($_POST['branch_id'] ?? 0);
        $code = strtoupper(trim($_POST['code'] ?? ''));
        $name = trim($_POST['name'] ?? '');
        if ($code === '' || $name === '') { $_SESSION['flash'] = 'Şube kodu ve adı zorunlu'; header('Location: ' . $back); exit; }
        $clash = one('SELECT id FROM np_branches WHERE tenant_id=? AND code=? AND id<>?', [$tid, $code, $id]);
        if ($clash) { $_SESSION['flash'] = 'Bu şube kodu zaten kullanılıyor: ' . $code; header('Location: ' . $back); exit; }
        if ($id) {
            q('UPDATE np_branches SET code=?, name=?, city=?, address=?, phone=?, is_active=? WHERE id=? AND tenant_id=?',
              [$code, $name, $_POST['city'] ?: null, $_POST['address'] ?: null, $_POST['phone'] ?: null,
               isset($_POST['is_active']) ? 1 : 0, $id, $tid]);
            audit('chain.branch_update', $code);
        } else {
            q('INSERT INTO np_branches (tenant_id, code, name, city, address, phone, is_active) VALUES (?,?,?,?,?,?,1)',
              [$tid, $code, $name, $_POST['city'] ?: null, $_POST['address'] ?: null, $_POST['phone'] ?: null]);
            audit('chain.branch_create', $code);
            $_SESSION['flash'] = 'Şube eklendi. Kasadaki kuruluma şube kodunu verin: ' . $code;
        }
        header('Location: ' . $back); exit;
    }

    if ($a === 'branch_toggle') {
        q('UPDATE np_branches SET is_active=? WHERE id=? AND tenant_id=?',
          [(int) $_POST['active'], (int) $_POST['branch_id'], $tid]);
        audit('chain.branch_toggle', 'branch#' . (int) $_POST['branch_id'], (int) $_POST['active']);
        header('Location: ' . $back); exit;
    }

    if ($a === 'device_branch') {
        /* Both sides are re-checked against the tenant: the device id and the
           branch id both arrive from the form and neither is trusted. */
        $bid = (int) ($_POST['branch_id'] ?? 0);
        if ($bid && !one('SELECT id FROM np_branches WHERE id=? AND tenant_id=?', [$bid, $tid])) $bid = 0;
        q('UPDATE np_devices SET branch_id=? WHERE id=? AND tenant_id=?',
          [$bid ?: null, (int) $_POST['device_id'], $tid]);
        audit('chain.device_bind', 'device#' . (int) $_POST['device_id'], $bid);
        header('Location: ' . $back); exit;
    }

    if ($a === 'mcat_save') {
        $id = (int) ($_POST['cat_id'] ?? 0);
        $name = trim($_POST['name'] ?? '');
        if ($name === '') { header('Location: index.php?p=menu&id=' . $tid); exit; }
        if ($id) {
            q('UPDATE np_menu_categories SET name=?, station_hint=?, sort_order=?, is_active=?, use_in_pos=?,
                 use_in_qr=?, price_locked=? WHERE id=? AND tenant_id=?',
              [$name, $_POST['station_hint'] ?: null, (int) $_POST['sort_order'], isset($_POST['is_active']) ? 1 : 0,
               isset($_POST['use_in_pos']) ? 1 : 0, isset($_POST['use_in_qr']) ? 1 : 0,
               isset($_POST['price_locked']) ? 1 : 0, $id, $tid]);
            audit('chain.category_update', $name);
        } else {
            q('INSERT INTO np_menu_categories (tenant_id, master_code, name, station_hint, sort_order,
                 is_active, use_in_pos, use_in_qr, price_locked) VALUES (?,?,?,?,?,1,?,?,?)',
              [$tid, chain_make_code($tid, 'np_menu_categories', $name, 'KAT'), $name,
               $_POST['station_hint'] ?: null, (int) $_POST['sort_order'],
               isset($_POST['use_in_pos']) ? 1 : 0, isset($_POST['use_in_qr']) ? 1 : 0,
               isset($_POST['price_locked']) ? 1 : 0]);
            audit('chain.category_create', $name);
        }
        header('Location: index.php?p=menu&id=' . $tid); exit;
    }

    if ($a === 'mcat_delete') {
        /* Deactivate, never delete: the published versions still reference this
           code, and a branch has to be told it was withdrawn rather than simply
           stop hearing about it. */
        q('UPDATE np_menu_categories SET is_active=0 WHERE id=? AND tenant_id=?', [(int) $_POST['cat_id'], $tid]);
        q('UPDATE np_menu_products SET is_active=0 WHERE category_id=? AND tenant_id=?', [(int) $_POST['cat_id'], $tid]);
        audit('chain.category_withdraw', 'cat#' . (int) $_POST['cat_id']);
        header('Location: index.php?p=menu&id=' . $tid); exit;
    }

    if ($a === 'mprod_save') {
        $id = (int) ($_POST['prod_id'] ?? 0);
        $name = trim($_POST['name'] ?? '');
        $cat = (int) ($_POST['category_id'] ?? 0);
        if ($cat && !one('SELECT id FROM np_menu_categories WHERE id=? AND tenant_id=?', [$cat, $tid])) $cat = 0;
        if ($name === '' || !$cat) { $_SESSION['flash'] = 'Ürün adı ve kategori zorunlu'; header('Location: index.php?p=menu&id=' . $tid); exit; }
        $price = (float) str_replace(',', '.', (string) $_POST['price']);
        $cost = $_POST['cost_price'] === '' ? null : (float) str_replace(',', '.', (string) $_POST['cost_price']);
        $args = [$cat, $name, $_POST['description'] ?: null, $price, $cost,
                 (float) str_replace(',', '.', (string) $_POST['vat_rate']),
                 isset($_POST['track_stock']) ? 1 : 0, isset($_POST['use_in_pos']) ? 1 : 0,
                 isset($_POST['use_in_qr']) ? 1 : 0, $_POST['image_url'] ?: null,
                 (int) $_POST['sort_order'], isset($_POST['is_active']) ? 1 : 0,
                 isset($_POST['price_locked']) ? 1 : 0];
        if ($id) {
            q('UPDATE np_menu_products SET category_id=?, name=?, description=?, price=?, cost_price=?, vat_rate=?,
                 track_stock=?, use_in_pos=?, use_in_qr=?, image_url=?, sort_order=?, is_active=?, price_locked=?
               WHERE id=? AND tenant_id=?', array_merge($args, [$id, $tid]));
            audit('chain.product_update', $name);
        } else {
            q('INSERT INTO np_menu_products (master_code, category_id, name, description, price, cost_price, vat_rate,
                 track_stock, use_in_pos, use_in_qr, image_url, sort_order, is_active, price_locked, tenant_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
              array_merge([chain_make_code($tid, 'np_menu_products', $name, 'URN')], $args, [$tid]));
            audit('chain.product_create', $name);
        }
        header('Location: index.php?p=menu&id=' . $tid); exit;
    }

    if ($a === 'mprod_delete') {
        q('UPDATE np_menu_products SET is_active=0 WHERE id=? AND tenant_id=?', [(int) $_POST['prod_id'], $tid]);
        audit('chain.product_withdraw', 'prod#' . (int) $_POST['prod_id']);
        header('Location: index.php?p=menu&id=' . $tid); exit;
    }

    if ($a === 'menu_publish') {
        $v = chain_publish($tid, (string) ($_POST['note'] ?? ''), $me);
        audit('chain.menu_publish', 'v' . $v, $_POST['note'] ?? '');
        $_SESSION['flash'] = 'Menü ' . $v . '. sürüm olarak yayınlandı. Şubeler bir sonraki bağlantılarında alacak.';
        header('Location: index.php?p=menuversions&id=' . $tid); exit;
    }

    if ($a === 'override_save') {
        $bid = (int) $_POST['branch_id'];
        $err = chain_save_override($tid, $bid, (string) $_POST['entity'], (string) $_POST['master_code'],
            $_POST['available'] === '' ? null : (int) $_POST['available'],
            isset($_POST['price']) ? (string) $_POST['price'] : null, $me);
        $_SESSION['flash'] = $err ?: 'İstisna kaydedildi.';
        if (!$err) audit('chain.override_save', $_POST['master_code'], ['branch' => $bid]);
        header('Location: index.php?p=exceptions&id=' . $tid . '&branch=' . $bid); exit;
    }

    if ($a === 'override_clear') {
        $bid = (int) $_POST['branch_id'];
        q('DELETE FROM np_branch_overrides WHERE id=? AND tenant_id=? AND branch_id=?',
          [(int) $_POST['override_id'], $tid, $bid]);
        audit('chain.override_clear', 'override#' . (int) $_POST['override_id']);
        header('Location: index.php?p=exceptions&id=' . $tid . '&branch=' . $bid); exit;
    }
}

/* ===================== pages ===================== */

/** The sub-navigation between the chain screens. Shown only once it is a chain. */
function chain_tabs(int $tid, string $active): void {
    if (!chain_enabled($tid)) return;
    $tabs = ['branches' => 'Şubeler', 'menu' => 'Ana menü', 'menuversions' => 'Sürümler',
             'exceptions' => 'Şube istisnaları', 'rapor' => 'Şube raporu'];
    echo '<div class="row">';
    foreach ($tabs as $k => $label) {
        echo '<a class="btn btn-sm' . ($k === $active ? '' : ' btn-ghost') . '" href="index.php?p=' . $k . '&id=' . $tid . '">' . e($label) . '</a>';
    }
    echo '</div>';
}

function chain_page(string $p): void {
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

    /* The gate. Everything but the branch list is invisible - and unreachable
       by typing the URL - until there is a second branch to keep in step. */
    if ($p !== 'branches' && !chain_enabled($tid)) {
        page_head($t['company_name'], ['eyebrow' => 'İşletme',
            'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=tenant&id=' . $tid . '">İşletme kartı</a>']);
        echo '<section class="card">';
        empty_state('Bu işletme tek şube olarak çalışıyor',
            'Ana menü, menü sürümleri ve şube istisnaları ekranları ikinci şube eklendiğinde açılır. '
          . 'Tek şubeli bir kurulumda hiçbir şey değişmez.',
            ['href' => 'index.php?p=branches&id=' . $tid, 'label' => 'Şubeler']);
        echo '</section>';
        return;
    }

    if ($p === 'branches')     { chain_page_branches($tid, $t); return; }
    if ($p === 'menu')         { chain_page_menu($tid, $t); return; }
    if ($p === 'menuversions') { chain_page_versions($tid, $t); return; }
    if ($p === 'exceptions')   { chain_page_exceptions($tid, $t); return; }
}

function chain_page_branches(int $tid, array $t): void {
    $edit = (int) ($_GET['branch'] ?? 0);
    $b = $edit ? one('SELECT * FROM np_branches WHERE id=? AND tenant_id=?', [$edit, $tid]) : null;
    $branches = all('SELECT b.*,
                            (SELECT COUNT(*) FROM np_devices d WHERE d.branch_id=b.id AND d.tenant_id=b.tenant_id) devices,
                            (SELECT MAX(d.last_seen_at) FROM np_devices d WHERE d.branch_id=b.id AND d.tenant_id=b.tenant_id) last_seen
                       FROM np_branches b WHERE b.tenant_id=? ORDER BY b.is_active DESC, b.code', [$tid]);
    $devices = all('SELECT * FROM np_devices WHERE tenant_id=? ORDER BY last_seen_at DESC', [$tid]);
    $current = chain_current_version($tid);
    ?>
    <?php page_head('Şubeler', ['eyebrow' => $t['company_name'],
        'sub' => 'Şube kodunu kasaya okuyun; kasa ilk menü çekişinde bu kodla şubeye bağlanır.',
        'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=tenant&id=' . $tid . '">İşletme kartı</a>']);
    chain_tabs($tid, 'branches'); ?>
    <?php if (count($branches) < 2): ?>
      <div class="flash">Bu işletme şu an tek şube. İkinci şubeyi eklediğinizde ana menü, sürüm yayınlama ve
        şube istisnaları ekranları açılır. Tek şubeli kurulumda hiçbir şey değişmez.</div>
    <?php endif; ?>
    <div class="cols">
      <form method="post" class="card">
        <input type="hidden" name="csrf" value="<?= csrf() ?>">
        <input type="hidden" name="action" value="branch_save">
        <input type="hidden" name="tenant_id" value="<?= $tid ?>">
        <input type="hidden" name="branch_id" value="<?= $edit ?>">
        <h3><?= $b ? 'Şubeyi düzenle' : 'Yeni şube' ?></h3>
        <div class="f2">
          <label>Kod<input name="code" required placeholder="MERKEZ" value="<?= e($b['code'] ?? '') ?>"></label>
          <label>Ad<input name="name" required value="<?= e($b['name'] ?? '') ?>"></label>
          <label>Şehir<input name="city" value="<?= e($b['city'] ?? '') ?>"></label>
          <label>Telefon<input name="phone" value="<?= e($b['phone'] ?? '') ?>"></label>
        </div>
        <label>Adres<input name="address" value="<?= e($b['address'] ?? '') ?>"></label>
        <label class="chk"><input type="checkbox" name="is_active" <?= ($b === null || $b['is_active']) ? 'checked' : '' ?>> Aktif</label>
        <button class="btn"><?= $b ? 'Kaydet' : 'Şube ekle' ?></button>
        <p class="muted">Kod kasaya okunur; kasa ilk menü çekişinde bu kodu göndererek şubeye bağlanır.</p>
      </form>

      <section class="card"><h3>Kasa bilgisayarlarının şubeleri</h3>
        <table>
        <?php foreach ($devices as $d):
          $seen = $d['last_seen_at'] && strtotime($d['last_seen_at']) > time() - 600; ?>
          <tr>
            <td><?= e($d['device_name'] ?: $d['device_id']) ?>
                <div class="muted"><?= $seen ? 'çevrimiçi' : e(substr((string) $d['last_seen_at'], 0, 16) ?: 'hiç görülmedi') ?></div></td>
            <td class="r"><form method="post" class="inline">
              <input type="hidden" name="csrf" value="<?= csrf() ?>">
              <input type="hidden" name="action" value="device_branch">
              <input type="hidden" name="tenant_id" value="<?= $tid ?>">
              <input type="hidden" name="device_id" value="<?= (int) $d['id'] ?>">
              <select name="branch_id" onchange="this.form.submit()">
                <option value="0">— şube yok —</option>
                <?php foreach ($branches as $bb): ?>
                  <option value="<?= (int) $bb['id'] ?>" <?= (int) $d['branch_id'] === (int) $bb['id'] ? 'selected' : '' ?>>
                    <?= e($bb['code'] . ' · ' . $bb['name']) ?></option>
                <?php endforeach; ?>
              </select></form></td>
          </tr>
        <?php endforeach; if (!$devices) echo '<tr><td class="muted">Henüz kurulum yapılmamış.</td></tr>'; ?>
        </table></section>
    </div>

    <table class="grid">
      <tr><th>Kod</th><th>Şube</th><th>Şehir</th><th>Kasa</th><th>Son görülme</th><th>Menü sürümü</th><th>Durum</th><th></th></tr>
      <?php foreach ($branches as $r):
        $behind = $current > 0 && (int) $r['menu_version'] < $current; ?>
        <tr>
          <td class="mono"><b><?= e($r['code']) ?></b></td>
          <td><a href="index.php?p=branches&id=<?= $tid ?>&branch=<?= (int) $r['id'] ?>"><?= e($r['name']) ?></a></td>
          <td><?= e($r['city']) ?></td>
          <td><?= (int) $r['devices'] ?></td>
          <td class="muted"><?= e(substr((string) $r['last_seen'], 0, 16) ?: '—') ?></td>
          <td><?= $r['menu_version'] ? 'v' . (int) $r['menu_version'] : '<span class="muted">—</span>' ?>
              <?= $behind ? '<span class="pill pill-trial">geride</span>' : '' ?>
              <div class="muted"><?= e(substr((string) $r['menu_applied_at'], 0, 16)) ?></div></td>
          <td><?= $r['is_active'] ? '<span class="pill pill-active">aktif</span>' : '<span class="pill pill-suspended">pasif</span>' ?></td>
          <td class="r"><form method="post">
            <input type="hidden" name="csrf" value="<?= csrf() ?>">
            <input type="hidden" name="action" value="branch_toggle">
            <input type="hidden" name="tenant_id" value="<?= $tid ?>">
            <input type="hidden" name="branch_id" value="<?= (int) $r['id'] ?>">
            <input type="hidden" name="active" value="<?= $r['is_active'] ? 0 : 1 ?>">
            <button class="btn btn-sm btn-ghost"><?= $r['is_active'] ? 'Pasife al' : 'Aktifleştir' ?></button></form></td>
        </tr>
      <?php endforeach; if (!$branches) echo '<tr><td colspan="8" class="muted">Henüz şube tanımlanmamış.</td></tr>'; ?>
    </table>
    <?php
}

function chain_page_menu(int $tid, array $t): void {
    $cats = all('SELECT * FROM np_menu_categories WHERE tenant_id=? ORDER BY is_active DESC, sort_order, name', [$tid]);
    $prods = all('SELECT p.*, c.name AS cat_name FROM np_menu_products p
             LEFT JOIN np_menu_categories c ON c.id=p.category_id AND c.tenant_id=p.tenant_id
                  WHERE p.tenant_id=? ORDER BY p.is_active DESC, c.sort_order, p.sort_order, p.name', [$tid]);
    $ec = (int) ($_GET['cat'] ?? 0);
    $ep = (int) ($_GET['prod'] ?? 0);
    $cat = $ec ? one('SELECT * FROM np_menu_categories WHERE id=? AND tenant_id=?', [$ec, $tid]) : null;
    $prod = $ep ? one('SELECT * FROM np_menu_products WHERE id=? AND tenant_id=?', [$ep, $tid]) : null;
    $pend = chain_pending_changes($tid);
    ?>
    <?php page_head('Ana menü', ['eyebrow' => $t['company_name'],
        'sub' => 'Buradaki düzenlemeler hiçbir şubeyi etkilemez. Şubeler yalnızca yayınlanmış bir sürümü çeker.',
        'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=tenant&id=' . $tid . '">İşletme kartı</a>']);
    chain_tabs($tid, 'menu'); ?>

    <div class="cols">
      <form method="post" class="card">
        <input type="hidden" name="csrf" value="<?= csrf() ?>">
        <input type="hidden" name="action" value="menu_publish">
        <input type="hidden" name="tenant_id" value="<?= $tid ?>">
        <h3>Yayınla</h3>
        <p class="muted">Buradaki düzenlemeler hiçbir şubeyi etkilemez. Şubeler yalnızca yayınlanmış bir sürümü çeker.</p>
        <p><b>Yayındaki sürüm:</b> <?= $pend['version'] ? 'v' . $pend['version'] : 'henüz yayın yok' ?><br>
          <?php if ($pend['changed'] || $pend['withdrawn']): ?>
            <span class="pill pill-trial"><?= (int) $pend['changed'] ?> değişiklik<?= $pend['withdrawn'] ? ', ' . (int) $pend['withdrawn'] . ' kaldırma' : '' ?> yayın bekliyor</span>
          <?php else: ?><span class="muted">Yayınlanacak değişiklik yok.</span><?php endif; ?></p>
        <label>Sürüm notu<input name="note" placeholder="Mart fiyat güncellemesi" maxlength="255"></label>
        <button class="btn">Yayınla</button>
      </form>

      <form method="post" class="card">
        <input type="hidden" name="csrf" value="<?= csrf() ?>">
        <input type="hidden" name="action" value="mcat_save">
        <input type="hidden" name="tenant_id" value="<?= $tid ?>">
        <input type="hidden" name="cat_id" value="<?= $ec ?>">
        <h3><?= $cat ? 'Kategori: ' . e($cat['name']) : 'Yeni kategori' ?></h3>
        <?php if ($cat): ?><p class="key"><?= e($cat['master_code']) ?></p><?php endif; ?>
        <div class="f2">
          <label>Ad<input name="name" required value="<?= e($cat['name'] ?? '') ?>"></label>
          <label>İstasyon<input name="station_hint" value="<?= e($cat['station_hint'] ?? '') ?>"></label>
          <label>Sıra<input name="sort_order" type="number" value="<?= (int) ($cat['sort_order'] ?? 0) ?>"></label>
        </div>
        <label class="chk"><input type="checkbox" name="use_in_pos" <?= ($cat === null || $cat['use_in_pos']) ? 'checked' : '' ?>> Kasada göster</label>
        <label class="chk"><input type="checkbox" name="use_in_qr" <?= ($cat === null || $cat['use_in_qr']) ? 'checked' : '' ?>> QR menüde göster</label>
        <label class="chk"><input type="checkbox" name="price_locked" <?= ($cat === null || $cat['price_locked']) ? 'checked' : '' ?>> Fiyat merkeze kilitli</label>
        <?php if ($cat): ?><label class="chk"><input type="checkbox" name="is_active" <?= $cat['is_active'] ? 'checked' : '' ?>> Aktif</label><?php endif; ?>
        <button class="btn">Kaydet</button>
      </form>

      <form method="post" class="card">
        <input type="hidden" name="csrf" value="<?= csrf() ?>">
        <input type="hidden" name="action" value="mprod_save">
        <input type="hidden" name="tenant_id" value="<?= $tid ?>">
        <input type="hidden" name="prod_id" value="<?= $ep ?>">
        <h3><?= $prod ? 'Ürün: ' . e($prod['name']) : 'Yeni ürün' ?></h3>
        <?php if ($prod): ?><p class="key"><?= e($prod['master_code']) ?></p><?php endif; ?>
        <label>Kategori<select name="category_id" required>
          <?php foreach ($cats as $c): if (!$c['is_active'] && (int) ($prod['category_id'] ?? 0) !== (int) $c['id']) continue; ?>
            <option value="<?= (int) $c['id'] ?>" <?= (int) ($prod['category_id'] ?? 0) === (int) $c['id'] ? 'selected' : '' ?>><?= e($c['name']) ?></option>
          <?php endforeach; ?></select></label>
        <div class="f2">
          <label>Ad<input name="name" required value="<?= e($prod['name'] ?? '') ?>"></label>
          <label>Fiyat<input name="price" value="<?= e($prod['price'] ?? '0.00') ?>"></label>
          <label>Maliyet<input name="cost_price" value="<?= e($prod['cost_price'] ?? '') ?>"></label>
          <label>KDV %<input name="vat_rate" value="<?= e($prod['vat_rate'] ?? '10.00') ?>"></label>
          <label>Sıra<input name="sort_order" type="number" value="<?= (int) ($prod['sort_order'] ?? 0) ?>"></label>
          <label>Görsel<input name="image_url" value="<?= e($prod['image_url'] ?? '') ?>"></label>
        </div>
        <label>Açıklama<input name="description" value="<?= e($prod['description'] ?? '') ?>"></label>
        <label class="chk"><input type="checkbox" name="use_in_pos" <?= ($prod === null || $prod['use_in_pos']) ? 'checked' : '' ?>> Kasada göster</label>
        <label class="chk"><input type="checkbox" name="use_in_qr" <?= ($prod === null || $prod['use_in_qr']) ? 'checked' : '' ?>> QR menüde göster</label>
        <label class="chk"><input type="checkbox" name="track_stock" <?= ($prod && $prod['track_stock']) ? 'checked' : '' ?>> Stok takibi</label>
        <label class="chk"><input type="checkbox" name="price_locked" <?= ($prod === null || $prod['price_locked']) ? 'checked' : '' ?>> Fiyat merkeze kilitli</label>
        <label class="chk"><input type="checkbox" name="is_active" <?= ($prod === null || $prod['is_active']) ? 'checked' : '' ?>> Aktif</label>
        <button class="btn">Kaydet</button>
        <p class="muted">Kilit açıkken şube kendi fiyatını verebilir ve panelde “farklı” olarak görünür.</p>
      </form>
    </div>

    <h3>Kategoriler</h3>
    <table class="grid">
      <tr><th>Kod</th><th>Ad</th><th>İstasyon</th><th>Sıra</th><th>Fiyat kilidi</th><th>Durum</th><th></th></tr>
      <?php foreach ($cats as $c): ?>
        <tr>
          <td class="mono"><?= e($c['master_code']) ?></td>
          <td><a href="index.php?p=menu&id=<?= $tid ?>&cat=<?= (int) $c['id'] ?>"><b><?= e($c['name']) ?></b></a></td>
          <td class="muted"><?= e($c['station_hint']) ?></td>
          <td><?= (int) $c['sort_order'] ?></td>
          <td><?= $c['price_locked'] ? 'kilitli' : '<span class="pill pill-trial">açık</span>' ?></td>
          <td><?= $c['is_active'] ? '<span class="pill pill-active">aktif</span>' : '<span class="pill pill-suspended">kaldırıldı</span>' ?></td>
          <td class="r"><?php if ($c['is_active']): ?><form method="post">
            <input type="hidden" name="csrf" value="<?= csrf() ?>">
            <input type="hidden" name="action" value="mcat_delete">
            <input type="hidden" name="tenant_id" value="<?= $tid ?>">
            <input type="hidden" name="cat_id" value="<?= (int) $c['id'] ?>">
            <button class="btn btn-sm btn-ghost">Kaldır</button></form><?php endif; ?></td>
        </tr>
      <?php endforeach; if (!$cats) echo '<tr><td colspan="7" class="muted">Kategori yok.</td></tr>'; ?>
    </table>

    <h3>Ürünler</h3>
    <table class="grid">
      <tr><th>Kod</th><th>Ürün</th><th>Kategori</th><th class="r">Fiyat</th><th class="r">KDV</th><th>Fiyat kilidi</th><th>Durum</th><th></th></tr>
      <?php foreach ($prods as $r): ?>
        <tr>
          <td class="mono"><?= e($r['master_code']) ?></td>
          <td><a href="index.php?p=menu&id=<?= $tid ?>&prod=<?= (int) $r['id'] ?>"><b><?= e($r['name']) ?></b></a></td>
          <td class="muted"><?= e($r['cat_name']) ?></td>
          <td class="r"><?= money($r['price']) ?> ₺</td>
          <td class="r muted">%<?= (int) $r['vat_rate'] ?></td>
          <td><?= $r['price_locked'] ? 'kilitli' : '<span class="pill pill-trial">açık</span>' ?></td>
          <td><?= $r['is_active'] ? '<span class="pill pill-active">aktif</span>' : '<span class="pill pill-suspended">kaldırıldı</span>' ?></td>
          <td class="r"><?php if ($r['is_active']): ?><form method="post">
            <input type="hidden" name="csrf" value="<?= csrf() ?>">
            <input type="hidden" name="action" value="mprod_delete">
            <input type="hidden" name="tenant_id" value="<?= $tid ?>">
            <input type="hidden" name="prod_id" value="<?= (int) $r['id'] ?>">
            <button class="btn btn-sm btn-ghost">Kaldır</button></form><?php endif; ?></td>
        </tr>
      <?php endforeach; if (!$prods) echo '<tr><td colspan="8" class="muted">Ürün yok.</td></tr>'; ?>
    </table>
    <?php
}

function chain_page_versions(int $tid, array $t): void {
    $vers = all('SELECT * FROM np_menu_versions WHERE tenant_id=? ORDER BY version DESC LIMIT 100', [$tid]);
    $branches = all('SELECT * FROM np_branches WHERE tenant_id=? ORDER BY code', [$tid]);
    $current = chain_current_version($tid);
    ?>
    <?php page_head('Menü sürümleri', ['eyebrow' => $t['company_name'],
        'sub' => 'Yayınlanan her sürüm dondurulur; şubeler bir sonraki bağlantılarında yalnızca değişeni çeker.',
        'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=tenant&id=' . $tid . '">İşletme kartı</a>']);
    chain_tabs($tid, 'menuversions'); ?>
    <div class="cols">
      <section class="card"><h3>Şubeler hangi sürümde</h3><table>
        <?php foreach ($branches as $b):
          $behind = $current > 0 && (int) $b['menu_version'] < $current; ?>
          <tr><td><b><?= e($b['code']) ?></b> <span class="muted"><?= e($b['name']) ?></span></td>
              <td class="r"><?= $b['menu_version'] ? 'v' . (int) $b['menu_version'] : '<span class="muted">hiç almadı</span>' ?>
                  <?= $behind ? ' <span class="pill pill-trial">geride</span>' : '' ?></td>
              <td class="r muted"><?= e(substr((string) $b['menu_applied_at'], 0, 16)) ?></td></tr>
        <?php endforeach; if (!$branches) echo '<tr><td class="muted">Şube yok.</td></tr>'; ?>
      </table></section>
      <section class="card"><h3>Nasıl çalışır</h3>
        <p class="muted">Ana menüdeki düzenlemeler hiçbir şubeye gitmez. <b>Yayınla</b> dendiğinde o anki menü
          bir sürüm olarak dondurulur; şubeler bir sonraki bağlantılarında yalnızca değişen satırları çeker,
          uygular ve hangi sürümde olduklarını geri bildirir. Kasa kapalıysa açıldığında kaldığı yerden devam eder.</p>
      </section>
    </div>
    <table class="grid">
      <tr><th>Sürüm</th><th>Not</th><th>Yayınlayan</th><th>Tarih</th><th class="r">Kategori</th><th class="r">Ürün</th><th>Şubeler</th></tr>
      <?php foreach ($vers as $v):
        $on = [];
        foreach ($branches as $b) if ((int) $b['menu_version'] === (int) $v['version']) $on[] = $b['code']; ?>
        <tr>
          <td><b>v<?= (int) $v['version'] ?></b> <?= (int) $v['version'] === $current ? '<span class="pill pill-active">yayında</span>' : '' ?></td>
          <td><?= e($v['note']) ?></td>
          <td class="muted"><?= e($v['published_by']) ?></td>
          <td class="muted"><?= e(substr((string) $v['published_at'], 0, 16)) ?></td>
          <td class="r"><?= (int) $v['category_count'] ?></td>
          <td class="r"><?= (int) $v['product_count'] ?></td>
          <td class="muted mono"><?= e(implode(', ', $on)) ?></td>
        </tr>
      <?php endforeach; if (!$vers) echo '<tr><td colspan="7" class="muted">Henüz yayınlanmış sürüm yok.</td></tr>'; ?>
    </table>
    <?php
}

function chain_page_exceptions(int $tid, array $t): void {
    $branches = all('SELECT * FROM np_branches WHERE tenant_id=? ORDER BY code', [$tid]);
    $sel = (int) ($_GET['branch'] ?? 0);
    if (!$sel && $branches) $sel = (int) $branches[0]['id'];
    $branch = $sel ? one('SELECT * FROM np_branches WHERE id=? AND tenant_id=?', [$sel, $tid]) : null;

    /* Everything that has drifted, across every branch, with both numbers next
       to each other. That side-by-side is the whole point of the screen: an
       exception you cannot see afterwards is indistinguishable from a mistake. */
    $drift = all("SELECT o.*, b.code AS branch_code, b.name AS branch_name,
                         p.name AS product_name, p.price AS master_price, p.price_locked,
                         c.name AS category_name
                    FROM np_branch_overrides o
                    JOIN np_branches b ON b.id=o.branch_id AND b.tenant_id=o.tenant_id
               LEFT JOIN np_menu_products p ON p.tenant_id=o.tenant_id AND p.master_code=o.master_code AND o.entity='product'
               LEFT JOIN np_menu_categories c ON c.tenant_id=o.tenant_id AND c.master_code=o.master_code AND o.entity='category'
                   WHERE o.tenant_id=?
                ORDER BY b.code, o.entity, o.master_code", [$tid]);
    $mine = array_values(array_filter($drift, fn($r) => (int) $r['branch_id'] === $sel));
    $prods = all('SELECT master_code, name, price, price_locked FROM np_menu_products
                   WHERE tenant_id=? AND is_active=1 ORDER BY name', [$tid]);
    $cats = all('SELECT master_code, name, price_locked FROM np_menu_categories
                  WHERE tenant_id=? AND is_active=1 ORDER BY name', [$tid]);
    ?>
    <?php page_head('Şube istisnaları', ['eyebrow' => $t['company_name'],
        'sub' => 'Varsayılan duruş merkezîdir. Bir şubeye verilen her istisna burada görünür kalır.',
        'actions' => '<a class="btn btn-ghost btn-sm" href="index.php?p=tenant&id=' . $tid . '">İşletme kartı</a>']);
    chain_tabs($tid, 'exceptions'); ?>
    <div class="row">
      <?php foreach ($branches as $b): ?>
        <a class="btn btn-sm<?= (int) $b['id'] === $sel ? '' : ' btn-ghost' ?>"
           href="index.php?p=exceptions&id=<?= $tid ?>&branch=<?= (int) $b['id'] ?>"><?= e($b['code']) ?></a>
      <?php endforeach; ?>
    </div>

    <?php if ($branch): ?>
    <div class="cols">
      <form method="post" class="card">
        <input type="hidden" name="csrf" value="<?= csrf() ?>">
        <input type="hidden" name="action" value="override_save">
        <input type="hidden" name="tenant_id" value="<?= $tid ?>">
        <input type="hidden" name="branch_id" value="<?= $sel ?>">
        <h3><?= e($branch['name']) ?> için istisna</h3>
        <label>Tür<select name="entity"><option value="product">Ürün</option><option value="category">Kategori</option></select></label>
        <label>Kod<select name="master_code">
          <optgroup label="Ürünler">
            <?php foreach ($prods as $r): ?>
              <option value="<?= e($r['master_code']) ?>"><?= e($r['name']) ?> — <?= money($r['price']) ?> ₺<?= $r['price_locked'] ? ' (kilitli)' : '' ?></option>
            <?php endforeach; ?>
          </optgroup>
          <optgroup label="Kategoriler">
            <?php foreach ($cats as $r): ?>
              <option value="<?= e($r['master_code']) ?>"><?= e($r['name']) ?><?= $r['price_locked'] ? ' (kilitli)' : '' ?></option>
            <?php endforeach; ?>
          </optgroup></select></label>
        <div class="f2">
          <label>Satışta<select name="available">
            <option value="">değiştirme</option>
            <option value="0">bu şubede satılmıyor</option>
            <option value="1">satılıyor</option>
          </select></label>
          <label>Şube fiyatı<input name="price" placeholder="boş = merkez fiyatı"></label>
        </div>
        <button class="btn">İstisnayı kaydet</button>
        <p class="muted">Fiyat yalnızca ana menüde kilidi açılmış satırlarda verilebilir.</p>
      </form>

      <section class="card"><h3><?= e($branch['code']) ?> istisnaları</h3><table>
        <?php foreach ($mine as $r): ?>
          <tr>
            <td><?= e($r['product_name'] ?: $r['category_name'] ?: $r['master_code']) ?>
                <div class="muted mono"><?= e($r['master_code']) ?></div></td>
            <td class="r">
              <?= $r['available'] === null ? '' : ((int) $r['available'] === 0 ? '<span class="pill pill-suspended">satılmıyor</span>' : '<span class="pill pill-active">satılıyor</span>') ?>
              <?php if ($r['price'] !== null): ?>
                <div><?= money($r['price']) ?> ₺ <span class="muted">(merkez <?= money($r['master_price']) ?> ₺)</span></div>
                <?php if ($r['price_locked']): ?><div class="muted">kilit yeniden kapatıldı — kasaya gitmiyor</div><?php endif; ?>
              <?php endif; ?>
            </td>
            <td class="r"><form method="post">
              <input type="hidden" name="csrf" value="<?= csrf() ?>">
              <input type="hidden" name="action" value="override_clear">
              <input type="hidden" name="tenant_id" value="<?= $tid ?>">
              <input type="hidden" name="branch_id" value="<?= $sel ?>">
              <input type="hidden" name="override_id" value="<?= (int) $r['id'] ?>">
              <button class="btn btn-sm btn-ghost">Kaldır</button></form></td>
          </tr>
        <?php endforeach; if (!$mine) echo '<tr><td class="muted">Bu şube tamamen merkez menüsünü kullanıyor.</td></tr>'; ?>
      </table></section>
    </div>
    <?php endif; ?>

    <h3>Merkezden ayrışan şubeler</h3>
    <table class="grid">
      <tr><th>Şube</th><th>Kayıt</th><th>Tür</th><th class="r">Merkez fiyatı</th><th class="r">Şube fiyatı</th><th>Satışta</th><th>Değiştiren</th></tr>
      <?php foreach ($drift as $r): ?>
        <tr>
          <td><b><?= e($r['branch_code']) ?></b> <span class="muted"><?= e($r['branch_name']) ?></span></td>
          <td><?= e($r['product_name'] ?: $r['category_name'] ?: $r['master_code']) ?>
              <div class="muted mono"><?= e($r['master_code']) ?></div></td>
          <td class="muted"><?= $r['entity'] === 'product' ? 'ürün' : 'kategori' ?></td>
          <td class="r"><?= $r['master_price'] !== null ? money($r['master_price']) . ' ₺' : '—' ?></td>
          <td class="r"><?= $r['price'] !== null ? '<b>' . money($r['price']) . ' ₺</b>' : '<span class="muted">merkez</span>' ?></td>
          <td><?= $r['available'] === null ? '<span class="muted">merkez</span>' : ((int) $r['available'] === 0 ? '<span class="pill pill-suspended">kapalı</span>' : '<span class="pill pill-active">açık</span>') ?></td>
          <td class="muted"><?= e($r['updated_by']) ?><div class="muted"><?= e(substr((string) $r['updated_at'], 0, 16)) ?></div></td>
        </tr>
      <?php endforeach; if (!$drift) echo '<tr><td colspan="7" class="muted">Hiçbir şube merkez menüsünden ayrışmıyor.</td></tr>'; ?>
    </table>
    <?php
}
