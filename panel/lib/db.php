<?php
/** Single PDO handle for the whole panel. */
function cfg(?string $key = null) {
    static $cfg = null;
    if ($cfg === null) $cfg = require __DIR__ . '/config.php';
    if ($key === null) return $cfg;
    $parts = explode('.', $key);
    $cur = $cfg;
    foreach ($parts as $p) { if (!isset($cur[$p])) return null; $cur = $cur[$p]; }
    return $cur;
}

/**
 * The clock.
 *
 * This is a Turkish product sold to Turkish restaurants, and the panel was
 * running on whatever timezone the hosting account happened to have - a US
 * one. Nothing crashed; the times were simply wrong by seven hours on every
 * screen. A backup that arrived at 10:32 in Alanya was listed as 03:32, and
 * the restaurant owner reading "gün sonu 04.09" for a day he closed on the 5th
 * has no way to tell whether the panel is confused or he is.
 *
 * Both halves have to agree, so both are set from ONE value: PHP formats in
 * this zone and MariaDB writes NOW() in it. Setting only one is worse than
 * setting neither - the relative times ("az önce", and the thresholds the
 * alert rules fire on) are differences between the two, and they are only
 * correct while the two clocks match.
 *
 * The offset is derived rather than typed: a named zone is not guaranteed to
 * be loaded in MariaDB on shared hosting, and a hard-coded '+03:00' would be
 * a second place to edit for anyone who is not in Turkey. Set 'timezone' in
 * config.php to move both.
 */
function panel_timezone(): string {
    static $tz = null;
    if ($tz === null) {
        $tz = (string) (cfg('timezone') ?: 'Europe/Istanbul');
        try { date_default_timezone_set($tz); }
        catch (Throwable $e) { $tz = 'Europe/Istanbul'; date_default_timezone_set($tz); }
    }
    return $tz;
}

function db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $c = cfg('db');
        $tz = panel_timezone();
        $pdo = new PDO(
            "mysql:host={$c['host']};port=" . ($c['port'] ?? 3306) . ";dbname={$c['name']};charset={$c['charset']}",
            $c['user'], $c['pass'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
             PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
             PDO::ATTR_EMULATE_PREPARES => false]
        );
        /* Same zone as PHP, as an offset so no timezone table is needed. A
           server that refuses even that is left on its own clock rather than
           taken down: a wrong hour is a nuisance, a panel that will not open
           is an outage. */
        try {
            $off = (new DateTime('now', new DateTimeZone($tz)))->format('P');
            $pdo->exec("SET time_zone = '" . $off . "'");
        } catch (Throwable $e) { /* keep the connection */ }
    }
    return $pdo;
}

/** The shared loyalty database. Returns null when it is not configured. */
function pass_db(): ?PDO {
    static $pdo = false;
    if ($pdo !== false) return $pdo;
    $c = cfg('pass_db');
    if (!$c || empty($c['name'])) return $pdo = null;
    try {
        $pdo = new PDO(
            "mysql:host={$c['host']};port=" . ($c['port'] ?? 3306) . ";dbname={$c['name']};charset=utf8mb4",
            $c['user'], $c['pass'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
             PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
             PDO::ATTR_EMULATE_PREPARES => false]
        );
    } catch (Throwable $e) {
        error_log('pass_db: ' . $e->getMessage());
        $pdo = null;
    }
    return $pdo;
}

function q(string $sql, array $p = []): PDOStatement {
    $st = db()->prepare($sql);
    $st->execute($p);
    return $st;
}
function one(string $sql, array $p = []) { $r = q($sql, $p)->fetch(); return $r === false ? null : $r; }
function all(string $sql, array $p = []): array { return q($sql, $p)->fetchAll(); }
function val(string $sql, array $p = []) { $r = q($sql, $p)->fetch(PDO::FETCH_NUM); return $r === false ? null : $r[0]; }
function lastId() { return (int) db()->lastInsertId(); }

/**
 * Does np_audit carry the tenant_id column yet?
 *
 * sql/panel_ops_schema.sql adds it, and a panel whose code has been updated
 * ahead of its migration must keep working - api/desktop/* calls audit() on
 * every licence check, and a failed INSERT there would take a restaurant off
 * the air over a bookkeeping column. Asked once per request, then cached.
 */
function audit_has_tenant(): bool {
    static $has = null;
    if ($has !== null) return $has;
    try { $has = (bool) db()->query("SHOW COLUMNS FROM np_audit LIKE 'tenant_id'")->fetch(); }
    catch (Throwable $e) { $has = false; }
    return $has;
}

function audit(string $action, ?string $subject = null, $detail = null, ?int $tenantId = null): void {
    $actor = $_SESSION['admin']['email'] ?? ($GLOBALS['np_actor'] ?? 'system');
    $detail = is_string($detail) ? $detail : json_encode($detail, JSON_UNESCAPED_UNICODE);
    $ip = $_SERVER['REMOTE_ADDR'] ?? null;
    if ($tenantId !== null && audit_has_tenant()) {
        q('INSERT INTO np_audit (actor, action, subject, detail, ip, tenant_id) VALUES (?,?,?,?,?,?)',
          [$actor, $action, $subject, $detail, $ip, $tenantId]);
        return;
    }
    q('INSERT INTO np_audit (actor, action, subject, detail, ip) VALUES (?,?,?,?,?)',
      [$actor, $action, $subject, $detail, $ip]);
}

/*
 * Set PHP's clock as soon as this file is included, so a page that formats a
 * date before it ever runs a query is in the same zone as one that does.
 *
 * Guarded, because setup.php includes this file BEFORE config.php exists -
 * the wizard's whole job is to write it. A missing config here must leave the
 * wizard working, not fatal on line one.
 */
try { panel_timezone(); } catch (Throwable $e) { @date_default_timezone_set('Europe/Istanbul'); }
