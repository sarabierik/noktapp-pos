<?php
/**
 * The guest side of the platform — everything the NOKTA phone app talks to.
 *
 * This is a DIFFERENT audience from the rest of api/: the desktop endpoints
 * authenticate a restaurant with client_id + licence_key, and every one of them
 * is talking to a machine we sold. Here the caller is a member of the public
 * holding a phone, and the only thing they own is a session token.
 *
 * Three rules that the desktop side does not need and this side lives or dies
 * by:
 *
 *  1. A guest sees their OWN rows and nothing else. Every query below filters
 *     on the customer id that came out of the token, never out of the request
 *     body. An endpoint that takes a customer_id from the caller is an
 *     endpoint that hands one guest another guest's card balances.
 *
 *  2. Tokens are stored HASHED. A session row is a bearer credential; a
 *     database dump that contains them is a dump that logs the attacker in as
 *     every guest at once. We keep sha256(token) and can therefore verify a
 *     token without ever being able to reproduce one.
 *
 *  3. Nothing here writes stamps. The till is the only thing that may move a
 *     balance, at the counter, with the guest present. This API reads the
 *     mirror, hands out one-time codes, and edits the guest's own profile.
 */
require_once __DIR__ . '/api.php';
require_once __DIR__ . '/pass_tables.php';

/* The app is a native client sending a bearer header, so there are no cookies
   to protect and no same-origin story to preserve. A permissive origin keeps a
   future web build of the same app working without a second API. */
function guest_cors(): void {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
    header('Vary: Origin');
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(204); exit; }
}

function guest_require_post(): void {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') fail('POST gerekli', 405);
}

/** One canonical shape for a Turkish mobile: 10 digits starting with 5. */
if (!function_exists('np_tr_phone')) {
    function np_tr_phone(string $raw): string {
        $d = preg_replace('/\D+/', '', $raw) ?? '';
        if (strlen($d) === 12 && strncmp($d, '90', 2) === 0) $d = substr($d, 2);
        if (strlen($d) === 11 && $d[0] === '0')              $d = substr($d, 1);
        return $d;
    }
}
function np_phone_variants(string $phone): array {
    return array_values(array_unique([$phone, '0' . $phone, '90' . $phone, '+90' . $phone]));
}

function guest_pass(): PDO {
    $pass = pass_db();
    if (!$pass) fail('Sadakat veritabani tanimli degil', 503);
    return $pass;
}

/**
 * The mirror tables, created on first use.
 *
 * The shapes live in lib/pass_tables.php because api/desktop/sync.php writes
 * the same tables and the two must not drift.
 */
function guest_tables(PDO $pass): void { pass_ensure_tables($pass); }

/**
 * Throttle by phone AND by address.
 *
 * Only by phone and one attacker walks the whole number space from one machine.
 * Only by address and a phone behind a carrier NAT locks out a neighbourhood.
 * So: a tighter limit per number, a looser one per address, and only FAILED
 * attempts count — a guest who logs in correctly ten times is not an attack.
 */
function guest_throttle(PDO $pass, string $bucket, string $ident): void {
    guest_tables($pass);
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    $byIdent = $pass->prepare("SELECT COUNT(*) FROM np_guest_attempts
        WHERE bucket=? AND ident=? AND ok=0 AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)");
    $byIdent->execute([$bucket, $ident]);
    if ((int)$byIdent->fetchColumn() >= 5) {
        fail('Cok fazla deneme yapildi. 15 dakika sonra tekrar deneyin.', 429);
    }
    $byIp = $pass->prepare("SELECT COUNT(*) FROM np_guest_attempts
        WHERE bucket=? AND ip=? AND ok=0 AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)");
    $byIp->execute([$bucket, $ip]);
    if ((int)$byIp->fetchColumn() >= 40) {
        fail('Cok fazla deneme yapildi. Biraz sonra tekrar deneyin.', 429);
    }
}

