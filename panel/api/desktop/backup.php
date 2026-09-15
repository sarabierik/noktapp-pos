<?php
/** The nightly backup upload. One file per night per restaurant, kept for a
 *  month, stored outside public_html so nobody can fetch it over the web. */
require_once __DIR__ . '/../../lib/api.php';
$in = json_in();
$t = require_licence($in);
touch_device((int)$t['id'], $in);

$name = preg_replace('/[^A-Za-z0-9._-]/', '', (string)($in['filename'] ?? ''));
$data = (string)($in['data'] ?? '');
if ($name === '' || $data === '') fail('Dosya bilgisi eksik');

$bin = base64_decode($data, true);
if ($bin === false) fail('Dosya cozulemedi');
if (!empty($in['sha256']) && hash('sha256', $bin) !== $in['sha256']) fail('Dosya bozuk geldi (sha256 uyusmadi)');

$dir = rtrim(cfg('backup_dir'), '/') . '/' . $t['id'];
if (!is_dir($dir) && !mkdir($dir, 0770, true)) fail('Yedek klasoru olusturulamadi', 500);
$path = $dir . '/' . $name;
if (file_put_contents($path, $bin) === false) fail('Yedek yazilamadi', 500);

q('INSERT INTO np_backups (tenant_id, device_id, filename, path, size_bytes, sha256)
   VALUES (?,?,?,?,?,?)',
  [$t['id'], substr((string)($in['device_id'] ?? ''), 0, 64), $name, $path, strlen($bin), $in['sha256'] ?? null]);

// keep only the agreed number of days
$keep = (int) cfg('app.backup_keep');
$old = all('SELECT id, path FROM np_backups WHERE tenant_id=? AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
    [$t['id'], $keep]);
foreach ($old as $o) { @unlink($o['path']); q('DELETE FROM np_backups WHERE id=?', [$o['id']]); }

out(['ok' => true, 'stored' => $name, 'size' => strlen($bin)]);
