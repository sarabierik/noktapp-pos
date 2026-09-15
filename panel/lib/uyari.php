<?php
/**
 * UYARILAR - the rules, the de-duplication and the sender.
 *
 * The owner should learn that a licence expires in seven days without
 * remembering to open anything. An hourly cron on the hosting account calls
 * cron/uyari.php, which calls uyari_run() below.
 *
 * ---------------------------------------------------------------------------
 * DE-DUPLICATION IS THE FEATURE
 * ---------------------------------------------------------------------------
 * Working out that a licence expires on Friday is four lines of SQL. A cron
 * that only does that sends the same sentence 168 times over the week it is
 * warning about, the owner adds a mail rule to bin them, and from that morning
 * the alerts protect nothing. So every candidate carries a `subject_key` that
 * names the OCCASION rather than the rule, np_alert_sent has
 * UNIQUE(rule_id, tenant_id, subject_key), and the INSERT happens BEFORE the
 * e-mail:
 *
 *     INSERT IGNORE  ->  0 rows  ->  already said, say nothing
 *                    ->  1 row   ->  new, send it
 *
 * Insert-then-send and not send-then-insert, because two crons that overlap
 * (a slow run, an impatient owner pressing the button) would otherwise both
 * pass the check and both send. The database decides, once, and the loser of
 * the race sends nothing. When the send genuinely fails the row is REMOVED
 * again, so a mail server that was down for an hour costs a delay and not a
 * missed warning.
 *
 * Because subject_key is the occasion, a condition that clears and comes back
 * alerts again by construction: a renewed licence has a new expires_at, a till
 * that returns and later goes quiet has a new "last seen", a backup that
 * arrives ends one gap and starts the count on the next. Nothing here has a
 * "resolved" flag to maintain, and nothing ever deletes history to reset an
 * alert - deleting is what would let the same alert be sent twice.
 *
 * ---------------------------------------------------------------------------
 * E-MAIL ONLY
 * ---------------------------------------------------------------------------
 * Through the panel's existing mail configuration (lib/config.php's `mail`
 * block, read and never written). np_alert_rules.channel exists so WhatsApp
 * has somewhere to go the day the owner picks a provider; a rule on any other
 * channel is skipped and says so on screen, because building an integration
 * against a provider nobody has chosen means maintaining two of them.
 */
require_once __DIR__ . '/db.php';

/** The four kinds the contract defines, with what each one means on screen. */
function uyari_kinds(): array {
    return [
        'licence_expiring' => [
            'label' => 'Lisans bitiyor',
            'unit'  => 'gün kala',
            'help'  => 'Lisansın bitmesine bu kadar gün kalan her işletme için bir kez uyarır. '
                     . 'Lisans yenilenince bitiş tarihi değişir; bir sonraki dönem için yeniden uyarır.',
        ],
        'till_silent' => [
            'label' => 'Kasa sessiz',
            'unit'  => 'gündür bağlanmadı',
            'help'  => 'Kurulu olduğu hâlde bu kadar gündür panele hiç bağlanmayan kasalar. '
                     . 'Kasa geri döner ve sonra yeniden susarsa bu yeni bir olaydır, tekrar uyarır.',
        ],
        'backup_missing' => [
            'label' => 'Yedek gelmiyor',
            'unit'  => 'gündür yedek yok',
            'help'  => 'Kasası kurulu olduğu hâlde bu kadar gündür gecelik yedek göndermeyen işletmeler. '
                     . 'Bir yedek geldiğinde olay kapanır; sonraki boşluk yeniden uyarır.',
        ],
        'day_not_closed' => [
            'label' => 'Gün sonu kapanmıyor',
            'unit'  => 'gündür gün sonu yok',
            'help'  => 'Kasası çalıştığı hâlde bu kadar gündür gün sonu göndermeyen işletmeler. '
                     . 'Kasanın sessiz olması ayrı bir kuraldır; bu kural yalnızca ayakta olan kasalar içindir.',
        ],
    ];
}

/** Does this panel have the alert tables yet? */
function uyari_ready(): bool {
    static $ok = null;
    if ($ok !== null) return $ok;
    try { $ok = (bool) db()->query("SHOW TABLES LIKE 'np\\_alert\\_rules'")->fetch(); }
    catch (Throwable $e) { $ok = false; }
    return $ok;
}

