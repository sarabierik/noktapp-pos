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
 * The reseller's door: session, guard and shell.
 *
 * ===========================================================================
 * Why this is a separate door and not a role on the admin session
 * ===========================================================================
 * A "role" column on np_admins would mean one set of screens serving two
 * audiences, and the difference between the vendor and a reseller would be a
 * condition inside every query. One forgotten condition then shows a reseller
 * his rival's customer list - and the failure is silent, because the page
 * renders perfectly.
 *
 * So: a different table (np_resellers), a different SESSION NAME, and
 * therefore a different cookie. An administrator's browser carries no reseller
 * session at all and is bounced to the reseller login here; a reseller's
 * browser carries no admin session and is bounced to the admin login there.
 * Neither door can be reached by editing the address bar from the other, and
 * that is a property of the cookie, not of a check somebody has to remember.
 *
 * Every read on these screens goes through the bayi_* functions in
 * lib/para.php, which take the reseller id as their first argument and put it
 * in the WHERE clause. Nothing under /bayi/ ever reads a row by id alone.
 */
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/para.php';

/* A DIFFERENT session name from the panel's. This one line is the boundary:
   two cookies, two sessions, no shared state, nothing to confuse. */
session_name(cfg('app.session_name') . '_bayi');
session_start();

/* Never a blank page here either - same reasoning as admin/auth.php: on shared
   hosting display_errors is off and a fatal leaves a half-drawn screen with
   nothing to act on. */
function bayi_fail_box(string $title, string $detail): void {
    echo '<div style="margin:22px;padding:16px 18px;border:1px solid #F5C6C2;background:#FDECEA;'
       . 'border-radius:10px;font:14px/1.5 \'Segoe UI\',system-ui,sans-serif;color:#B42318">'
       . '<b>' . htmlspecialchars($title) . '</b><br>'
       . '<span style="color:#7a1c14">' . htmlspecialchars($detail) . '</span></div>';
}
set_exception_handler(function (Throwable $e) {
    http_response_code(500);
    error_log('bayi: ' . $e->getMessage());
    bayi_fail_box('Bayi paneli bir hata ile karsilasti', $e->getMessage());
});
register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        bayi_fail_box('Bayi paneli durdu', $e['message'] . ' (' . basename($e['file']) . ':' . $e['line'] . ')');
    }
});

if (!function_exists('e')) {
    function e($s): string { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }
}

function bayi_user(): ?array { return $_SESSION['bayi'] ?? null; }

/**
 * The guard. An anonymous visitor and an ADMINISTRATOR are treated identically
 * here - neither carries a reseller session, so both land on the reseller
 * login. The vendor looking at a reseller's customers does it from his own
 * panel (index.php?p=bayi&id=), never by borrowing this door.
 */
function require_bayi(): array {
    $u = bayi_user();
    if (!$u) { header('Location: index.php?p=login'); exit; }
    /* Re-read on every request: a reseller deactivated a minute ago must lose
       the screens on their next click, not at the end of their session. */
    $live = one('SELECT id, code, name, email, commission_pct FROM np_resellers WHERE id=? AND is_active=1',
                [(int) $u['id']]);
    if (!$live) { session_destroy(); header('Location: index.php?p=login&x=1'); exit; }
    return $live;
}

function bayi_csrf(): string {
    if (empty($_SESSION['bayi_csrf'])) $_SESSION['bayi_csrf'] = bin2hex(random_bytes(16));
    return $_SESSION['bayi_csrf'];
}

/** The reseller's screens, in the order they matter to a reseller. */
function bayi_nav(): array {
    return [
        ['p' => 'home', 'label' => 'Genel', 'group' => ''],
        ['p' => 'musteriler', 'label' => 'Müşterilerim', 'group' => 'Müşteriler', 'also' => ['musteri']],
        ['p' => 'faturalar', 'label' => 'Faturalar', 'group' => 'Para', 'also' => ['fatura']],
        ['p' => 'odemeler', 'label' => 'Tahsilatlar', 'group' => 'Para'],
        ['p' => 'komisyon', 'label' => 'Komisyonum', 'group' => 'Para'],
    ];
}

function bayi_active(string $p): string {
    foreach (bayi_nav() as $it) {
        if ($it['p'] === $p || in_array($p, $it['also'] ?? [], true)) return $it['p'];
    }
    return $p;
}