function guest_attempt(PDO $pass, string $bucket, string $ident, bool $ok): void {
    guest_tables($pass);
    try {
        $pass->prepare("INSERT INTO np_guest_attempts (bucket, ident, ip, ok) VALUES (?,?,?,?)")
             ->execute([$bucket, substr($ident, 0, 120), $_SERVER['REMOTE_ADDR'] ?? null, $ok ? 1 : 0]);
    } catch (Throwable $e) { error_log('guest attempt log: ' . $e->getMessage()); }
}

/** Mint a session. The plain token is returned once and never stored. */
function guest_session_new(PDO $pass, int $customerId, string $deviceLabel = ''): array {
    guest_tables($pass);
    $token = bin2hex(random_bytes(32));
    $days  = 180;
    $pass->prepare("INSERT INTO np_guest_sessions (token_hash, customer_id, device_label, expires_at)
                    VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL ? DAY))")
         ->execute([hash('sha256', $token), $customerId, substr($deviceLabel, 0, 120) ?: null, $days]);
    /* Housekeeping on the way past, so expired rows do not accumulate for ever
       on a panel with no cron for this table. */
    try { $pass->exec("DELETE FROM np_guest_sessions WHERE expires_at < NOW()"); } catch (Throwable $e) {}
    return ['token' => $token, 'expires_in_days' => $days];
}

function guest_bearer(): string {
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if ($h === '' && function_exists('apache_request_headers')) {
        foreach (apache_request_headers() as $k => $v) {
            if (strcasecmp($k, 'Authorization') === 0) { $h = $v; break; }
        }
    }
    if (preg_match('/^Bearer\s+([a-f0-9]{64})$/i', trim($h), $m)) return strtolower($m[1]);
    return '';
}

/**
 * Who is calling? Returns the customer row, or 401.
 *
 * The token never appears in a URL or a query string — it arrives in the
 * Authorization header only, because a URL ends up in access logs, in
 * referrers and in the user's own history.
 */
