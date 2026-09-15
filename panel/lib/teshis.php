<?php
/**
 * KASA TEŞHİS - the panel's half of till diagnostics.
 *
 * The till posts one small document on its heartbeat, at most once an hour
 * (pos-service/src/modules/teshis.js). This file is what receives it, what
 * decides how much of it to believe, and what every diagnostics screen reads.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS FILE ENFORCES
 * ---------------------------------------------------------------------------
 * The document arrives over the public desktop API from a machine we do not
 * control, in a restaurant we cannot see. It is therefore treated as UNTRUSTED
 * INPUT twice over:
 *
 *   1. Size. teshis_clean() rebuilds the document field by field from a fixed
 *      whitelist and throws everything else away. A till that has been made to
 *      send a megabyte of anything stores a few kilobytes of the fields we
 *      asked for and nothing at all of the rest. It is a cap, not a filter -
 *      a filter has to be right about what is dangerous, a whitelist only has
 *      to be right about what is wanted.
 *
 *   2. Content. Nothing personal is expected in it and nothing personal is
 *      kept. The strings that CAN carry free text - the printer names, the log
 *      lines - are truncated hard and the log lines are scrubbed of anything
 *      shaped like an e-mail address, a phone number or a Turkish identity
 *      number before they are stored. The till already refuses to put those in
 *      (see its own module), and this is the second of the two locks: the
 *      panel must not depend on every installed till in the field being the
 *      current build.
 *
 * ---------------------------------------------------------------------------
 * SCOPING
 * ---------------------------------------------------------------------------
 * A device_id is only meaningful inside a tenant - two customers can hold the
 * same string, and one of them holding the other's is how a support screen
 * ends up showing the wrong restaurant's disk. Every function here takes the
 * tenant id first and every query starts with it. There is deliberately no
 * "find this till by device_id" function to be tempted by.
 */
require_once __DIR__ . '/db.php';

/** How many past documents to keep per till. A day of hourly pushes. */
const NP_DIAG_KEEP = 24;

/** Longest free-text string kept from the document, in characters. */
const NP_DIAG_STR = 120;

/** Most log lines and most printers kept, whatever the till sent. */
const NP_DIAG_LINES = 12;
const NP_DIAG_PRINTERS = 20;

/** A till that has not pushed a document in this long is stale, not healthy. */
const NP_DIAG_STALE_HOURS = 26;

/** Does this panel have the diagnostics tables yet? */
function teshis_ready(): bool {
    static $ok = null;
    if ($ok !== null) return $ok;
    try { $ok = (bool) db()->query("SHOW TABLES LIKE 'np\\_diagnostics'")->fetch(); }
    catch (Throwable $e) { $ok = false; }
    return $ok;
}

/* ------------------------------------------------------------------ *
 * Cleaning
 * ------------------------------------------------------------------ */

function teshis_s($v, int $max = NP_DIAG_STR): ?string {
    if ($v === null || is_array($v) || is_object($v)) return null;
    $s = trim((string) $v);
    if ($s === '') return null;
    return mb_substr($s, 0, $max, 'UTF-8');
}
function teshis_i($v): ?int { return is_numeric($v) ? (int) $v : null; }
function teshis_b($v): int { return !empty($v) && $v !== 'false' ? 1 : 0; }
function teshis_date($v): ?string {
    $s = teshis_s($v, 10);
    return ($s !== null && preg_match('/^\d{4}-\d{2}-\d{2}$/', $s)) ? $s : null;
}

/**
 * Strip anything that looks like it identifies a person.
 *
 * The log lines are the only field in the document that is written by
 * arbitrary code rather than assembled from counts, so they are the only place
 * a name or an address could ever reach us - an integration error echoing a
 * courier's phone number, a mail failure quoting the guest it was sent to.
 * Patterns, not a word list: an e-mail address, a long run of digits (a phone
 * or a TCKN), and an IBAN. Replaced with a marker rather than deleted so the
 * line still reads as a sentence to whoever is debugging it.
 */
