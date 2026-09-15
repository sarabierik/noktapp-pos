<?php
/**
 * NOKTApp POS panel - configuration.
 * Edit the literal values to match the cPanel account; nothing else in the
 * panel needs changing. (The getenv() calls exist only so the automated tests
 * can point the same code at a sandbox database - leave them alone.)
 */
return [
    /* Both PHP and MariaDB run on this zone - see panel_timezone() in lib/db.php. */
    'timezone' => getenv('NP_TZ') ?: 'Europe/Istanbul',

    'db' => [
        'host' => getenv('NP_DB_HOST') ?: 'localhost',
        'name' => getenv('NP_DB_NAME') ?: 'tecofi_nokpos_panel',
        'user' => getenv('NP_DB_USER') ?: 'tecofi_nokpos_panel',
        'pass' => getenv('NP_DB_PASS') ?: 'BURAYA_SIFRE',
        'port' => (int)(getenv('NP_DB_PORT') ?: 3306),
        'charset' => 'utf8mb4',
    ],
    /*
     * The sadakat (loyalty) database.
     *
     * This is the SAME database pass.noktapp.com already uses - tecofi_nokpos.
     * Pass was moved onto it precisely so a guest who signs up in the app is
     * visible at the till, and nothing here changes that: the guest registry
     * and the one-time QR codes stay exactly where they are, still read and
     * written by the Pass app.
     *
     * What changed is the till. Each restaurant now runs its own copy of the
     * operating tables on its own PC, so it asks here once when it meets a
     * guest it has not served before, caches them, and from then on recognises
     * them with the internet unplugged. Stamps are written locally first and
     * mirrored back here afterwards, so the guest's app shows the same numbers
     * without the counter ever waiting on our server.
     *
     * Leave 'name' empty to turn the loyalty lookup off entirely.
     */
    'pass_db' => [
        'host' => getenv('NP_PASS_HOST') ?: 'localhost',
        'port' => (int)(getenv('NP_PASS_PORT') ?: 3306),
        'name' => getenv('NP_PASS_NAME') ?: 'tecofi_nokpos',
        'user' => getenv('NP_PASS_USER') ?: 'tecofi_nokpos',
        'pass' => getenv('NP_PASS_PASS') ?: 'BURAYA_SIFRE',
    ],

    // where nightly backups land; keep it OUTSIDE public_html
    'backup_dir' => getenv('NP_BACKUP_DIR') ?: dirname(__DIR__, 2) . '/noktapp-backups',
    // where the Windows installer files live (served by /indir)
    'release_dir' => __DIR__ . '/../indir',
    'mail' => [
        'from'      => 'noreply@noktapp.com',
        'from_name' => 'NOKTApp POS',
        'host'      => 'pos.noktapp.com',
        'port'      => 465,
        'secure'    => true,
        'user'      => 'noreply@noktapp.com',
        'pass'      => 'BURAYA_MAIL_SIFRE',
    ],
    'app' => [
        'name'         => 'NOKTApp POS',
        'base_url'     => 'https://pos.noktapp.com',
        'relay_ttl'    => 120,   // seconds a queued phone request stays valid
        'backup_keep'  => 30,    // days of cloud backups per tenant
        'session_name' => 'nokpos_panel',
    ],
];
