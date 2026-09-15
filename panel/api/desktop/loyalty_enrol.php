<?php
/**
 * Enrol a guest from the till.
 *
 * The guest registry is shared by every restaurant and by the Pass app, so the
 * identity is minted here and nowhere else — that is the whole reason a card
 * earned at one shop is recognised at the next one.
 *
 * A number that already exists is returned as-is rather than duplicated: the
 * person may have signed up in the app years ago and simply not mentioned it.
 */
require_once __DIR__ . '/../../lib/api.php';
$in = json_in();
$t  = require_licence($in);

$pass = pass_db();
if (!$pass) fail('Sadakat veritabani tanimli degil', 503);

function np_tr_phone(string $raw): string {
    $d = preg_replace('/\D+/', '', $raw) ?? '';
    if (strlen($d) === 12 && strncmp($d, '90', 2) === 0) $d = substr($d, 2);
    if (strlen($d) === 11 && $d[0] === '0')              $d = substr($d, 1);
    return $d;
}

$phone = np_tr_phone((string)($in['phone'] ?? ''));
$first = trim((string)($in['first_name'] ?? ''));
if (!preg_match('/^5\d{9}$/', $phone)) fail('Telefon 5 ile baslayan 10 hane olmali');
if ($first === '') fail('Ad zorunlu');

try {
    $variants = array_values(array_unique([$phone, '0' . $phone, '90' . $phone, '+90' . $phone]));
    $ph = implode(',', array_fill(0, count($variants), '?'));
    $s = $pass->prepare("SELECT * FROM customers WHERE phone IN ($ph) LIMIT 1");
    $s->execute($variants);
    $row = $s->fetch() ?: null;

    if (!$row) {
        $qr = bin2hex(random_bytes(16));
        $ins = $pass->prepare(
            "INSERT INTO customers (first_name, last_name, phone, email, qr_uid,
                is_verified, is_active, created_by_client_id, created_at, updated_at)
             VALUES (?,?,?,?,?,0,1,?,NOW(),NOW())");
        $ins->execute([$first, $in['last_name'] ?: null, $phone, $in['email'] ?: null, $qr, (int)$t['id']]);
        $id = (int)$pass->lastInsertId();
        $s2 = $pass->prepare("SELECT * FROM customers WHERE id=?");
        $s2->execute([$id]);
        $row = $s2->fetch();
        audit('loyalty.enrol', $t['company_name'], ['customer' => $id, 'phone' => $phone]);
    } elseif (empty($row['qr_uid'])) {
        // an older record that never got a card code
        $qr = bin2hex(random_bytes(16));
        $pass->prepare("UPDATE customers SET qr_uid=? WHERE id=?")->execute([$qr, (int)$row['id']]);
        $row['qr_uid'] = $qr;
    }
} catch (Throwable $e) {
    error_log('loyalty_enrol: ' . $e->getMessage());
    fail('Musteri kaydedilemedi', 502);
}

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
