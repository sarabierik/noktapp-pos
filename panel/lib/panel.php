<?php
/**
 * NOKTApp POS - what the vendor needs to know about his own business.
 *
 * Every figure the dashboard prints is one named function in here, and every
 * one of them has a list function beside it returning the same set of rows.
 * That pairing is the point: a number on the home page that implies something
 * is wrong is never a dead end, it is a link to exactly who, and the count and
 * the list cannot drift apart because the count IS count(the list) wherever
 * that is honest to do.
 *
 * Nothing here invents a metric the schema cannot support. In particular:
 *
 *  - "failed backup" is NOT reported, because it is not recorded and cannot
 *    be. np_backups only ever gets a row when an upload SUCCEEDS; a till that
 *    tried and failed, or never tried, leaves no trace. What is knowable is
 *    that a backup is OVERDUE, and that is what the panel says.
 *  - there is no payment or invoice history in the schema, so there is no
 *    revenue-over-time. What np_licences does hold is a price and a billing
 *    period, which is a contract value, and that is what is shown - a running
 *    annual figure, not a chart of money that was never recorded.
 */
require_once __DIR__ . '/db.php';

/* How long before a till that has stopped calling home is a problem. The
   desktop app heartbeats every half hour, so ten minutes is "right now" and
   three days is long past a weekend closure. */
const PANEL_ONLINE_MINUTES = 10;
const PANEL_SILENT_DAYS    = 3;
const PANEL_BACKUP_HOURS   = 36;

/**
 * The latest licence per tenant, as a joinable fragment.
 *
 * A tenant can have more than one licence row over its life (a renewal writes
 * a new one). Everywhere in the panel "the licence" means the newest, and it
 * has to mean the same thing in the count and in the list or the two disagree.
 * Defined once, here.
 */
function panel_licence_join(): string {
    return 'LEFT JOIN np_licences l ON l.id = (SELECT MAX(id) FROM np_licences WHERE tenant_id = t.id)';
}

/** Run a metric without letting one broken figure take the whole page down. */
function panel_try(callable $fn, $default = null) {
    try { return $fn(); }
    catch (Throwable $e) { error_log('panel metric: ' . $e->getMessage()); return $default; }
}

/* ===================== customers ===================== */

function panel_count_customers(bool $activeOnly = true): int {
    return (int) val('SELECT COUNT(*) FROM np_tenants' . ($activeOnly ? ' WHERE is_active=1' : ''));
}

/* ===================== tills ===================== */

/** Distinct tills seen in the last ten minutes. */
function panel_count_online_now(): int {
    return (int) val('SELECT COUNT(*) FROM np_devices
                       WHERE last_seen_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)', [PANEL_ONLINE_MINUTES]);
}

/** Distinct tills that have called home at any point since midnight. */
function panel_count_online_today(): int {
    return (int) val('SELECT COUNT(*) FROM np_devices WHERE last_seen_at >= CURDATE()');
}

function panel_count_devices(): int { return (int) val('SELECT COUNT(*) FROM np_devices'); }

