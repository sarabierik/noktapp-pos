<?php
/**
 * electron-updater feed. The desktop app reads /indir/latest.yml; this file
 * generates it from whatever version the panel marks as current, so publishing
 * an update is one form submission and one file upload.
 *
 * IT REFUSES TO SERVE A HALF-BUILT FEED, and that is the point of the checks
 * below. A real till logged this on every start for a week:
 *
 *   updater: Update info doesn't contain nor sha256 neither sha512 checksum:
 *   { "url": "NoktApp-POS-Kurulum-3.5.6.exe", "sha512": null, "size": 0 }
 *
 * because the row was marked current while the .exe had never been uploaded, so
 * there was nothing to hash and nothing to measure. Serving `sha512:` with
 * nothing after it does not fail politely - electron-updater errors, every
 * till, every check, for ever, and the error names a checksum rather than the
 * missing file, so nobody reads it as "you did not upload the installer".
 *
 * A feed that cannot be built correctly is not published at all: the updater
 * then simply finds no update, which is the truth.
 */
require_once __DIR__ . '/../lib/db.php';

header('Content-Type: text/yaml; charset=utf-8');

$v = one('SELECT * FROM np_versions WHERE is_current=1 AND channel="stable" ORDER BY released_at DESC LIMIT 1');
if (!$v) { echo "# no release published\n"; exit; }

/* electron-updater parses this with semver and rejects anything else - a
   trailing dot from a mistyped form field ("3.5.1.") is enough. */
$version = trim((string) $v['version']);
if (!preg_match('/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/', $version)) {
    echo "# current release has an invalid version: " . htmlspecialchars($version, ENT_QUOTES) . "\n";
    exit;
}

$path = rtrim(cfg('release_dir'), '/') . '/' . basename((string) $v['filename']);
$size = (int) ($v['size_bytes'] ?: (is_file($path) ? filesize($path) : 0));
$sha  = (string) ($v['sha512'] ?: (is_file($path) ? base64_encode(hash_file('sha512', $path, true)) : ''));

if ($sha === '' || $size <= 0) {
    echo "# installer for {$version} is not on the server yet - upload "
       . basename((string) $v['filename']) . " to /indir\n";
    exit;
}
?>
version: <?= $version ?>

files:
  - url: <?= basename((string) $v['filename']) ?>

    sha512: <?= $sha ?>

    size: <?= $size ?>

path: <?= basename((string) $v['filename']) ?>

sha512: <?= $sha ?>

releaseDate: '<?= gmdate('c', strtotime($v['released_at'])) ?>'