/**
 * The same shell as the panel, drawn from the same stylesheet: fixed sidebar,
 * off-canvas drawer under 1000px behind a CSS-only checkbox. Reusing
 * assets/panel.css rather than writing a second one means the reseller's
 * screens cannot drift into looking like a different product, and nothing new
 * had to be added to the design system for them.
 */
function bayi_head(string $title, array $me): void {
    $p = (string) ($_GET['p'] ?? 'home');
    $active = bayi_active($p);
    $groups = [];
    foreach (bayi_nav() as $it) $groups[$it['group']][] = $it;
    $openGroup = '';
    foreach (bayi_nav() as $it) if ($it['p'] === $active) $openGroup = $it['group'];
    ?><!doctype html>
<html lang="tr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title><?= e($title) ?> · NOKTApp POS Bayi</title>
<link rel="stylesheet" href="<?= np_css() ?>">
</head><body>
<input type="checkbox" id="np-nav" class="nav-toggle" aria-label="Menüyü aç veya kapat">
<header class="topbar">
  <span class="burger" aria-hidden="true"><i></i><i></i><i></i></span>
  <div class="brand"><span class="mark"></span> NOKTApp POS <em>bayi</em></div>
</header>
<label class="nav-scrim" for="np-nav" aria-hidden="true"></label>

<aside class="side">
  <a class="side-brand" href="index.php?p=home">
    <span class="mark"></span><span>NOKTApp POS <em>bayi</em></span>
  </a>
  <nav class="side-nav" aria-label="Bayi bölümleri">
    <?php foreach ($groups as $gname => $items):
      $on = ($gname === $openGroup); ?>
      <div class="nav-group<?= $on ? ' on' : '' ?>">
        <?php if ($gname !== ''): ?>
          <div class="nav-h"><?= e(mb_strtoupper($gname, 'UTF-8')) ?></div>
        <?php endif; ?>
        <ul>
          <?php foreach ($items as $it): $cur = ($it['p'] === $active); ?>
            <li><a href="index.php?p=<?= e($it['p']) ?>" class="<?= $cur ? 'on' : '' ?>"
                   <?= $cur ? 'aria-current="page"' : '' ?>><?= e($it['label']) ?></a></li>
          <?php endforeach; ?>
        </ul>
      </div>
    <?php endforeach; ?>
  </nav>
  <div class="side-me">
    <span class="me-who"><b><?= e($me['name']) ?></b><i><?= e($me['email']) ?></i></span>
    <a class="me-out" href="index.php?p=logout">Çıkış</a>
  </div>
</aside>

<main><div class="page-w"><?php
}

function bayi_foot(): void { echo '</div></main></body></html>'; }

/** The page header, identical in shape to the panel's. */
function bayi_page_head(string $title, array $o = []): void {
    echo '<div class="page-head"><div class="ph-txt">';
    if (!empty($o['eyebrow'])) echo '<div class="eyebrow">' . e($o['eyebrow']) . '</div>';
    echo '<h1>' . e($title) . '</h1>';
    if (!empty($o['sub'])) echo '<p class="sub">' . e($o['sub']) . '</p>';
    echo '</div>';
    if (!empty($o['actions'])) echo '<div class="ph-act">' . $o['actions'] . '</div>';
    echo '</div>';
}

function bayi_empty(string $title, string $next, array $o = []): void {
    echo '<div class="empty"><b>' . e($title) . '</b><p>' . e($next) . '</p>';
    if (!empty($o['href'])) echo '<a class="btn btn-sm btn-ghost" href="' . e($o['href']) . '">' . e($o['label'] ?? 'Aç') . '</a>';
    echo '</div>';
}
function bayi_empty_row(int $cols, string $title, string $next, array $o = []): void {
    echo '<tr><td colspan="' . $cols . '">'; bayi_empty($title, $next, $o); echo '</td></tr>';
}

/** Same single-hue meter as the panel; see layout.php for why it is one tone. */
function bayi_meter(float $share, string $label): void {
    $pct = max(0, min(100, $share * 100));
    echo '<div class="meter-row"><div class="meter"><i style="width:'
       . number_format($pct, 1, '.', '') . '%"></i></div>'
       . '<span class="mv">' . e($label) . '</span></div>';
}

/** d.m.Y from a date/datetime, or an em dash. */
function bayi_dt(?string $ts, string $fmt = 'd.m.Y'): string {
    return $ts ? date($fmt, strtotime($ts)) : '—';
}
