<?php
/**
 * Shared helpers for the desktop API.
 * Every desktop call carries the client_id plus the licence key; that pair is
 * the authentication. Nothing here trusts anything else the client sends.
 */
require_once __DIR__ . '/db.php';

function json_in(): array {
    $raw = file_get_contents('php://input');
    $d = json_decode($raw, true);
    return is_array($d) ? $d : [];
}

function out($data, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(string $msg, int $status = 400): void { out(['ok' => false, 'error' => $msg], $status); }

/** Resolve and validate the calling installation. Returns the tenant row. */
function require_licence(array $in): array {
    $clientId = (int) ($in['client_id'] ?? 0);
    $key = trim((string) ($in['licence_key'] ?? ''));
    if (!$clientId || $key === '') fail('Lisans bilgisi eksik', 401);
    $row = one(
        'SELECT t.*, l.licence_key, l.status AS lic_status, l.plan, l.seats, l.features,
                l.expires_at, l.grace_days
           FROM np_tenants t JOIN np_licences l ON l.tenant_id = t.id
          WHERE t.id = ? AND l.licence_key = ?', [$clientId, $key]);
    if (!$row) fail('Lisans dogrulanamadi', 401);
    if (!$row['is_active']) fail('Hesap pasif durumda', 403);
    if ($row['lic_status'] === 'suspended') fail('Lisans askiya alinmis', 403);
    return $row;
}

/**
 * Record that a till was here.
 *
 * Seven endpoints call this, and they do NOT all send the same fields. The
 * heartbeat and the login carry `app_version` and `device_name`; the relay
 * poll, the backup upload, the menu pull and the sync do not - they only need
 * to identify the device. The old version wrote VALUES(app_version)
 * unconditionally, so the relay poller - which runs every few seconds -
 * overwrote the version the heartbeat had just recorded with NULL, seconds
 * later, for ever.
 *
 * The visible result was the whole update-distribution feature reading blank:
 * "—" in the Sürüm column on Kasalar and Kasa teşhis, "bildirmedi" in the
 * adoption chart, and the "eski sürüm" alert rule that could never fire
 * because nobody was ever on a known version. Nothing was wrong on the till;
 * it had been reporting correctly all along.
 *
 * So: a field the request does not carry leaves the stored one alone. Only
 * `last_ip` and `last_seen_at`, which every caller genuinely knows, are
 * written every time.
 */
function touch_device(int $tenantId, array $in): void {
    $deviceId = substr((string) ($in['device_id'] ?? ''), 0, 64);
    if ($deviceId === '') return;
    q('INSERT INTO np_devices (tenant_id, device_id, device_name, app_version, last_ip, last_seen_at)
       VALUES (?,?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE device_name=COALESCE(VALUES(device_name), device_name),
           app_version=COALESCE(VALUES(app_version), app_version),
           last_ip=VALUES(last_ip), last_seen_at=NOW()',
      [$tenantId, $deviceId, substr((string)($in['device_name'] ?? ''), 0, 160) ?: null,
       substr((string)($in['app_version'] ?? ''), 0, 32) ?: null, $_SERVER['REMOTE_ADDR'] ?? null]);
}

function licence_payload(array $t): array {
    return [
        'key'        => $t['licence_key'],
        'status'     => $t['lic_status'] === 'trial' ? 'active' : $t['lic_status'],
        'plan'       => $t['plan'],
        'seats'      => (int) $t['seats'],
        'features'   => json_decode($t['features'] ?: '{}', true) ?: new stdClass(),
        'expires_at' => $t['expires_at'],
        'grace_days' => (int) $t['grace_days'],
    ];
}

function rate_limit(string $bucket, int $max, int $seconds): void {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    $n = (int) val('SELECT COUNT(*) FROM np_login_attempts WHERE ip=? AND ok=0 AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)',
        [$ip, $seconds]);
    if ($n >= $max) fail('Cok fazla deneme yapildi. Biraz sonra tekrar deneyin.', 429);
}
