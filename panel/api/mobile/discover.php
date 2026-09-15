<?php
/** The phone asks "which restaurant am I paired with, and is its PC online?" */
require_once __DIR__ . '/../../lib/api.php';
$in = json_in();
$tenantId = (int)($in['client_id'] ?? 0);
if (!$tenantId) fail('client_id gerekli');
$t = one('SELECT t.id, t.company_name, t.is_active FROM np_tenants t WHERE t.id=?', [$tenantId]);
if (!$t) fail('Isletme bulunamadi', 404);
$dev = one('SELECT last_seen_at, app_version FROM np_devices WHERE tenant_id=? ORDER BY last_seen_at DESC LIMIT 1', [$tenantId]);
$online = $dev && strtotime($dev['last_seen_at']) > time() - 180;
out(['ok' => true, 'company_name' => $t['company_name'], 'pc_online' => $online,
     'last_seen' => $dev['last_seen_at'] ?? null, 'app_version' => $dev['app_version'] ?? null]);
