<?php

/*
 * Cache-bust the stylesheet.
 *
 * A browser holding the previous release's panel.css is the worst kind of
 * "broken": the cards still look right because those classes existed before,
 * while anything NEW - the sidebar, in this release - renders as a bare bullet
 * list. It reads as a botched upload and it is not one. The file's own
 * modification time is appended, so a changed stylesheet is a changed URL and
 * the browser has no cached copy of it to reach for.
 */
if (!function_exists('np_css')) {
    function np_css(string $rel = '../assets/panel.css'): string {
        $path = __DIR__ . '/' . $rel;
        $v = @filemtime($path) ?: 1;
        return $rel . '?v=' . $v;
    }
}
/**
 * The shell every panel screen renders inside, plus the three components that
 * make the screens look like one product: the page header, the empty state
 * and the meter.
 *
 * They live here rather than in each page because the thing that made the old
 * panel read as scaffolding was that every screen invented its own heading.
 */
require_once __DIR__ . '/../lib/panel.php';
require_once __DIR__ . '/nav.php';

/**
 * Which sidebar entry a given ?p= marks.
 *
 * Kept under its old name because it was the panel's one public answer to
 * "where am I", and it now defers to nav.php so there is a single list of
 * screens rather than two that drift apart.
 */
function layout_section(string $p): string {
    $k = nav_active_key($p);
    return $k !== '' ? $k : $p;
}

/**
 * The shell.
 *
 * A left sidebar, fixed and full height: brand, then search, then the groups,
 * with the signed-in administrator pinned at the bottom. The flat row of text
 * links this replaced could not show hierarchy at all - every screen sat at
 * the same level, so the panel read as a list of scripts rather than a
 * product with parts.
 *
 * Under 1000px the sidebar becomes an off-canvas drawer behind a hamburger.
 * The drawer is a CHECKBOX, not JavaScript: the menu is the one control that
 * must work on a phone in a customer's shop with a bad connection, and a
 * stylesheet cannot fail to load halfway. The checkbox itself is the hit
 * target - transparent, sitting exactly over the drawn bars - so it is
 * focusable and toggles on Space like any other checkbox.
 */
function layout_head(string $title): void {
    $u = admin_user();
    $p = (string) ($_GET['p'] ?? 'home');
    /* guncelle.php is its own door with no ?p=, so it names itself. */
    if (basename((string) ($_SERVER['SCRIPT_NAME'] ?? '')) === 'guncelle.php') $p = 'guncelle';
    $active = nav_active_key($p);
    $openGroup = nav_active_group($p);
    ?><!doctype html>
<html lang="tr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title><?= e($title) ?> · NOKTApp POS Panel</title>
<link rel="stylesheet" href="<?= np_css() ?>">
</head><body>
<input type="checkbox" id="np-nav" class="nav-toggle" aria-label="Menüyü aç veya kapat">
<header class="topbar">
  <span class="burger" aria-hidden="true"><i></i><i></i><i></i></span>
  <div class="brand"><span class="mark"></span> NOKTApp POS <em>panel</em></div>
</header>
<label class="nav-scrim" for="np-nav" aria-hidden="true"></label>

<aside class="side" id="np-side">
  <a class="side-brand" href="index.php?p=home">
    <span class="mark"></span><span>NOKTApp POS <em>panel</em></span>
  </a>

  <?php /*
     Search POSTs, it does not GET.

     One of the fields it searches is the licence key, and a licence key is a
     credential. A GET would write it into the address bar, the browser
     history and every proxy and access log between here and the server. The
     cost is that a result page cannot be bookmarked, which is the right trade
     for a screen whose whole job is to be typed into and moved on from.
  */ ?>
  <form class="side-search" method="post" action="index.php?p=ara">
    <input type="hidden" name="csrf" value="<?= csrf() ?>">
    <input name="q" type="search" placeholder="İşletme, e-posta, lisans, kasa…"
           value="<?= e($_POST['q'] ?? '') ?>" aria-label="İşletme ara">
  </form>

  <nav class="side-nav" aria-label="Panel bölümleri">
    <?php foreach (panel_nav() as $g):
        $on = ($g['key'] === $openGroup); ?>
      <div class="nav-group<?= $on ? ' on' : '' ?>">
        <?php if ($g['title'] !== ''): ?>
          <?php /* A heading, not a control: it names the group and nothing
                   happens if you press it. Making it clickable would promise a
                   section landing page that does not exist. */ ?>
          <div class="nav-h"><?= e(mb_strtoupper($g['title'], 'UTF-8')) ?></div>
        <?php endif; ?>
        <ul>
          <?php foreach ($g['items'] as $it):
              $cur = ($it['p'] === $active); ?>
            <li><a href="<?= e(nav_href($it)) ?>" class="<?= $cur ? 'on' : '' ?>"
                   <?= $cur ? 'aria-current="page"' : '' ?>><?= e($it['label']) ?></a></li>
          <?php endforeach; ?>
        </ul>
      </div>
    <?php endforeach; ?>
  </nav>

  <div class="side-me">
    <span class="me-who"><b><?= e($u['name'] ?? '') ?></b><i><?= e($u['email'] ?? '') ?></i></span>
    <a class="me-out" href="index.php?p=logout">Çıkış</a>
  </div>
</aside>

<main><div class="page-w"><?php
}