function guest_auth(): array {
    $pass = guest_pass();
    guest_tables($pass);
    $token = guest_bearer();
    if ($token === '') fail('Oturum gerekli', 401);
    $st = $pass->prepare(
        "SELECT c.* FROM np_guest_sessions s
           JOIN customers c ON c.id = s.customer_id
          WHERE s.token_hash = ? AND s.expires_at > NOW() AND COALESCE(c.is_active,1)=1
          LIMIT 1");
    $st->execute([hash('sha256', $token)]);
    $row = $st->fetch() ?: null;
    if (!$row) fail('Oturum gecersiz veya sona ermis', 401);
    try {
        $pass->prepare("UPDATE np_guest_sessions SET last_seen_at=NOW() WHERE token_hash=?")
             ->execute([hash('sha256', $token)]);
    } catch (Throwable $e) {}
    $row['__token_hash'] = hash('sha256', $token);
    return $row;
}

/** The public shape of a guest. Never carries the password hash. */
function guest_public(array $c): array {
    return [
        'id'          => (int)$c['id'],
        'first_name'  => $c['first_name'] ?? '',
        'last_name'   => $c['last_name'] ?? null,
        'phone'       => np_tr_phone((string)($c['phone'] ?? '')),
        'email'       => $c['email'] ?? null,
        'birth_date'  => $c['birth_date'] ?? null,
        'qr_uid'      => $c['qr_uid'] ?? null,
        'is_verified' => (int)($c['is_verified'] ?? 0),
        'member_since'=> $c['created_at'] ?? null,
    ];
}

/**
 * Restaurant names for a set of tenant ids.
 *
 * The cards live in pass_db and the names live in the panel database — two
 * connections, so this cannot be one join. Asked once per request with the ids
 * the cards actually used, rather than per card.
 */
function guest_tenant_names(array $ids): array {
    $ids = array_values(array_unique(array_map('intval', array_filter($ids))));
    if (!$ids) return [];
    $in = implode(',', array_fill(0, count($ids), '?'));
    $out = [];
    foreach (all("SELECT id, company_name, city FROM np_tenants WHERE id IN ($in)", $ids) as $r) {
        $out[(int)$r['id']] = ['name' => $r['company_name'], 'city' => $r['city']];
    }
    return $out;
}

/**
 * Every card this guest holds, at every restaurant, with the campaign behind it.
 *
 * Two sources for the campaign text, and both are needed:
 *
 *   np_tenant_programs — desktop tills. Keyed (tenant, the till's local program
 *   id), because those ids auto-increment per PC and collide across
 *   restaurants.
 *
 *   loyalty_programs — the legacy web POS, which writes into this database
 *   directly and owns the ids in it. Joined on (id AND client_id), so a legacy
 *   row can only ever match its own tenant.
 *
 * A card whose campaign is missing from both is DROPPED, not shown as "?" — a
 * card with no campaign is exactly the bug this whole chain was built to fix,
 * and a restaurant that has not synced yet should look absent rather than
 * broken.
 */
function guest_cards(PDO $pass, int $customerId): array {
    pass_ensure_tables($pass);
    $legacy = pass_has_table($pass, 'loyalty_programs');
    $legacySelect = $legacy
        ? "lp.title AS lp_title, lp.target_count AS lp_target, lp.reward_text AS lp_reward,
           lp.is_active AS lp_active"
        : "NULL AS lp_title, NULL AS lp_target, NULL AS lp_reward, NULL AS lp_active";
    $legacyJoin = $legacy
        ? "LEFT JOIN loyalty_programs lp
                  ON lp.id = lc.program_id AND lp.client_id = lc.client_id"
        : "";
    $st = $pass->prepare(
        "SELECT lc.client_id AS tenant_id, lc.program_id, lc.progress_count,
                lc.rewards_available, lc.rewards_used, lc.updated_at,
                tp.title AS tp_title, tp.target_count AS tp_target, tp.reward_text AS tp_reward,
                tp.product_name AS tp_product, tp.product_price AS tp_price, tp.is_active AS tp_active,
                $legacySelect
           FROM loyalty_cards lc
           LEFT JOIN np_tenant_programs tp
                  ON tp.tenant_id = lc.client_id AND tp.program_id = lc.program_id
           $legacyJoin
          WHERE lc.customer_id = ?
          ORDER BY lc.updated_at DESC, lc.id DESC");
    $st->execute([$customerId]);
    $rows = $st->fetchAll();

    $names = guest_tenant_names(array_column($rows, 'tenant_id'));
    $cards = [];
    foreach ($rows as $r) {
        $title  = $r['tp_title']  ?? $r['lp_title'];
        if ($title === null || $title === '') continue;      // no campaign, no card
        $target = (int)($r['tp_target'] ?? $r['lp_target'] ?? 0);
        if ($target < 1) $target = 1;
        $active = $r['tp_active'] !== null ? (int)$r['tp_active'] : (int)($r['lp_active'] ?? 1);
        $tenant = (int)$r['tenant_id'];
        $progress = (int)$r['progress_count'];
        $cards[] = [
            'tenant_id'       => $tenant,
            'restaurant'      => $names[$tenant]['name'] ?? 'NOKTApp restorani',
            'city'            => $names[$tenant]['city'] ?? null,
            'program_id'      => (int)$r['program_id'],
            'title'           => $title,
            'reward_text'     => $r['tp_reward'] ?? $r['lp_reward'] ?? '',
            'product_name'    => $r['tp_product'] ?? null,
            'product_price'   => isset($r['tp_price']) && $r['tp_price'] !== null
                                 ? (float)$r['tp_price'] : null,
            'target_count'    => $target,
            'progress_count'  => $progress,
            /* progress_count is already the remainder the till left after the
               last rollover (addStampIn stores raw % target), so this is a
               subtraction and not a modulo. */
            'remaining'       => max(0, $target - $progress),
            'rewards_available' => (int)$r['rewards_available'],
            'rewards_used'    => (int)$r['rewards_used'],
            'is_active'       => $active ? 1 : 0,
            'updated_at'      => $r['updated_at'],
        ];
    }
    return $cards;
}
