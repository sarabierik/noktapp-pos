<?php
/** Sending a guest their bill when the restaurant has no mail account of its own. */
require_once __DIR__ . '/../../lib/api.php';
$in = json_in();
$t = require_licence($in);

$to = filter_var((string)($in['to'] ?? ''), FILTER_VALIDATE_EMAIL);
if (!$to) fail('Gecersiz e-posta adresi');
$subject = substr((string)($in['subject'] ?? 'Adisyon'), 0, 190);
$html = (string)($in['html'] ?? '');
$att = $in['attachment'] ?? null;

$from = cfg('mail.from');
$fromName = cfg('mail.from_name');
$boundary = 'np' . bin2hex(random_bytes(8));

$headers  = "From: {$fromName} <{$from}>\r\n";
$headers .= "Reply-To: {$t['email']}\r\n";
$headers .= "MIME-Version: 1.0\r\n";
$headers .= "Content-Type: multipart/mixed; boundary=\"{$boundary}\"\r\n";

$body  = "--{$boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n";
$body .= "Content-Transfer-Encoding: 8bit\r\n\r\n{$html}\r\n";
if ($att && !empty($att['content'])) {
    $fname = preg_replace('/[^A-Za-z0-9._-]/', '', (string)($att['filename'] ?? 'adisyon.pdf'));
    $body .= "--{$boundary}\r\nContent-Type: application/pdf; name=\"{$fname}\"\r\n";
    $body .= "Content-Transfer-Encoding: base64\r\n";
    $body .= "Content-Disposition: attachment; filename=\"{$fname}\"\r\n\r\n";
    $body .= chunk_split((string)$att['content']) . "\r\n";
}
$body .= "--{$boundary}--";

$ok = @mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', $body, $headers, '-f' . $from);
if (!$ok) fail('E-posta gonderilemedi', 502);
audit('mail.bill', $t['company_name'], ['to' => $to]);
out(['ok' => true]);