/** Tills the vendor has deliberately blocked. */
function panel_list_blocked(): array {
    return all('SELECT d.*, t.company_name, t.id AS tenant_id
                  FROM np_devices d JOIN np_tenants t ON t.id = d.tenant_id
                 WHERE d.is_blocked = 1 ORDER BY t.company_name, d.device_name');
}

/* ===================== licences ===================== */

/**
 * Licences running out within $days - names, not just a count.
 *
 * Only live licences (active/trial) count: one that is already marked expired
 * or suspended is a different conversation and appears in its own list.
 * Already-past expiry dates are excluded here and reported separately, because
 * "expires in nine days" and "expired last Tuesday" are not the same job.
 */
function panel_list_expiring(int $days, int $fromDays = 0): array {
    return all("SELECT t.id, t.code, t.company_name, t.email, t.phone, t.city,
                       l.licence_key, l.status, l.plan, l.seats, l.price, l.billing_period, l.expires_at,
                       DATEDIFF(l.expires_at, NOW()) AS days_left
                  FROM np_tenants t " . panel_licence_join() . "
                 WHERE t.is_active = 1
                   AND l.status IN ('active','trial')
                   AND l.expires_at IS NOT NULL
                   AND l.expires_at >= NOW()
                   AND l.expires_at <  DATE_ADD(NOW(), INTERVAL ? DAY)
                   AND l.expires_at >= DATE_ADD(NOW(), INTERVAL ? DAY)
                 ORDER BY l.expires_at", [$days, $fromDays]);
}
function panel_count_expiring(int $days, int $fromDays = 0): int {
    return count(panel_list_expiring($days, $fromDays));
}

/** Live licences whose date has already gone by, plus any marked expired. */
function panel_list_lapsed(): array {
    return all("SELECT t.id, t.code, t.company_name, t.email, t.phone,
                       l.licence_key, l.status, l.plan, l.seats, l.expires_at,
                       DATEDIFF(NOW(), l.expires_at) AS days_over
                  FROM np_tenants t " . panel_licence_join() . "
                 WHERE t.is_active = 1
                   AND ((l.status IN ('active','trial') AND l.expires_at IS NOT NULL AND l.expires_at < NOW())
                        OR l.status = 'expired')
                 ORDER BY l.expires_at");
}
function panel_count_lapsed(): int { return count(panel_list_lapsed()); }

/**
 * Annual contract value: what the customer base is worth over a year at the
 * prices currently recorded. A monthly licence counts twelve times.
 * NOT revenue - nothing in this schema records money that actually arrived.
 */
function panel_contract_value(): array {
    $r = one("SELECT
                SUM(CASE WHEN l.billing_period='monthly' THEN l.price*12 ELSE l.price END) AS yearly,
                COUNT(l.price) AS priced,
                COUNT(*) AS total
              FROM np_tenants t " . panel_licence_join() . "
             WHERE t.is_active = 1 AND l.status IN ('active','trial')");
    return ['yearly' => (float) ($r['yearly'] ?? 0),
            'priced' => (int) ($r['priced'] ?? 0),
            'total'  => (int) ($r['total'] ?? 0)];
}

/* ===================== silence ===================== */

/**
 * Customers whose tills have stopped calling home.
 *
 * Split deliberately in two, because they are two different phone calls:
 *  - 'sessiz'  - it was installed and working and has now gone quiet
 *  - 'kurulum' - we sold it and nothing was ever installed
 * Rolling them into one number would hide the second, which is the one that
 * costs a sale.
 */
function panel_list_silent(int $days = PANEL_SILENT_DAYS): array {
    return all('SELECT t.id, t.code, t.company_name, t.email, t.phone, t.city,
                       l.status AS lic_status, l.expires_at,
                       MAX(d.last_seen_at) AS last_seen,
                       COUNT(d.id) AS devices,
                       DATEDIFF(NOW(), MAX(d.last_seen_at)) AS days_quiet
                  FROM np_tenants t ' . panel_licence_join() . '
                  JOIN np_devices d ON d.tenant_id = t.id
                 WHERE t.is_active = 1
                 GROUP BY t.id, t.code, t.company_name, t.email, t.phone, t.city, l.status, l.expires_at
                HAVING MAX(d.last_seen_at) IS NULL
                    OR MAX(d.last_seen_at) < DATE_SUB(NOW(), INTERVAL ? DAY)
                 /* the aggregate is repeated rather than aliased: MariaDB
                    rejects a group-function alias in ORDER BY */
                 ORDER BY MAX(d.last_seen_at) IS NOT NULL, MAX(d.last_seen_at)', [$days]);
}
function panel_count_silent(int $days = PANEL_SILENT_DAYS): int { return count(panel_list_silent($days)); }

/** Sold, never installed: an active customer with no till on record at all. */
function panel_list_never_installed(): array {
    return all('SELECT t.id, t.code, t.company_name, t.email, t.phone, t.city, t.created_at,
                       l.status AS lic_status, l.expires_at,
                       DATEDIFF(NOW(), t.created_at) AS days_since
                  FROM np_tenants t ' . panel_licence_join() . '
                 WHERE t.is_active = 1
                   AND NOT EXISTS (SELECT 1 FROM np_devices d WHERE d.tenant_id = t.id)
                 ORDER BY t.created_at DESC');
}
function panel_count_never_installed(): int { return count(panel_list_never_installed()); }

/* ===================== backups ===================== */

/**
 * Backups that are overdue - NOT backups that failed.
 *
 * Only a successful upload writes a np_backups row, so a failure is invisible
 * here by construction and the panel must not pretend otherwise. A customer
 * with no till on record is excluded: nothing is installed, so nothing is
 * late, and listing them here would bury the real ones.
 */
function panel_list_backup_overdue(int $hours = PANEL_BACKUP_HOURS): array {
    return all('SELECT t.id, t.code, t.company_name, t.email, t.phone,
                       MAX(b.created_at) AS last_backup,
                       (SELECT MAX(last_seen_at) FROM np_devices d WHERE d.tenant_id = t.id) AS last_seen,
                       TIMESTAMPDIFF(HOUR, MAX(b.created_at), NOW()) AS hours_since
                  FROM np_tenants t
             LEFT JOIN np_backups b ON b.tenant_id = t.id
                 WHERE t.is_active = 1
                   AND EXISTS (SELECT 1 FROM np_devices d WHERE d.tenant_id = t.id)
                 GROUP BY t.id, t.code, t.company_name, t.email, t.phone
                HAVING MAX(b.created_at) IS NULL
                    OR MAX(b.created_at) < DATE_SUB(NOW(), INTERVAL ? HOUR)
                 ORDER BY MAX(b.created_at) IS NOT NULL, MAX(b.created_at)', [$hours]);
}
function panel_count_backup_overdue(int $hours = PANEL_BACKUP_HOURS): int {
    return count(panel_list_backup_overdue($hours));
}

/** Customers that DID back up inside the window - the reassuring half. */
function panel_count_backup_ok(int $hours = PANEL_BACKUP_HOURS): int {
    return (int) val('SELECT COUNT(DISTINCT tenant_id) FROM np_backups
                       WHERE created_at > DATE_SUB(NOW(), INTERVAL ? HOUR)', [$hours]);
}

/* ===================== versions ===================== */

/** The build the panel is currently handing out on the stable channel. */
function panel_current_version(): ?array {
    return one("SELECT * FROM np_versions WHERE is_current=1 AND channel='stable'
                 ORDER BY released_at DESC LIMIT 1");
}

/**
 * Is the installer actually sitting in indir/ ?
 *
 * A published row whose file was never uploaded is the single most damaging
 * state this screen can be in: latest.yml advertises a build and every till
 * that tries to take it fails. Cheap to check, so it is checked.
 */
function panel_release_file(array $v): array {
    $path = rtrim((string) cfg('release_dir'), '/') . '/' . $v['filename'];
    $there = is_file($path);
    return ['present' => $there,
            'size'    => $there ? (int) filesize($path) : 0,
            'path'    => $path,
            /* a size that disagrees with the record means a half-finished upload */
            'mismatch' => $there && (int) $v['size_bytes'] > 0
                          && (int) filesize($path) !== (int) $v['size_bytes']];
}

/**
 * Which build every till is on.
 *
 * Version strings are semver-ish, so the comparison happens in PHP with
 * version_compare - MySQL would sort '2.0.10' before '2.0.9'.
 */
function panel_version_adoption(): array {
    $cur = panel_current_version();
    $curV = $cur['version'] ?? null;
    $rows = all('SELECT COALESCE(NULLIF(d.app_version, ""), "?") AS v,
                        COUNT(*) AS devices,
                        COUNT(DISTINCT d.tenant_id) AS tenants
                   FROM np_devices d JOIN np_tenants t ON t.id = d.tenant_id
                  WHERE t.is_active = 1
                  GROUP BY v');
    $total = 0;
    foreach ($rows as $r) $total += (int) $r['devices'];
    foreach ($rows as &$r) {
        $r['devices'] = (int) $r['devices'];
        $r['tenants'] = (int) $r['tenants'];
        $r['share']   = $total ? $r['devices'] / $total : 0.0;
        $r['unknown'] = ($r['v'] === '?');
        $r['current'] = ($curV !== null && !$r['unknown'] && version_compare($r['v'], $curV, '=='));
        $r['behind']  = ($curV !== null && !$r['unknown'] && version_compare($r['v'], $curV, '<'));
        $r['ahead']   = ($curV !== null && !$r['unknown'] && version_compare($r['v'], $curV, '>'));
    }
    unset($r);
    /* newest first; the unknowns sink to the bottom where they belong */
    usort($rows, function ($a, $b) {
        if ($a['unknown'] !== $b['unknown']) return $a['unknown'] ? 1 : -1;
        if ($a['unknown']) return 0;
        return version_compare($b['v'], $a['v']);
    });
    return ['current' => $curV, 'total' => $total, 'rows' => $rows];
}

/**
 * Customers running at least one till on something older than the current
 * build - the list behind "who has not taken the update".
 */
function panel_list_outdated(): array {
    $cur = panel_current_version();
    if (!$cur) return [];
    $rows = all('SELECT t.id, t.code, t.company_name, t.email, t.phone,
                        d.device_id, d.device_name, d.app_version, d.last_seen_at
                   FROM np_devices d JOIN np_tenants t ON t.id = d.tenant_id
                  WHERE t.is_active = 1
                  ORDER BY t.company_name, d.device_name');
    $byTenant = [];
    foreach ($rows as $r) {
        $v = (string) $r['app_version'];
        /* A till that has never reported a version is counted as behind: we do
           not know that it is up to date, and "unknown" is not "fine". */
        $behind = ($v === '' || version_compare($v, $cur['version'], '<'));
        if (!$behind) continue;
        $id = (int) $r['id'];
        if (!isset($byTenant[$id])) {
            $byTenant[$id] = ['id' => $id, 'code' => $r['code'], 'company_name' => $r['company_name'],
                              'email' => $r['email'], 'phone' => $r['phone'],
                              'devices' => [], 'oldest' => null, 'last_seen' => null];
        }
        $byTenant[$id]['devices'][] = $r;
        if ($v !== '' && ($byTenant[$id]['oldest'] === null || version_compare($v, $byTenant[$id]['oldest'], '<'))) {
            $byTenant[$id]['oldest'] = $v;
        }
        if ($r['last_seen_at'] && $r['last_seen_at'] > (string) $byTenant[$id]['last_seen']) {
            $byTenant[$id]['last_seen'] = $r['last_seen_at'];
        }
    }
    return array_values($byTenant);
}
function panel_count_outdated(): int { return count(panel_list_outdated()); }

/** Customers with every till already on the current build. */
function panel_count_up_to_date(): int {
    $cur = panel_current_version();
    if (!$cur) return 0;
    $withDevices = (int) val('SELECT COUNT(DISTINCT d.tenant_id) FROM np_devices d
                                JOIN np_tenants t ON t.id = d.tenant_id WHERE t.is_active = 1');
    return max(0, $withDevices - panel_count_outdated());
}

/* ===================== search ===================== */

/**
 * One box, every field the vendor actually has in front of him when a
 * restaurant rings: the name on the door, the e-mail he set up, the licence
 * key read off the till's about box, the tax number on the invoice, or the
 * device id from a support session.
 *
 * The licence key is a credential, so this is reached by POST and the term
 * never travels in a URL. Matching on it is exact - a LIKE on a secret would
 * let someone walk it a character at a time.
 */
function panel_search(string $term, int $limit = 60): array {
    $term = trim($term);
    if ($term === '') return [];
    $like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $term) . '%';
    $exact = $term;

    $rows = all("SELECT DISTINCT t.id, t.code, t.company_name, t.owner_name, t.email, t.phone,
                        t.tax_number, t.city, t.is_active,
                        l.status AS lic_status, l.plan, l.seats, l.expires_at,
                        (SELECT MAX(last_seen_at) FROM np_devices d2 WHERE d2.tenant_id = t.id) AS last_seen
                   FROM np_tenants t " . panel_licence_join() . "
              LEFT JOIN np_devices d ON d.tenant_id = t.id
              LEFT JOIN np_licences la ON la.tenant_id = t.id
                  WHERE t.company_name LIKE ?
                     OR t.owner_name  LIKE ?
                     OR t.email       LIKE ?
                     OR t.code        LIKE ?
                     OR t.phone       LIKE ?
                     OR t.tax_number  LIKE ?
                     OR d.device_id   = ?
                     OR d.device_name LIKE ?
                     OR la.licence_key = ?
                  ORDER BY t.company_name
                  LIMIT " . (int) $limit,
        [$like, $like, $like, $like, $like, $like, $exact, $like, $exact]);

    /* Say WHY each row matched, so a hit on a device id or a tax number does
       not look like an unexplained result. */
    foreach ($rows as &$r) {
        $why = [];
        $t = mb_strtolower($term, 'UTF-8');
        if (mb_stripos((string) $r['company_name'], $term) !== false) $why[] = 'ünvan';
        if (mb_stripos((string) $r['owner_name'], $term) !== false)   $why[] = 'yetkili';
        if (mb_stripos((string) $r['email'], $term) !== false)        $why[] = 'e-posta';
        if (mb_stripos((string) $r['code'], $term) !== false)         $why[] = 'kod';
        if (mb_stripos((string) $r['phone'], $term) !== false)        $why[] = 'telefon';
        if (mb_stripos((string) $r['tax_number'], $term) !== false)   $why[] = 'vergi no';
        if (val('SELECT 1 FROM np_licences WHERE tenant_id=? AND licence_key=?', [$r['id'], $exact])) $why[] = 'lisans anahtarı';
        if (val('SELECT 1 FROM np_devices WHERE tenant_id=? AND (device_id=? OR device_name LIKE ?)',
                [$r['id'], $exact, $like])) $why[] = 'cihaz';
        $r['why'] = $why;
        unset($t);
    }
    unset($r);
    return $rows;
}

/* ===================== formatting ===================== */

function panel_ago(?string $ts): string {
    if (!$ts) return 'hiç';
    $s = time() - strtotime($ts);
    if ($s < 90) return 'az önce';
    if ($s < 3600) return floor($s / 60) . ' dk önce';
    if ($s < 86400) return floor($s / 3600) . ' saat önce';
    $d = floor($s / 86400);
    if ($d < 30) return $d . ' gün önce';
    return date('d.m.Y', strtotime($ts));
}
function panel_dt(?string $ts, string $fmt = 'd.m.Y H:i'): string {
    return $ts ? date($fmt, strtotime($ts)) : '—';
}
function panel_mb(?int $bytes): string {
    if (!$bytes) return '—';
    if ($bytes < 1048576) return number_format($bytes / 1024, 0, ',', '.') . ' KB';
    return number_format($bytes / 1048576, 1, ',', '.') . ' MB';
}
