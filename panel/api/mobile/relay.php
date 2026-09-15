<?php
/**
 * What the waiter's phone talks to when it cannot see the till on the local
 * network. The phone posts the request it would have sent over Wi-Fi; we park
 * it, the restaurant PC picks it up within a second or two, runs it locally and
 * sends the answer back through here.
 *
 * The phone's own token is passed straight through - the panel never inspects
 * it and never gets to act on the restaurant's data itself.
 */
require_once __DIR__ . '/../../lib/api.php';
@set_time_limit(60);
$in = json_in();

$tenantId = (int)($in['client_id'] ?? 0);
$path = (string)($in['path'] ?? '');
if (!$tenantId || $path === '') fail('client_id ve path gerekli');
if (!preg_match('#^/api/mobile/[A-Za-z0-9/_\-\.]{1,180}$#', $path)) fail('Bu adres relay uzerinden cagrilamaz', 400);

$t = one('SELECT t.id, t.is_active, l.status FROM np_tenants t
            JOIN np_licences l ON l.tenant_id=t.id WHERE t.id=? ORDER BY l.id DESC LIMIT 1', [$tenantId]);
if (!$t || !$t['is_active'] || $t['status'] === 'suspended') fail('Isletme bulunamadi', 404);

$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? ($in['authorization'] ?? '');
q('INSERT INTO np_relay_messages (tenant_id, method, path, body, authorization, device_id)
   VALUES (?,?,?,?,?,?)',
  [$tenantId, strtoupper((string)($in['method'] ?? 'POST')), $path,
   isset($in['body']) ? json_encode($in['body'], JSON_UNESCAPED_UNICODE) : null,
   substr((string)$auth, 0, 512), substr((string)($in['device_id'] ?? ''), 0, 64)]);
$id = lastId();

// wait for the PC to answer - up to 30 seconds, then tell the phone to retry
$deadline = time() + 30;
do {
    $row = one('SELECT status, answer_status, answer_body FROM np_relay_messages WHERE id=?', [$id]);
    if ($row && $row['status'] === 'answered') {
        http_response_code((int)$row['answer_status'] ?: 200);
        header('Content-Type: application/json; charset=utf-8');
        echo $row['answer_body'] ?: '{"ok":true}';
        exit;
    }
    usleep(500000);
} while (time() < $deadline);

fail('Kasa bilgisayarina ulasilamadi. Kasa acik mi?', 504);
