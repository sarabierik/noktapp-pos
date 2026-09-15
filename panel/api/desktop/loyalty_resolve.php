<?php
/**
 * "Who is this?" — the till's only loyalty question for us.
 *
 * Guests are global to the platform: one person, one QR, usable at any
 * NOKTApp restaurant, and they are exactly the rows the Pass app already
 * writes. A till asks here only when it meets someone it has not served
 * before; after that the guest is cached on that PC and recognised with the
 * internet unplugged.
 *
 * We answer with the person, never with their card balances at other
 * restaurants — those are none of this restaurant's business.
 *
 * A one-time code is NOT burned here. The till burns it locally when the
 * stamps are actually written, so a lost reply cannot cost the guest a scan.
 */
require_once __DIR__ . '/../../lib/api.php';
$in = json_in();
$t  = require_licence($in);

$token = trim((string)($in['token'] ?? ''));
if ($token === '') fail('token gerekli');

$pass = pass_db();
if (!$pass) fail('Sadakat veritabani tanimli degil', 503);

function np_tr_phone(string $raw): string {
    $d = preg_replace('/\D+/', '', $raw) ?? '';
    if (strlen($d) === 12 && strncmp($d, '90', 2) === 0) $d = substr($d, 2);
    if (strlen($d) === 11 && $d[0] === '0')              $d = substr($d, 1);
    return $d;
}

$row = null;
try {
    if (preg_match('/^[a-f0-9]{64}$/i', $token)) {
        // a one-time code the guest's app just generated
        $s = $pass->prepare("SELECT customer_id FROM loyalty_qr_tokens
                              WHERE token = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1");
        $s->execute([strtolower($token)]);
        $cid = (int)($s->fetchColumn() ?: 0);
        if ($cid) {
            $s2 = $pass->prepare("SELECT * FROM customers WHERE id = ? AND COALESCE(is_active,1)=1 LIMIT 1");
            $s2->execute([$cid]);
            $row = $s2->fetch() ?: null;
        }
    } elseif (preg_match('/^\+?\d[\d\s\-()]{6,19}$/', $token)) {
        $p = np_tr_phone($token);
        $variants = array_values(array_unique([$p, '0' . $p, '90' . $p, '+90' . $p]));
        $in_ = implode(',', array_fill(0, count($variants), '?'));
        $s = $pass->prepare("SELECT * FROM customers WHERE phone IN ($in_)
                              AND COALESCE(is_active,1)=1 LIMIT 1");
        $s->execute($variants);
        $row = $s->fetch() ?: null;
    } else {
        // a permanent printed card
        $s = $pass->prepare("SELECT * FROM customers WHERE qr_uid = ? AND COALESCE(is_active,1)=1 LIMIT 1");
        $s->execute([$token]);
        $row = $s->fetch() ?: null;
    }
} catch (Throwable $e) {
    error_log('loyalty_resolve: ' . $e->getMessage());
    fail('Sadakat sorgusu yapilamadi', 502);
}

if (!$row) out(['ok' => true, 'customer' => null]);

audit('loyalty.resolve', $t['company_name'], ['customer' => (int)$row['id']]);
out(['ok' => true, 'customer' => [
    'id'          => (int)$row['id'],
    'first_name'  => $row['first_name'] ?? '',
    'last_name'   => $row['last_name'] ?? null,
    'phone'       => np_tr_phone((string)($row['phone'] ?? '')),
    'email'       => $row['email'] ?? null,
    'birth_date'  => $row['birth_date'] ?? null,
    'qr_uid'      => $row['qr_uid'] ?? null,
    'is_verified' => (int)($row['is_verified'] ?? 0),
]]);
