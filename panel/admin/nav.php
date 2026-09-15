<?php
/**
 * The panel's information architecture — ONE definition.
 *
 * The sidebar, the active-state marker, the page <title>, the "this screen is
 * on its way" notice and the tests all read this file. Nothing else in the
 * shell knows the list of screens, so a page is added in exactly one place.
 *
 * ---------------------------------------------------------------------------
 * ADDING A SCREEN (this is the contract for whoever builds sections 2-5)
 * ---------------------------------------------------------------------------
 *   1. Add a line to panel_nav() under the right group:
 *          ['p' => 'faturalar', 'label' => 'Faturalar'],
 *      'p' is the ?p= name. 'also' lists the other ?p= names that belong to
 *      the same item (a detail screen, a filtered list) so the sidebar marks
 *      the parent while you are on them.
 *
 *   2. Render it either way — both work, neither needs the shell edited:
 *          a. an  elseif ($p === 'faturalar') { ... }  branch in
 *             admin/index.php, the way chain.php and rapor.php do it; or
 *          b. a drop-in file  admin/pages/faturalar.php  that renders the
 *             page when included. index.php includes it automatically.
 *
 * Until (2) exists the entry still appears in the sidebar and opens a short
 * "hazırlanıyor" notice. A nav entry must never be a dead link and must never
 * be a 404 — the owner reads a 404 as a broken product, not as unfinished work.
 *
 * The keys below are already reserved for the four new areas. Use them as they
 * are so the sidebar, the tests and your pages agree:
 *   bayiler · faturalar · odemeler · gelir · teshis · uyarilar
 */

/**
 * Groups, in the order they are shown. An empty 'title' is a group with no
 * heading — only the dashboard sits there, because a heading over one item is
 * furniture, not structure.
 */
function panel_nav(): array {
    return [
        ['key' => 'genel', 'title' => '', 'items' => [
            ['p' => 'home', 'label' => 'Genel', 'title' => 'Genel bakış'],
        ]],
        ['key' => 'musteriler', 'title' => 'Müşteriler', 'items' => [
            ['p' => 'tenants', 'label' => 'İşletmeler', 'title' => 'İşletmeler',
             /* the customer page, search, the drill-down lists and every chain
                screen are all "İşletmeler" as far as the sidebar is concerned */
             'also' => ['tenant', 'ara', 'liste', 'branches', 'menu',
                        'menuversions', 'exceptions', 'rapor']],
            ['p' => 'devices', 'label' => 'Kasalar', 'title' => 'Kasalar',
             'also' => ['device']],
            ['p' => 'bayiler', 'label' => 'Bayiler', 'title' => 'Bayiler',
             'also' => ['bayi']],
        ]],
        ['key' => 'para', 'title' => 'Para', 'items' => [
            ['p' => 'faturalar', 'label' => 'Faturalar', 'title' => 'Faturalar',
             'also' => ['fatura']],
            ['p' => 'odemeler', 'label' => 'Ödemeler', 'title' => 'Ödemeler',
             'also' => ['odeme']],
            ['p' => 'gelir', 'label' => 'Gelir', 'title' => 'Gelir'],
        ]],
        ['key' => 'destek', 'title' => 'Destek', 'items' => [
            ['p' => 'teshis', 'label' => 'Kasa teşhis', 'title' => 'Kasa teşhis',
             'also' => ['kasateshis', 'teshis_kasa']],
            ['p' => 'backups', 'label' => 'Yedekler', 'title' => 'Yedekler'],
            ['p' => 'relay', 'label' => 'Relay', 'title' => 'Relay'],
        ]],
        ['key' => 'yayin', 'title' => 'Yayın', 'items' => [
            ['p' => 'versions', 'label' => 'Sürümler', 'title' => 'Sürümler'],
        ]],
        ['key' => 'sistem', 'title' => 'Sistem', 'items' => [
            ['p' => 'uyarilar', 'label' => 'Uyarılar', 'title' => 'Uyarılar',
             'also' => ['uyari']],
            ['p' => 'audit', 'label' => 'İşlem kayıtları', 'title' => 'İşlem kayıtları'],
            /* Not a ?p= screen: guncelle.php is its own door, so the item
               carries its own href and its own active key. */
            ['p' => 'guncelle', 'label' => 'Panel güncelleme', 'title' => 'Panel güncelleme',
             'href' => 'guncelle.php'],
        ]],
    ];
}

/** Every nav item, flattened, keyed by its ?p= name. */
function nav_items(): array {
    static $flat = null;
    if ($flat !== null) return $flat;
    $flat = [];
    foreach (panel_nav() as $g) {
        foreach ($g['items'] as $it) { $it['group'] = $g['key']; $flat[$it['p']] = $it; }
    }
    return $flat;
}

/** The nav item a given ?p= belongs to, following the 'also' aliases. */
function nav_item_for(string $p): ?array {
    $items = nav_items();
    if (isset($items[$p])) return $items[$p];
    foreach ($items as $it) {
        if (in_array($p, $it['also'] ?? [], true)) return $it;
    }
    return null;
}

/** Is this ?p= a screen the sidebar offers (directly or as an alias)? */
function nav_knows(string $p): bool { return nav_item_for($p) !== null; }

/** The ?p= of the sidebar entry to mark, for a page that may be an alias. */
function nav_active_key(string $p): string { return nav_item_for($p)['p'] ?? ''; }

/** The group key of the open section, so its heading can stop being muted. */
function nav_active_group(string $p): string { return nav_item_for($p)['group'] ?? ''; }

/** The <title> for a screen the shell knows about, if it has one. */
function nav_title(string $p): ?string {
    $it = nav_item_for($p);
    if (!$it) return null;
    /* An alias keeps the parent's label only as a fallback; a page with its own
       branch in index.php passes its own title and never reaches this. */
    return $it['title'] ?? $it['label'];
}

/** Where a nav entry points. */
function nav_href(array $it): string {
    return $it['href'] ?? ('index.php?p=' . rawurlencode($it['p']));
}