function layout_foot(): void { echo '</div></main></body></html>'; }

/**
 * A nav entry whose screen has not landed yet.
 *
 * The five new areas are being built alongside this shell, and the sidebar
 * lists them from the first day because the shape of the product is the point.
 * An entry with nothing behind it therefore says so in one line and offers the
 * way back - it is never a dead link and never a 404, because the owner reads
 * a 404 as "broken", not as "not finished". The moment a handler for the key
 * exists this is not reached; see admin/nav.php for how to add one.
 */
function pending_page(string $p): void {
    $it = nav_item_for($p);
    $label = $it['label'] ?? 'Bu ekran';
    page_head($label, ['eyebrow' => 'Hazırlanıyor',
        'sub' => 'Bu bölüm panelin bir sonraki sürümünde açılacak.']);
    echo '<section class="card">';
    empty_state($label . ' henüz açılmadı',
        'Bölüm yapım aşamasında. Menüde yerini şimdiden görüyorsunuz; hazır olduğunda '
        . 'bu bağlantı doğrudan ekrana gidecek.',
        ['href' => 'index.php?p=home', 'label' => 'Genel bakışa dön']);
    echo '</section>';
}

/**
 * The page header every screen wears: a small eyebrow saying where you are, the
 * title, one line of subtext, and the actions on the right.
 *
 * $actions is raw HTML on purpose - the callers pass buttons and links they
 * have already escaped - so never hand it anything that came from a request.
 */
function page_head(string $title, array $o = []): void {
    echo '<div class="page-head"><div class="ph-txt">';
    if (!empty($o['eyebrow'])) echo '<div class="eyebrow">' . e($o['eyebrow']) . '</div>';
    echo '<h1>' . e($title) . '</h1>';
    if (!empty($o['sub'])) echo '<p class="sub">' . e($o['sub']) . '</p>';
    echo '</div>';
    if (!empty($o['actions'])) echo '<div class="ph-act">' . $o['actions'] . '</div>';
    echo '</div>';
}

/**
 * An empty state that says what to do next.
 *
 * "Henüz özet gelmedi" is not an empty state, it is a shrug: it tells the
 * vendor a box is empty, which he can already see, and nothing about whether
 * that is normal, whose fault it is, or what he should do. Every caller here
 * has to supply the next step.
 */
function empty_state(string $title, string $what_next, array $o = []): void {
    echo '<div class="empty"><b>' . e($title) . '</b><p>' . e($what_next) . '</p>';
    if (!empty($o['href'])) {
        echo '<a class="btn btn-sm btn-ghost" href="' . e($o['href']) . '">' . e($o['label'] ?? 'Aç') . '</a>';
    }
    echo '</div>';
}

/** An empty state sized to sit inside a table body. */
function empty_row(int $cols, string $title, string $what_next, array $o = []): void {
    echo '<tr><td colspan="' . $cols . '">';
    empty_state($title, $what_next, $o);
    echo '</td></tr>';
}

/**
 * One ratio against a whole.
 *
 * Single hue by necessity, not taste: #FF7A1A and #EA580C are 8.2 apart in
 * OKLab under normal vision (15 is the floor for "a reader can tell these
 * apart"), so this product's two tones cannot encode two different things.
 * The bar therefore carries magnitude only, in the dark tone - the light one
 * is 2.61:1 on white, under the 3:1 a graphical mark needs - and the number is
 * always printed beside it so the bar never has to be measured to be read.
 */
function meter(float $share, string $label, bool $quiet = false): void {
    $pct = max(0, min(100, $share * 100));
    echo '<div class="meter-row"><div class="meter' . ($quiet ? ' q' : '') . '">'
       . '<i style="width:' . number_format($pct, 1, '.', '') . '%"></i></div>'
       . '<span class="mv">' . e($label) . '</span></div>';
}
