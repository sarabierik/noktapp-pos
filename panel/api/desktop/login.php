<?php
/**
 * The till's online login. This is the only moment the restaurant needs the
 * internet to start working: we confirm who they are and hand back the licence,
 * which the PC then caches for the offline grace period.
 */
require_once __DIR__ . '/../../lib/api.php';
$in = json_in();
rate_limit('login', 20, 300);

$email = strtolower(trim((string)($in['email'] ?? '')));
$pass  = (string)($in['password'] ?? '');
if ($email === '' || $pass === '') fail('E-posta ve sifre gerekli', 400);

$t = one('SELECT * FROM np_tenants WHERE email = ?', [$email]);
$ok = $t && password_verify($pass, $t['password_hash']);
q('INSERT INTO np_login_attempts (email, ip, ok) VALUES (?,?,?)',
  [$email, $_SERVER['REMOTE_ADDR'] ?? null, $ok ? 1 : 0]);

if (!$ok) fail('E-posta veya sifre hatali', 401);
if (!$t['is_active']) fail('Hesabiniz pasif. Lutfen bizimle iletisime gecin.', 403);

$lic = one('SELECT * FROM np_licences WHERE tenant_id = ? ORDER BY id DESC LIMIT 1', [$t['id']]);
if (!$lic) fail('Bu hesap icin tanimli lisans yok', 403);
if ($lic['status'] === 'suspended') fail('Lisansiniz askiya alinmis', 403);
if ($lic['expires_at'] && strtotime($lic['expires_at']) < time()) {
    q("UPDATE np_licences SET status='expired' WHERE id=?", [$lic['id']]);
    fail('Lisansinizin suresi dolmus', 403);
}

// count the machines this licence is already on
$deviceId = substr((string)($in['device_id'] ?? ''), 0, 64);
if ($deviceId !== '') {
    $known = (int) val('SELECT COUNT(*) FROM np_devices WHERE tenant_id=? AND device_id<>? AND is_blocked=0
                        AND last_seen_at > DATE_SUB(NOW(), INTERVAL 30 DAY)', [$t['id'], $deviceId]);
    if ($known >= (int)$lic['seats']) {
        fail('Lisansiniz ' . (int)$lic['seats'] . ' bilgisayar icin gecerli. Yeni kurulum icin bizimle iletisime gecin.', 403);
    }
}
touch_device((int)$t['id'], $in);
$GLOBALS['np_actor'] = $email;
audit('desktop.login', $t['company_name'], ['device' => $deviceId]);

out([
    'ok' => true,
    'client' => [
        'id' => (int)$t['id'], 'slug' => $t['code'], 'company_name' => $t['company_name'],
        'owner_name' => $t['owner_name'], 'email' => $t['email'], 'phone' => $t['phone'],
        'tax_number' => $t['tax_number'], 'tax_office' => $t['tax_office'], 'address' => $t['address'],
    ],
    'user' => ['id' => 0, 'display_name' => $t['owner_name'] ?: $t['company_name'], 'role' => 'admin'],
    'licence' => licence_payload(array_merge($t, [
        'licence_key' => $lic['licence_key'], 'lic_status' => $lic['status'], 'plan' => $lic['plan'],
        'seats' => $lic['seats'], 'features' => $lic['features'], 'expires_at' => $lic['expires_at'],
        'grace_days' => $lic['grace_days'],
    ])),
]);
