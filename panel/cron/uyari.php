<?php
/**
 * The alert cron endpoint.
 *
 * cPanel calls this once an hour. It evaluates every active rule and sends
 * what has not already been sent (see lib/uyari.php for the de-duplication,
 * which is the whole point).
 *
 * ---------------------------------------------------------------------------
 * THE SECRET IS A HEADER. IT IS NEVER A QUERY PARAMETER.
 * ---------------------------------------------------------------------------
 * A secret in a URL is written down by everything it passes: the browser
 * history if it is ever pasted, the hosting account's access log, the proxy in
 * front of it, the Referer header of anything the page later links to, and the
 * cPanel cron list itself where it sits in plain sight next to the job. A
 * header is written down by none of those. So the key is read from
 * X-NP-Alert-Key and from nowhere else - and this file goes further than
 * ignoring the query string: a request that carries the secret in the URL is
 * REFUSED, loudly, because that URL has already leaked and quietly doing the
 * work would teach whoever wrote it that it was fine.
 *
 * Safe to call more often than intended, three ways over:
 *   - a wrong or missing key does nothing at all and answers 401;
 *   - a correct key inside the throttle window does nothing and answers 200
 *     with throttled:true, so a monitoring service that polls every minute
 *     costs one SELECT;
 *   - and even with the throttle disabled, np_alert_sent means a second run
 *     sends nothing a first run already sent.
 *
 * It answers JSON and never HTML: whatever calls this is a program, and a PHP
 * warning rendered into a cron mail is how a broken cron stays broken for a
 * month.
 */
require_once __DIR__ . '/../lib/db.php';
require_once __DIR__ . '/../lib/uyari.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
/* Nothing here is for a browser, a search engine or a cache. */
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

function cron_out(array $data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

/* An unconfigured panel must not be a door. uyari_secret() would happily mint
   one, but minting it HERE would mean the first anonymous request creates the
   credential it is about to be checked against on the next try. */
try {
    $secret = (string) np_setting('alert_cron_secret', '');
} catch (Throwable $e) {
    cron_out(['ok' => false, 'error' => 'panel_not_ready'], 503);
}
if ($secret === '') {
    cron_out(['ok' => false, 'error' => 'not_configured',
              'hint' => 'Panel > Uyarılar ekranını bir kez açın; anahtar orada üretilir.'], 503);
}

/*
 * The URL check comes FIRST, before the header is even looked at.
 *
 * Two things are refused: a parameter named like a key (whatever its value -
 * somebody is trying), and any parameter whose value IS the secret (the key
 * has leaked into a log, and the honest answer is to fail so it gets fixed).
 * Compared with hash_equals so the refusal itself cannot be used to guess.
 */
$leaky = ['key', 'secret', 'token', 'anahtar', 'k', 'auth', 'apikey', 'api_key'];
foreach ($_GET as $k => $v) {
    $bad = in_array(strtolower((string) $k), $leaky, true);
    if (!$bad && is_string($v) && $v !== '' && hash_equals($secret, $v)) $bad = true;
    if ($bad) {
        cron_out(['ok' => false, 'error' => 'secret_in_url',
                  'hint' => 'Anahtar yalnızca ' . UYARI_HEADER . ' başlığı ile gönderilir. '
                          . 'Adres satırına yazılan anahtar sızmış sayılır; panelden yenileyin.'], 400);
    }
}

/* PHP publishes any header as HTTP_<NAME>; some CGI setups also pass it
   through mod_rewrite's REDIRECT_ prefix, which is what a cPanel account
   using the .htaccess https redirect looks like. */
$hdr = strtoupper(str_replace('-', '_', UYARI_HEADER));
$given = $_SERVER['HTTP_' . $hdr] ?? $_SERVER['REDIRECT_HTTP_' . $hdr] ?? '';
if (!is_string($given) || $given === '' || !hash_equals($secret, $given)) {
    /* No detail on WHY. A caller with the right key does not need it and a
       caller without one is not owed it. */
    cron_out(['ok' => false, 'error' => 'unauthorised'], 401);
}

$GLOBALS['np_actor'] = 'cron';
try {
    $rep = uyari_run();
} catch (Throwable $e) {
    error_log('uyari cron: ' . $e->getMessage());
    cron_out(['ok' => false, 'error' => 'run_failed'], 500);
}
cron_out($rep, 200);