/* ------------------------------------------------------------------ *
 * Panel settings (np_settings)
 * ------------------------------------------------------------------ */
function np_setting(string $k, ?string $default = null): ?string {
    try { $v = val('SELECT v FROM np_settings WHERE k=?', [$k]); }
    catch (Throwable $e) { return $default; }
    return $v === null ? $default : (string) $v;
}
function np_setting_set(string $k, ?string $v): void {
    q('INSERT INTO np_settings (k, v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)', [$k, $v]);
}

/**
 * The cron secret.
 *
 * Generated on first read rather than shipped, so two panels never share one,
 * and stored in the database rather than in config.php - config.php is not
 * edited on a live server and the owner has to be able to roll this from a
 * screen the morning it leaks.
 */
function uyari_secret(): string {
    $s = np_setting('alert_cron_secret');
    if (!$s) { $s = bin2hex(random_bytes(20)); np_setting_set('alert_cron_secret', $s); }
    return $s;
}
function uyari_roll_secret(): string {
    $s = bin2hex(random_bytes(20));
    np_setting_set('alert_cron_secret', $s);
    return $s;
}

/** The header the cron endpoint reads. Never a query parameter - see cron/uyari.php. */
const UYARI_HEADER = 'X-NP-Alert-Key';

/** The line the owner pastes into cPanel. */
function uyari_cron_line(): string {
    $url = rtrim((string) cfg('app.base_url'), '/') . '/cron/uyari.php';
    return '0 * * * * /usr/bin/curl -sS -m 60 -H "' . UYARI_HEADER . ': ' . uyari_secret() . '" '
         . $url . ' > /dev/null 2>&1';
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */
function uyari_rules(bool $activeOnly = false): array {
    $sql = 'SELECT * FROM np_alert_rules' . ($activeOnly ? ' WHERE is_active=1' : '') . ' ORDER BY id';
    return all($sql);
}
function uyari_rule(int $id): ?array { return one('SELECT * FROM np_alert_rules WHERE id=?', [$id]); }

/**
 * Who a rule's mail goes to. An empty target means every active administrator,
 * which is the sane default for a one-man business that later hires somebody.
 */
function uyari_recipients(array $rule): array {
    $t = trim((string) ($rule['target'] ?? ''));
    if ($t !== '') {
        $out = [];
        foreach (preg_split('/[,;\s]+/', $t) as $a) {
            $a = filter_var(trim($a), FILTER_VALIDATE_EMAIL);
            if ($a) $out[] = $a;
        }
        return $out;
    }
    return array_column(all('SELECT email FROM np_admins WHERE is_active=1 ORDER BY id'), 'email');
}

/* ------------------------------------------------------------------ *
 * The four evaluations
 *
 * Each returns rows of:
 *   tenant_id, company_name, subject_key, headline, detail[]
 * and nothing else. A candidate is a FACT, not a decision: whether it is
 * actually sent is settled afterwards by np_alert_sent, in one place, so a new
 * rule cannot accidentally invent its own idea of "already told him".
 * ------------------------------------------------------------------ */
function uyari_candidates(array $rule): array {
    $n = max(0, (int) $rule['threshold']);
    switch ($rule['kind']) {

        case 'licence_expiring':
            $rows = all("SELECT t.id tenant_id, t.company_name, t.code, l.expires_at, l.plan, l.status
                           FROM np_tenants t JOIN np_licences l ON l.tenant_id = t.id
                          WHERE t.is_active=1 AND l.status IN ('active','trial')
                            AND l.expires_at IS NOT NULL
                            AND l.expires_at >= NOW()
                            AND l.expires_at <= DATE_ADD(NOW(), INTERVAL ? DAY)
                       ORDER BY l.expires_at", [$n]);
            return array_map(function ($r) {
                $days = (int) floor((strtotime($r['expires_at']) - time()) / 86400);
                return [
                    'tenant_id'   => (int) $r['tenant_id'],
                    'company_name'=> $r['company_name'],
                    /* The expiry date itself. Renew the licence and this moves,
                       which is exactly when the customer deserves a new warning. */
                    'subject_key' => 'exp:' . date('Y-m-d', strtotime($r['expires_at'])),
                    'headline'    => $r['company_name'] . ' lisansı ' . max(0, $days) . ' gün sonra bitiyor',
                    'detail'      => [
                        'Bitiş tarihi: ' . date('d.m.Y', strtotime($r['expires_at'])),
                        'Paket: ' . ($r['plan'] ?: '—') . ' · Durum: ' . $r['status'],
                        'Müşteri kodu: ' . $r['code'],
                    ],
                ];
            }, $rows);

        case 'till_silent':
            $rows = all("SELECT t.id tenant_id, t.company_name, t.code,
                                MAX(d.last_seen_at) last_seen, COUNT(*) tills
                           FROM np_tenants t JOIN np_devices d ON d.tenant_id = t.id
                          WHERE t.is_active=1
                       GROUP BY t.id
                         HAVING last_seen IS NOT NULL
                            AND last_seen < DATE_SUB(NOW(), INTERVAL ? DAY)
                       ORDER BY last_seen", [$n]);
            return array_map(function ($r) {
                $days = (int) floor((time() - strtotime($r['last_seen'])) / 86400);
                return [
                    'tenant_id'   => (int) $r['tenant_id'],
                    'company_name'=> $r['company_name'],
                    /* The moment it went quiet. A till that comes back and later
                       goes quiet again has a different one - a new episode. */
                    'subject_key' => 'seen:' . date('Y-m-d H:i:s', strtotime($r['last_seen'])),
                    'headline'    => $r['company_name'] . ' kasası ' . $days . ' gündür bağlanmadı',
                    'detail'      => [
                        'Son bağlantı: ' . date('d.m.Y H:i', strtotime($r['last_seen'])),
                        'Kurulu kasa sayısı: ' . (int) $r['tills'],
                        'Müşteri kodu: ' . $r['code'],
                    ],
                ];
            }, $rows);

        case 'backup_missing':
            /* Only customers who actually have a till: a signed-up restaurant
               that has not installed anything yet has nothing to back up, and
               warning about it every week teaches the owner to ignore this. */
            $rows = all("SELECT * FROM (
                           SELECT t.id tenant_id, t.company_name, t.code,
                                  (SELECT MAX(b.created_at) FROM np_backups b WHERE b.tenant_id=t.id) last_backup
                             FROM np_tenants t
                            WHERE t.is_active=1
                              AND EXISTS (SELECT 1 FROM np_devices d WHERE d.tenant_id=t.id)
                         ) x
                          WHERE x.last_backup IS NULL
                             OR x.last_backup < DATE_SUB(NOW(), INTERVAL ? DAY)
                       ORDER BY x.last_backup IS NOT NULL, x.last_backup", [$n]);
            return array_map(function ($r) {
                $has = !empty($r['last_backup']);
                return [
                    'tenant_id'   => (int) $r['tenant_id'],
                    'company_name'=> $r['company_name'],
                    'subject_key' => 'bak:' . ($has ? date('Y-m-d', strtotime($r['last_backup'])) : 'hic'),
                    'headline'    => $r['company_name'] . ' yedek göndermiyor',
                    'detail'      => [
                        $has ? 'Son yedek: ' . date('d.m.Y H:i', strtotime($r['last_backup']))
                             : 'Bu işletmeden hiç yedek gelmedi.',
                        'Müşteri kodu: ' . $r['code'],
                    ],
                ];
            }, $rows);

        case 'day_not_closed':
            /* The till has to be demonstrably alive, otherwise this is just
               till_silent said a second way and the owner gets two e-mails
               about one dead computer. */
            $rows = all("SELECT * FROM (
                           SELECT t.id tenant_id, t.company_name, t.code,
                                  (SELECT MAX(d.last_seen_at) FROM np_devices d WHERE d.tenant_id=t.id) last_seen,
                                  (SELECT MAX(r.created_at) FROM np_reports r
                                    WHERE r.tenant_id=t.id AND r.entity='daily_closing') last_close
                             FROM np_tenants t
                            WHERE t.is_active=1
                         ) x
                          WHERE x.last_seen IS NOT NULL
                            AND x.last_seen >= DATE_SUB(NOW(), INTERVAL ? DAY)
                            AND (x.last_close IS NULL OR x.last_close < DATE_SUB(NOW(), INTERVAL ? DAY))
                       ORDER BY x.last_close IS NOT NULL, x.last_close", [$n, $n]);
            return array_map(function ($r) {
                $has = !empty($r['last_close']);
                return [
                    'tenant_id'   => (int) $r['tenant_id'],
                    'company_name'=> $r['company_name'],
                    'subject_key' => 'gun:' . ($has ? date('Y-m-d', strtotime($r['last_close'])) : 'hic'),
                    'headline'    => $r['company_name'] . ' gün sonu kapatmıyor',
                    'detail'      => [
                        $has ? 'Son gün sonu: ' . date('d.m.Y', strtotime($r['last_close']))
                             : 'Bu işletmeden hiç gün sonu gelmedi.',
                        'Kasa çalışıyor — son bağlantı ' . date('d.m.Y H:i', strtotime($r['last_seen'])),
                        'Müşteri kodu: ' . $r['code'],
                    ],
                ];
            }, $rows);
    }
    return [];
}

/** Has this exact alert already gone out? Read-only; the write is the guard. */
function uyari_already_sent(int $ruleId, int $tenantId, string $key): bool {
    return (bool) val('SELECT 1 FROM np_alert_sent WHERE rule_id=? AND tenant_id=? AND subject_key=?',
                      [$ruleId, $tenantId, $key]);
}

/**
 * Everything one rule has already said, as a lookup set.
 *
 * The screen asks "how many of this rule's candidates are new" for four rules
 * at once, and asking uyari_already_sent() per candidate is one query per
 * customer per rule - four figures at the top of a page costing two thousand
 * round trips on a panel with five hundred customers. One query per rule, and
 * the comparison happens here.
 *
 * The RUN does not use this and must not: it needs the database to arbitrate
 * between two crons that overlap, and a set read a moment earlier cannot.
 */
function uyari_sent_set(int $ruleId): array {
    $set = [];
    foreach (all('SELECT tenant_id, subject_key FROM np_alert_sent WHERE rule_id=?', [$ruleId]) as $r) {
        $set[$r['tenant_id'] . '|' . $r['subject_key']] = true;
    }
    return $set;
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

/**
 * Send one alert e-mail, through the panel's existing mail configuration.
 *
 * $GLOBALS['np_mailer'] is the one seam: a callable the test suite installs so
 * that de-duplication can be proved without a mail server standing behind it.
 * It is never set in the product - the screen's rehearsal button does not go
 * through here at all, it stops before anything is claimed or sent, which is
 * what makes a rehearsal free.
 */
function uyari_send(string $to, string $subject, string $body): bool {
    if (isset($GLOBALS['np_mailer']) && is_callable($GLOBALS['np_mailer'])) {
        return (bool) call_user_func($GLOBALS['np_mailer'], $to, $subject, $body);
    }

    $from = (string) cfg('mail.from');
    $name = (string) cfg('mail.from_name');
    $headers  = "From: {$name} <{$from}>\r\n";
    $headers .= "MIME-Version: 1.0\r\n";
    $headers .= "Content-Type: text/plain; charset=UTF-8\r\n";
    $headers .= "Content-Transfer-Encoding: 8bit\r\n";
    $headers .= "Auto-Submitted: auto-generated\r\n";
    return (bool) @mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', $body, $headers, '-f' . $from);
}

/** The body of one alert. Plain text on purpose: it is read on a phone. */
function uyari_body(array $rule, array $c): string {
    $kinds = uyari_kinds();
    $base = rtrim((string) cfg('app.base_url'), '/');
    $lines = [$c['headline'], ''];
    foreach ($c['detail'] as $d) $lines[] = '  ' . $d;
    $lines[] = '';
    $lines[] = 'İşletme sayfası: ' . $base . '/admin/index.php?p=tenant&id=' . (int) $c['tenant_id'];
    $lines[] = 'Kasa teşhis: ' . $base . '/admin/index.php?p=teshis&tenant=' . (int) $c['tenant_id'];
    $lines[] = '';
    $lines[] = '— ' . ($kinds[$rule['kind']]['label'] ?? $rule['kind']) . ' kuralı, eşik '
             . (int) $rule['threshold'] . ' gün.';
    $lines[] = 'Bu uyarı aynı olay için yalnızca bir kez gönderilir.';
    return implode("\n", $lines) . "\n";
}

/**
 * Evaluate every active rule and send what has not been sent.
 *
 * Options:
 *   force  - skip the "not again so soon" throttle (the screen's own button)
 *   dry    - work everything out and send nothing, recording nothing
 *
 * Returns a report the endpoint and the screen both print.
 */
function uyari_run(array $opt = []): array {
    $now = time();
    $rep = ['ok' => true, 'ran_at' => date('c'), 'sent' => 0, 'skipped' => 0,
            'failed' => 0, 'candidates' => 0, 'rules' => [], 'throttled' => false];

    if (!uyari_ready()) {
        return ['ok' => false, 'error' => 'Uyarı tabloları yok — admin/guncelle.php çalıştırın'] + $rep;
    }

    /* Safe to call more often than intended: a second call inside the window
       does nothing and says so. The hourly cron is the contract; a nervous
       owner with a browser tab is not a reason to re-scan every customer. */
    $minGap = (int) np_setting('alert_min_gap_sec', '300');
    $last = (int) strtotime((string) np_setting('alert_last_run', '@0'));
    if (empty($opt['force']) && empty($opt['dry']) && $last && ($now - $last) < $minGap) {
        $rep['throttled'] = true;
        $rep['next_run_in'] = $minGap - ($now - $last);
        return $rep;
    }

    foreach (uyari_rules(true) as $rule) {
        $r = ['id' => (int) $rule['id'], 'kind' => $rule['kind'],
              'threshold' => (int) $rule['threshold'], 'found' => 0, 'sent' => 0,
              'skipped' => 0, 'failed' => 0, 'note' => ''];

        if ($rule['channel'] !== 'email') {
            $r['note'] = 'e-posta dışı kanal — atlandı';
            $rep['rules'][] = $r;
            continue;
        }
        $to = uyari_recipients($rule);
        if (!$to) {
            $r['note'] = 'alıcı yok';
            $rep['rules'][] = $r;
            continue;
        }

        $cands = uyari_candidates($rule);
        $r['found'] = count($cands);
        $rep['candidates'] += count($cands);

        foreach ($cands as $c) {
            if (!empty($opt['dry'])) {
                if (uyari_already_sent((int) $rule['id'], $c['tenant_id'], $c['subject_key'])) $r['skipped']++;
                else $r['sent']++;
                continue;
            }
            /* The claim and the send, in that order. See the header. */
            $st = db()->prepare('INSERT IGNORE INTO np_alert_sent (rule_id, tenant_id, subject_key)
                                 VALUES (?,?,?)');
            $st->execute([(int) $rule['id'], $c['tenant_id'], $c['subject_key']]);
            if ($st->rowCount() === 0) { $r['skipped']++; continue; }

            $subject = '[NOKTApp] ' . $c['headline'];
            $body = uyari_body($rule, $c);
            $sentAny = false;
            foreach ($to as $addr) if (uyari_send($addr, $subject, $body)) $sentAny = true;

            if ($sentAny) {
                $r['sent']++;
                audit('alert.sent', $rule['kind'] . ' · ' . $c['company_name'],
                      ['key' => $c['subject_key'], 'to' => $to], $c['tenant_id']);
            } else {
                /* Give the claim back. A mail server that was down for an hour
                   should cost a delay, not a warning nobody ever gets. */
                q('DELETE FROM np_alert_sent WHERE rule_id=? AND tenant_id=? AND subject_key=?',
                  [(int) $rule['id'], $c['tenant_id'], $c['subject_key']]);
                $r['failed']++;
            }
        }
        $rep['sent'] += $r['sent'];
        $rep['skipped'] += $r['skipped'];
        $rep['failed'] += $r['failed'];
        $rep['rules'][] = $r;
    }

    if (empty($opt['dry'])) np_setting_set('alert_last_run', date('Y-m-d H:i:s', $now));
    return $rep;
}

/** What the cron last did, for the screen. */
function uyari_last_run(): ?string { return np_setting('alert_last_run'); }

/** The most recent alerts, for the screen. */
function uyari_recent(int $limit = 60): array {
    return all('SELECT s.*, t.company_name, r.kind
                  FROM np_alert_sent s
             LEFT JOIN np_tenants t ON t.id = s.tenant_id
             LEFT JOIN np_alert_rules r ON r.id = s.rule_id
              ORDER BY s.id DESC LIMIT ' . (int) $limit);
}