function teshis_scrub(string $s): string {
    $s = preg_replace('/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u', '[e-posta]', $s);
    $s = preg_replace('/\bTR\d{2}[ ]?[0-9 ]{16,30}\b/u', '[iban]', $s);
    /*
     * Ten or more digits in a row, allowing the spaces, dashes and brackets a
     * telephone number is written with. Deliberately blunt: a phone, a TCKN, a
     * card and an account number are all caught by one rule, and no COUNT this
     * document carries is ten digits long.
     *
     * The one thing that is ten digits and identifies nobody is the date at the
     * front of every log line, so it is let through by name. Without that
     * exception every line in the document begins "[numara]:22:17" and the
     * support screen loses the only field that says WHEN.
     */
    $s = preg_replace_callback('/\b\d[\d \-()]{8,}\d\b/u', function ($m) {
        if (preg_match('/^\d{4}-\d{2}-\d{2}/', $m[0])) return $m[0];   // 2026-09-08
        return strlen(preg_replace('/\D/', '', $m[0])) >= 10 ? '[numara]' : $m[0];
    }, $s);
    return $s;
}

/**
 * Rebuild the document from a whitelist. Unknown keys never survive.
 * Returns the clean array; never throws on rubbish input.
 */
function teshis_clean($in): array {
    if (!is_array($in)) return [];
    $out = [];

    $out['at']            = teshis_s($in['at'] ?? null, 32);          // the till's own clock
    $out['app_version']   = teshis_s($in['app_version'] ?? null, 32);
    $out['engine']        = teshis_s($in['engine'] ?? null, 64);      // MariaDB/MySQL version
    $out['os']            = teshis_s($in['os'] ?? null, 120);
    $out['node']          = teshis_s($in['node'] ?? null, 32);
    $out['uptime_h']      = teshis_i($in['uptime_h'] ?? null);
    $out['disk_free_mb']  = teshis_i($in['disk_free_mb'] ?? null);
    $out['disk_total_mb'] = teshis_i($in['disk_total_mb'] ?? null);
    $out['db_size_mb']    = teshis_i($in['db_size_mb'] ?? null);
    $out['stations']      = teshis_i($in['stations'] ?? null);
    $out['print_pending'] = teshis_i($in['print_pending'] ?? null);
    $out['print_failed']  = teshis_i($in['print_failed'] ?? null);
    $out['open_bills']    = teshis_i($in['open_bills'] ?? null);
    $out['last_close']    = teshis_date($in['last_close'] ?? null);
    $out['last_close_seq']= teshis_i($in['last_close_seq'] ?? null);
    $out['okc']           = teshis_b($in['okc'] ?? null);
    $out['okc_provider']  = teshis_s($in['okc_provider'] ?? null, 32);
    $out['okc_status']    = teshis_s($in['okc_status'] ?? null, 32);
    $out['okc_devices']   = teshis_i($in['okc_devices'] ?? null);
    $out['errors_24h']    = teshis_i($in['errors_24h'] ?? null);
    $out['backup_at']     = teshis_s($in['backup_at'] ?? null, 32);
    $out['backup_mb']     = teshis_i($in['backup_mb'] ?? null);

    $out['printers'] = [];
    foreach (array_slice((array) ($in['printers'] ?? []), 0, NP_DIAG_PRINTERS) as $p) {
        if (!is_array($p)) continue;
        $out['printers'][] = [
            'name'    => teshis_s($p['name'] ?? null, 60),
            'type'    => teshis_s($p['type'] ?? null, 32),
            'target'  => teshis_s($p['target'] ?? null, 60),
            'station' => teshis_s($p['station'] ?? null, 60),
            'last'    => teshis_s($p['last'] ?? null, 16),     // done | failed | pending | yok
            'last_at' => teshis_s($p['last_at'] ?? null, 32),
        ];
    }

    $out['log'] = [];
    foreach (array_slice((array) ($in['log'] ?? []), 0, NP_DIAG_LINES) as $l) {
        if (is_array($l) || is_object($l)) continue;
        $line = teshis_scrub(trim((string) $l));
        if ($line === '') continue;
        $out['log'][] = mb_substr($line, 0, 220, 'UTF-8');
    }

    return $out;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/**
 * Store one document against one till, and push a copy onto its history.
 *
 * Called from api/desktop/heartbeat.php, which is the licence lifeline for
 * every installed till in the country. It therefore NEVER throws: a panel that
 * has the new code but not yet the new tables, or a document that upsets a
 * column, must cost the restaurant a diagnostics row and not its licence
 * check. Returns true only when a row was actually written.
 */
function teshis_store(int $tenantId, string $deviceId, $raw): bool {
    $deviceId = substr(trim($deviceId), 0, 64);
    if (!$tenantId || $deviceId === '') return false;
    try {
        if (!teshis_ready()) return false;
        $d = teshis_clean($raw);
        if (!$d) return false;

        $bad = 0;
        foreach ($d['printers'] as $p) if (($p['last'] ?? '') === 'failed') $bad++;
        $json = json_encode($d, JSON_UNESCAPED_UNICODE);

        q('INSERT INTO np_diagnostics (tenant_id, device_id, received_at, app_version, engine_version,
              os, disk_free_mb, db_size_mb, stations, printers, printers_bad, print_pending,
              open_bills, last_close_date, okc, errors, payload)
           VALUES (?,?,NOW(),?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE received_at=NOW(), app_version=VALUES(app_version),
              engine_version=VALUES(engine_version), os=VALUES(os),
              disk_free_mb=VALUES(disk_free_mb), db_size_mb=VALUES(db_size_mb),
              stations=VALUES(stations), printers=VALUES(printers),
              printers_bad=VALUES(printers_bad), print_pending=VALUES(print_pending),
              open_bills=VALUES(open_bills), last_close_date=VALUES(last_close_date),
              okc=VALUES(okc), errors=VALUES(errors), payload=VALUES(payload)',
          [$tenantId, $deviceId, $d['app_version'], $d['engine'], $d['os'],
           $d['disk_free_mb'], $d['db_size_mb'], $d['stations'], count($d['printers']), $bad,
           $d['print_pending'], $d['open_bills'], $d['last_close'], $d['okc'], $d['errors_24h'], $json]);

        q('INSERT INTO np_diagnostics_log (tenant_id, device_id, received_at, payload)
           VALUES (?,?,NOW(),?)', [$tenantId, $deviceId, $json]);
        teshis_trim($tenantId, $deviceId);
        return true;
    } catch (Throwable $e) {
        error_log('teshis_store: ' . $e->getMessage());
        return false;
    }
}

/**
 * Keep only the newest NP_DIAG_KEEP documents for one till.
 *
 * Trimmed on write rather than by a nightly job, because the nightly job is
 * the thing nobody notices has stopped. Two statements instead of a subquery
 * on the same table, which MariaDB will not allow inside a DELETE.
 */
function teshis_trim(int $tenantId, string $deviceId, int $keep = NP_DIAG_KEEP): void {
    $keep = max(1, $keep);
    $ids = all('SELECT id FROM np_diagnostics_log WHERE tenant_id=? AND device_id=?
                 ORDER BY id DESC LIMIT ' . (int) $keep . ', 18446744073709551615',
               [$tenantId, $deviceId]);
    if (!$ids) return;
    $in = implode(',', array_map('intval', array_column($ids, 'id')));
    db()->exec("DELETE FROM np_diagnostics_log WHERE id IN ($in)");
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/** Every till the panel knows about, with its diagnostics if it has sent one. */
function teshis_list(?int $tenantId = null, int $limit = 400): array {
    $args = [];
    $where = '';
    if ($tenantId) { $where = 'WHERE d.tenant_id=?'; $args[] = $tenantId; }
    $rows = all("SELECT d.tenant_id, d.device_id, d.device_name, d.app_version, d.last_ip,
                        d.last_seen_at, d.is_blocked, t.company_name, t.code tenant_code,
                        g.received_at, g.engine_version, g.os, g.disk_free_mb, g.db_size_mb,
                        g.stations, g.printers, g.printers_bad, g.print_pending, g.open_bills,
                        g.last_close_date, g.okc, g.errors
                   FROM np_devices d
                   JOIN np_tenants t ON t.id = d.tenant_id
              LEFT JOIN np_diagnostics g ON g.tenant_id = d.tenant_id AND g.device_id = d.device_id
                   $where
               ORDER BY d.last_seen_at IS NULL, d.last_seen_at DESC
                  LIMIT " . (int) $limit, $args);
    foreach ($rows as &$r) $r['health'] = teshis_health($r);
    return $rows;
}

/** One till: the heartbeat facts plus the current document. */
function teshis_one(int $tenantId, string $deviceId): ?array {
    $r = one("SELECT d.tenant_id, d.device_id, d.device_name, d.app_version, d.last_ip,
                     d.last_seen_at, d.first_seen_at, d.is_blocked, d.branch_id,
                     t.company_name, t.code tenant_code, t.phone, t.city,
                     g.received_at, g.engine_version, g.os, g.disk_free_mb, g.db_size_mb,
                     g.stations, g.printers, g.printers_bad, g.print_pending, g.open_bills,
                     g.last_close_date, g.okc, g.errors, g.payload
                FROM np_devices d
                JOIN np_tenants t ON t.id = d.tenant_id
           LEFT JOIN np_diagnostics g ON g.tenant_id = d.tenant_id AND g.device_id = d.device_id
               WHERE d.tenant_id=? AND d.device_id=?", [$tenantId, $deviceId]);
    if (!$r) return null;
    $r['doc'] = $r['payload'] ? (json_decode($r['payload'], true) ?: []) : [];
    $r['health'] = teshis_health($r);
    return $r;
}

/** The last N documents for one till, newest first. */
function teshis_history(int $tenantId, string $deviceId, int $limit = NP_DIAG_KEEP): array {
    $rows = all('SELECT id, received_at, payload FROM np_diagnostics_log
                  WHERE tenant_id=? AND device_id=? ORDER BY id DESC LIMIT ' . (int) $limit,
                [$tenantId, $deviceId]);
    foreach ($rows as &$r) $r['doc'] = json_decode((string) $r['payload'], true) ?: [];
    return $rows;
}

/**
 * How this till reads, in one word.
 *
 * "bilinmiyor" is a state of its own and is NOT the same as "iyi". A till that
 * has never sent a document has not told us it is healthy; it has told us
 * nothing, and a support screen that paints silence green is worse than one
 * that shows nothing at all - the owner rings the customer to say everything
 * looks fine while their printer has been dead for a week.
 *
 * Returns [key, label, why].
 */
function teshis_health(array $r): array {
    if (empty($r['received_at'])) {
        return ['unknown', 'bilinmiyor',
                'Bu kasa henüz teşhis belgesi göndermedi — sürümü eski olabilir.'];
    }
    $ageH = (time() - strtotime((string) $r['received_at'])) / 3600;
    if ($ageH > NP_DIAG_STALE_HOURS) {
        return ['stale', 'eski bilgi',
                'Son belge ' . (int) round($ageH / 24) . ' gün önce geldi; aşağıdakiler o günün durumu.'];
    }
    $why = [];
    if ((int) $r['printers_bad'] > 0)  $why[] = (int) $r['printers_bad'] . ' yazıcı hata verdi';
    if ((int) $r['print_pending'] > 5) $why[] = (int) $r['print_pending'] . ' yazdırma işi bekliyor';
    if ($r['disk_free_mb'] !== null && (int) $r['disk_free_mb'] < 2048) $why[] = 'disk doluyor';
    if ($r['last_close_date'] && strtotime((string) $r['last_close_date']) < strtotime('-2 days')) {
        $why[] = 'gün sonu ' . (int) floor((time() - strtotime((string) $r['last_close_date'])) / 86400) . ' gündür kapanmadı';
    }
    if ($why) return ['bad', 'ilgi bekliyor', implode(' · ', $why)];
    return ['ok', 'sorun görünmüyor', 'Son belgede dikkat çeken bir şey yok.'];
}

/** Counts for the list header. */
function teshis_summary(): array {
    $s = ['tills' => 0, 'reporting' => 0, 'unknown' => 0, 'bad' => 0, 'stale' => 0];
    foreach (teshis_list() as $r) {
        $s['tills']++;
        if ($r['received_at']) $s['reporting']++;
        $k = $r['health'][0];
        if (isset($s[$k])) $s[$k]++;
    }
    return $s;
}

/** MB as the panel prints it everywhere else. */
function teshis_mb(?int $mb): string {
    if ($mb === null) return '—';
    if ($mb >= 1024) return number_format($mb / 1024, 1, ',', '.') . ' GB';
    return number_format($mb, 0, ',', '.') . ' MB';
}
