<?php
/**
 * Consolidated reporting for head office - the chain layer's section 6.
 *
 * Two jobs live here and they are deliberately in the same file:
 *
 *   1. turning a till's day-end push into a row of np_branch_days, and
 *   2. reading those rows back as one area manager's morning screen.
 *
 * They belong together because the second one is only trustworthy if it reads
 * exactly what the first one wrote. Nothing in this file recomputes a figure
 * the till already calculated. Turkish KDV is VAT-INCLUSIVE - the tax is
 * inside the price, vat = gross * rate / (100 + rate) - and the till worked it
 * out bill by bill, in kurus, with the same engine that printed the guest's
 * bill. A panel that divided it out a second time would disagree with the
 * paper in the guest's hand, and the paper is the one that is right.
 *
 * Every function takes tenant_id explicitly and every query filters on it.
 * A single-shop tenant never reaches any of this: the fill needs a branch and
 * a single-shop till has none, and the screen is gated on chain_enabled().
 */
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/chain.php';

/**
 * How long a branch may go without a day-end before it is a PROBLEM rather
 * than an evening that has not finished yet.
 *
 * This is the number the whole screen exists for. A branch whose till has been
 * off since Friday sends nothing at all, and nothing at all is indistinguish-
 * able from a quiet week unless something says so out loud. Three days covers
 * a normal weekly closing day plus the day it reopens.
 */
const RAPOR_SILENT_DAYS = 3;

/* ==================================================================
 *  Materialising a push
 * ================================================================== */

/**
 * nakit / kart / diger, out of the till's payment list.
 *
 * The till's own day-end splits two ways - nakit and "everything else" - which
 * is the right split for counting a drawer and the wrong one for a head office
 * comparing ten branches: it buries yemek karti in with the acik hesap and the
 * ikram. Meal cards clear like a card and belong with the cards; a transfer, a
 * comp and an unpaid tab are none of the three and belong in diger, visible
 * rather than folded into the card figure.
 *
 * An unknown method falls into diger on purpose. A new payment type must show
 * up as money we cannot classify, never silently as cash.
 */
function rapor_payment_split(array $payments): array {
    $cash = 0.0; $card = 0.0; $other = 0.0;
    foreach ($payments as $p) {
        if (!is_array($p)) continue;
        $m = (string) ($p['method'] ?? '');
        $v = (float) ($p['total'] ?? 0);
        if ($m === 'nakit') $cash += $v;
        elseif ($m === 'kredi_karti' || $m === 'yemek_karti') $card += $v;
        else $other += $v;
    }
    return [round($cash, 2), round($card, 2), round($other, 2)];
}

/**
 * Which business day, and which close of it, this push is.
 *
 * The till pushes `daily_closing` with entity_id "<client>:<date>:<seq>" and a
 * payload whose `date` is the same business day. The payload wins for the date
 * because it is the figure the report was actually built over; the entity_id
 * is the only place close_seq exists at all, so it is read from there.
 *
 * Returns null for anything that is not a real day-end. np_reports is a
 * general bucket and has always held test rows and hand-written entity ids;
 * a row that cannot be read as a date is skipped rather than guessed at,
 * because a guessed business date lands turnover on the wrong day.
 */
function rapor_parse_close(string $entityId, array $payload): ?array {
    $date = (string) ($payload['date'] ?? '');
    $parts = explode(':', $entityId);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        // fall back to the entity_id's middle segment for a push whose payload
        // predates the `date` field
        $date = isset($parts[1]) ? (string) $parts[1] : '';
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) return null;
    }
    $last = $parts[count($parts) - 1];
    $seq = ctype_digit((string) $last) ? max(1, (int) $last) : 1;
    return [$date, $seq];
}

/**
 * Which branch pushed this.
 *
 * The device binding is the authority: head office bound that till to that
 * branch and can re-bind it if it was wrong. The branch fields the till may
 * send are accepted too - they are what the contract says the till carries in
 * its own settings - but only after being checked against THIS tenant, so a
 * copied settings file cannot post one customer's turnover into another's.
 *
 * Returns null when nothing resolves, which is the normal single-shop answer.
 */
function rapor_resolve_branch(int $tenantId, array $payload, string $deviceId): ?int {
    $code = trim((string) ($payload['branch_code'] ?? ''));
    if ($code !== '') {
        $id = val('SELECT id FROM np_branches WHERE tenant_id=? AND code=?', [$tenantId, strtoupper($code)]);
        if ($id) return (int) $id;
    }
    $bid = (int) ($payload['branch_id'] ?? 0);
    if ($bid) {
        $id = val('SELECT id FROM np_branches WHERE tenant_id=? AND id=?', [$tenantId, $bid]);
        if ($id) return (int) $id;
    }
    if ($deviceId !== '') {
        $id = val('SELECT b.id FROM np_devices d JOIN np_branches b ON b.id=d.branch_id AND b.tenant_id=d.tenant_id
                    WHERE d.tenant_id=? AND d.device_id=?', [$tenantId, $deviceId]);
        if ($id) return (int) $id;
    }
    return null;
}

/**
 * Write one day-end into np_branch_days.
 *
 * Idempotent by the unique key: the same push arriving twice - a retried
 * outbox row, a re-sent batch, a backfill run over rows that are already in -
 * updates the row in place. It can never double a day's turnover.
 *
 * A corrected re-close arrives as a HIGHER close_seq. Both rows are kept,
 * because the correction is part of the record and an area manager asking why
 * yesterday changed deserves an answer; `is_current` is recomputed for the
 * whole (branch, day) afterwards so only the last close is ever reported. It
 * is recomputed rather than incremented so that pushes arriving out of order -
 * seq 2 retried before seq 1 - still settle on the right one.
 *
 * Returns the np_branch_days id, or null when this is not a chain day-end.
 */
function rapor_materialise(int $tenantId, ?int $branchId, string $entityId, $payload, ?int $sourceId = null): ?int {
    if (!$branchId) return null;                 // single shop: nothing to consolidate
    if (is_string($payload)) $payload = json_decode($payload, true);
    if (!is_array($payload)) return null;
    $parsed = rapor_parse_close($entityId, $payload);
    if (!$parsed) return null;
    [$date, $seq] = $parsed;

    /* The branch is re-checked against the tenant here as well as at the call
       site. This function is reachable from the desktop endpoint and from the
       backfill, and a branch id that belongs to another customer must not be
       writable from either. */
    if (!val('SELECT id FROM np_branches WHERE id=? AND tenant_id=?', [$branchId, $tenantId])) return null;

    [$cash, $card, $other] = rapor_payment_split($payload['payments'] ?? []);

    /* cost is cost of goods plus the day's extra costs, exactly as the till
       adds them up for its own profit line. NULL, not 0, when the push carried
       neither: a branch that does not keep recipe costs has no cost, and
       showing it as 0 TL would tell head office its margin is 100%. */
    $hasCost = array_key_exists('cost_of_goods', $payload) || array_key_exists('extra_costs', $payload);
    $cost = $hasCost ? round((float) ($payload['cost_of_goods'] ?? 0) + (float) ($payload['extra_costs'] ?? 0), 2) : null;
    $profit = array_key_exists('profit', $payload) ? round((float) $payload['profit'], 2) : null;

    $closedAt = null;
    if (!empty($payload['closed_at'])) {
        $ts = strtotime((string) $payload['closed_at']);
        if ($ts) $closedAt = date('Y-m-d H:i:s', $ts);
    }

    q('INSERT INTO np_branch_days
         (tenant_id, branch_id, business_date, orders, gross, discount, net, vat, cost, profit,
          cash, card, other, close_seq, is_current, closed_at, received_at, source_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,NOW(),?)
       ON DUPLICATE KEY UPDATE
          orders=VALUES(orders), gross=VALUES(gross), discount=VALUES(discount), net=VALUES(net),
          vat=VALUES(vat), cost=VALUES(cost), profit=VALUES(profit),
          cash=VALUES(cash), card=VALUES(card), other=VALUES(other),
          closed_at=VALUES(closed_at), received_at=NOW(), source_id=VALUES(source_id)',
      [$tenantId, $branchId, $date,
       (int) ($payload['orders'] ?? 0),
       round((float) ($payload['gross'] ?? 0), 2),
       round((float) ($payload['discount'] ?? 0), 2),
       round((float) ($payload['net'] ?? 0), 2),
       round((float) ($payload['vat_total'] ?? 0), 2),
       $cost, $profit, $cash, $card, $other, $seq, $closedAt, $sourceId]);

    rapor_settle_current($tenantId, $branchId, $date);
    return (int) val('SELECT id FROM np_branch_days WHERE tenant_id=? AND branch_id=? AND business_date=? AND close_seq=?',
                     [$tenantId, $branchId, $date, $seq]);
}

/** Only the highest close of a day counts. Recomputed, never toggled. */
function rapor_settle_current(int $tenantId, int $branchId, string $date): void {
    $max = (int) val('SELECT MAX(close_seq) FROM np_branch_days WHERE tenant_id=? AND branch_id=? AND business_date=?',
                     [$tenantId, $branchId, $date]);
    q('UPDATE np_branch_days SET is_current = IF(close_seq = ?, 1, 0)
        WHERE tenant_id=? AND branch_id=? AND business_date=?', [$max, $tenantId, $branchId, $date]);
}

/**
 * Rebuild np_branch_days from the raw pushes still sitting in np_reports.
 *
 * This is what makes the materialisation disposable. Truncate the table, run
 * this, and the numbers come back - which is the only reason it is safe to
 * report off a derived table at all. It is also how the days a branch pushed
 * before anyone bound its till to a branch get picked up: the branch is
 * resolved again, from np_devices as it stands NOW.
 *
 * Safe to run repeatedly; every write goes through the same idempotent upsert.
 * Returns the number of rows materialised.
 */
function rapor_backfill(int $tenantId = 0): int {
    $sql = "SELECT id, tenant_id, entity_id, payload, device_id, branch_id
              FROM np_reports WHERE entity='daily_closing'";
    $args = [];
    if ($tenantId) { $sql .= ' AND tenant_id=?'; $args[] = $tenantId; }
    $n = 0;
    foreach (all($sql . ' ORDER BY id', $args) as $r) {
        $tid = (int) $r['tenant_id'];
        $payload = json_decode((string) $r['payload'], true);
        if (!is_array($payload)) continue;
        $bid = rapor_resolve_branch($tid, $payload, (string) ($r['device_id'] ?? ''));
        /* The branch recorded at push time is the fallback, not the first
           choice: a re-binding in np_devices is head office correcting a
           mistake and a rebuild has to honour it. */
        if (!$bid && !empty($r['branch_id'])) {
            $bid = (int) val('SELECT id FROM np_branches WHERE id=? AND tenant_id=?', [(int) $r['branch_id'], $tid]);
        }
        if (!$bid) continue;
        if (rapor_materialise($tid, $bid, (string) $r['entity_id'], $payload, (int) $r['id'])) $n++;
    }
    return $n;
}

/**
 * Materialise anything that has arrived since the last time we looked.
 *
 * Called when the screen opens. The endpoint already materialises on the way
 * in, so in a healthy system this finds nothing; it exists so that a panel
 * whose code was updated before sql/rapor_schema.sql was imported, or one
 * whose table was rebuilt, heals itself the first time somebody opens the
 * screen instead of quietly showing a chain short of a branch.
 */
function rapor_catch_up(int $tenantId): int {
    $last = (int) val('SELECT COALESCE(MAX(source_id),0) FROM np_branch_days WHERE tenant_id=?', [$tenantId]);
    $rows = all("SELECT id, entity_id, payload, device_id, branch_id FROM np_reports
                  WHERE tenant_id=? AND entity='daily_closing' AND id > ? ORDER BY id", [$tenantId, $last]);
    $n = 0;
    foreach ($rows as $r) {
        $payload = json_decode((string) $r['payload'], true);
        if (!is_array($payload)) continue;
        $bid = rapor_resolve_branch($tenantId, $payload, (string) ($r['device_id'] ?? ''));
        if (!$bid && !empty($r['branch_id'])) {
            $bid = (int) val('SELECT id FROM np_branches WHERE id=? AND tenant_id=?', [(int) $r['branch_id'], $tenantId]);
        }
        if ($bid && rapor_materialise($tenantId, $bid, (string) $r['entity_id'], $payload, (int) $r['id'])) $n++;
    }
    return $n;
}

/* ==================================================================
 *  Reading it back
 * ================================================================== */

/** Money as whole kurus. Every total in this file is added up as an integer. */
function rapor_kurus($v): int { return (int) round(((float) $v) * 100); }
/** ...and turned back into lira only at the edge. */
function rapor_tl(int $k): float { return $k / 100; }

/**
 * One row per branch for the period - including the branches that sent
 * nothing.
 *
 * The LEFT JOIN is the whole point. An INNER JOIN would drop a branch whose
 * till has been dark all week, and a missing branch reads as a chain that is
 * doing fine. `days` is what tells the difference between a branch that traded
 * nothing and a branch we have not heard from: zero turnover over five closed
 * days is a bad week, zero turnover over zero closed days is a broken till.
 */
function rapor_branch_rows(int $tenantId, string $from, string $to): array {
    return all(
        'SELECT b.id, b.code, b.name, b.city, b.is_active,
                COUNT(d.id) AS days,
                COALESCE(SUM(d.orders),0)   AS orders,
                COALESCE(SUM(d.gross),0)    AS gross,
                COALESCE(SUM(d.discount),0) AS discount,
                COALESCE(SUM(d.net),0)      AS net,
                COALESCE(SUM(d.vat),0)      AS vat,
                SUM(d.cost)                 AS cost,
                SUM(d.profit)               AS profit,
                COUNT(d.cost)               AS cost_days,
                COALESCE(SUM(d.cash),0)     AS cash,
                COALESCE(SUM(d.card),0)     AS card,
                COALESCE(SUM(d.other),0)    AS other,
                MAX(d.business_date)        AS last_day
           FROM np_branches b
      LEFT JOIN np_branch_days d
             ON d.tenant_id = b.tenant_id AND d.branch_id = b.id
            AND d.is_current = 1 AND d.business_date BETWEEN ? AND ?
          WHERE b.tenant_id = ?
       GROUP BY b.id, b.code, b.name, b.city, b.is_active
       ORDER BY b.is_active DESC, b.code', [$from, $to, $tenantId]);
}

/**
 * The combined line, added up from the branch rows themselves.
 *
 * Deliberately NOT a second SELECT over the same table. Two queries can
 * disagree - a filter that drifts, a branch excluded from one and not the
 * other - and a head-office screen whose "tüm şubeler" line does not equal the
 * rows printed underneath it is worse than no screen. Summed in kurus so the
 * two agree exactly, not to within a rounding error.
 */
function rapor_total(array $rows): array {
    $t = ['days' => 0, 'orders' => 0, 'gross' => 0, 'discount' => 0, 'net' => 0, 'vat' => 0,
          'cost' => 0, 'profit' => 0, 'cost_days' => 0, 'cash' => 0, 'card' => 0, 'other' => 0];
    $anyCost = false;
    foreach ($rows as $r) {
        $t['days']      += (int) $r['days'];
        $t['orders']    += (int) $r['orders'];
        $t['cost_days'] += (int) $r['cost_days'];
        foreach (['gross', 'discount', 'net', 'vat', 'cash', 'card', 'other'] as $k) {
            $t[$k] += rapor_kurus($r[$k]);
        }
        if ($r['cost'] !== null)   { $t['cost'] += rapor_kurus($r['cost']); $anyCost = true; }
        if ($r['profit'] !== null) { $t['profit'] += rapor_kurus($r['profit']); }
    }
    foreach (['gross', 'discount', 'net', 'vat', 'cash', 'card', 'other'] as $k) $t[$k] = rapor_tl($t[$k]);
    $t['cost']   = $anyCost ? rapor_tl($t['cost']) : null;
    $t['profit'] = $anyCost ? rapor_tl($t['profit']) : null;
    return $t;
}

/** Ortalama adisyon. Weighted by the bills, never the mean of the branch means. */
function rapor_average($net, $orders) {
    $orders = (int) $orders;
    return $orders > 0 ? round(((float) $net) / $orders, 2) : null;
}

/**
 * How the chain's day-ends stand as of one business date.
 *
 * Three states, and the difference between the last two is the reason this
 * screen exists:
 *   kapandi  - the day-end for that date is in.
 *   bekliyor - it is not, but this branch closed recently. The evening is
 *              simply not over; nothing to do.
 *   sessiz   - nothing for RAPOR_SILENT_DAYS or more, or nothing ever. That is
 *              a till that is off, unlicensed, or not syncing, and it is a
 *              PROBLEM. It must never be read as a branch that took no money.
 */
function rapor_status(int $tenantId, string $asOf): array {
    $rows = all(
        'SELECT b.id, b.code, b.name, b.city, b.is_active,
                (SELECT MAX(d.business_date) FROM np_branch_days d
                  WHERE d.tenant_id=b.tenant_id AND d.branch_id=b.id AND d.is_current=1) AS last_day,
                (SELECT MAX(d.received_at) FROM np_branch_days d
                  WHERE d.tenant_id=b.tenant_id AND d.branch_id=b.id) AS last_push,
                (SELECT MAX(x.net) FROM np_branch_days x
                  WHERE x.tenant_id=b.tenant_id AND x.branch_id=b.id AND x.is_current=1
                    AND x.business_date=?) AS asof_net,
                (SELECT MAX(dv.last_seen_at) FROM np_devices dv
                  WHERE dv.tenant_id=b.tenant_id AND dv.branch_id=b.id) AS device_seen
           FROM np_branches b
          WHERE b.tenant_id=? AND b.is_active=1
       ORDER BY b.code', [$asOf, $tenantId]);

    $asOfTs = strtotime($asOf);
    $out = [];
    foreach ($rows as $r) {
        $closed = $r['asof_net'] !== null;
        $gap = null;                              // whole days since the last close
        if ($r['last_day']) $gap = (int) floor(($asOfTs - strtotime((string) $r['last_day'])) / 86400);
        $silent = !$closed && ($gap === null || $gap >= RAPOR_SILENT_DAYS);
        $out[] = $r + [
            'closed' => $closed,
            'gap'    => $gap,
            'state'  => $closed ? 'kapandi' : ($silent ? 'sessiz' : 'bekliyor'),
        ];
    }
    return $out;
}

/**
 * The whole screen's figures, in one structure.
 *
 * The screen, the CSV and the PDF all render THIS and nothing else. Three
 * renderers building their own numbers is how an export comes to disagree
 * with the page it was exported from, and an area manager who has caught the
 * panel contradicting itself once will not trust the number again.
 */
function rapor_pack(int $tenantId, string $from, string $to): array {
    $days = max(1, (int) floor((strtotime($to) - strtotime($from)) / 86400) + 1);
    $prevTo = date('Y-m-d', strtotime($from . ' -1 day'));
    $prevFrom = date('Y-m-d', strtotime($prevTo . ' -' . ($days - 1) . ' day'));

    $rows = rapor_branch_rows($tenantId, $from, $to);
    $prev = [];
    foreach (rapor_branch_rows($tenantId, $prevFrom, $prevTo) as $r) $prev[(int) $r['id']] = $r;

    /* The reference day for "who has not closed": the last day of the range,
       but never a day in the future. Asking a branch to have closed tomorrow
       would paint the whole chain red on any range that runs to month end. */
    $asOf = min($to, date('Y-m-d'));
    $status = rapor_status($tenantId, $asOf);
    $byId = [];
    foreach ($status as $s) $byId[(int) $s['id']] = $s;

    $out = [];
    foreach ($rows as $r) {
        $id = (int) $r['id'];
        $p = $prev[$id] ?? null;
        $st = $byId[$id] ?? null;
        $prevNet = $p ? (float) $p['net'] : 0.0;
        $out[] = [
            'id'        => $id,
            'code'      => (string) $r['code'],
            'name'      => (string) $r['name'],
            'is_active' => (int) $r['is_active'],
            'days'      => (int) $r['days'],
            'orders'    => (int) $r['orders'],
            'gross'     => (float) $r['gross'],
            'discount'  => (float) $r['discount'],
            'net'       => (float) $r['net'],
            'vat'       => (float) $r['vat'],
            'cost'      => $r['cost'] === null ? null : (float) $r['cost'],
            'profit'    => $r['profit'] === null ? null : (float) $r['profit'],
            'cash'      => (float) $r['cash'],
            'card'      => (float) $r['card'],
            'other'     => (float) $r['other'],
            'average'   => rapor_average($r['net'], $r['orders']),
            'prev_net'  => $prevNet,
            'trend'     => $prevNet > 0 ? round((((float) $r['net'] - $prevNet) / $prevNet) * 100, 1) : null,
            'state'     => $st['state'] ?? ($r['is_active'] ? 'sessiz' : 'pasif'),
            'gap'       => $st['gap'] ?? null,
            'last_day'  => $st['last_day'] ?? $r['last_day'],
        ];
    }

    $total = rapor_total($rows);
    $prevTotal = rapor_total(array_values($prev));
    $total['average'] = rapor_average($total['net'], $total['orders']);
    $total['prev_net'] = (float) $prevTotal['net'];
    $total['trend'] = $prevTotal['net'] > 0
        ? round((($total['net'] - $prevTotal['net']) / $prevTotal['net']) * 100, 1) : null;

    /* Best and worst are chosen only among branches that actually reported.
       A silent branch is not the worst performer in the chain - it is a branch
       we have no figures for, and naming it "en düşük ciro" would send an area
       manager to shout at the wrong restaurant. */
    $reported = array_values(array_filter($out, fn($r) => $r['days'] > 0));
    usort($reported, fn($a, $b) => $b['net'] <=> $a['net']);

    return [
        'from' => $from, 'to' => $to, 'days' => $days,
        'prev_from' => $prevFrom, 'prev_to' => $prevTo,
        'as_of' => $asOf,
        'rows' => $out,
        'total' => $total,
        'best' => $reported[0] ?? null,
        'worst' => count($reported) > 1 ? $reported[count($reported) - 1] : null,
        'status' => $status,
        'open' => array_values(array_filter($status, fn($s) => $s['state'] === 'bekliyor')),
        'silent' => array_values(array_filter($status, fn($s) => $s['state'] === 'sessiz')),
    ];
}

/* ==================================================================
 *  The table, as one shape
 * ================================================================== */

const RAPOR_TXT = 'txt', RAPOR_INT = 'int', RAPOR_MONEY = 'money', RAPOR_PCT = 'pct';

/**
 * The exported table: columns with a declared type, and rows of raw values.
 *
 * The type is declared once here and read by all three renderers, which is
 * what makes '1.234,56' on the page, '1234,56' in the CSV and '1.234,56' on
 * the PDF the same number rather than three independent formatting attempts.
 */
function rapor_sheet(array $pack): array {
    $cols = [
        ['k' => 'branch',   'tr' => 'Şube',            't' => RAPOR_TXT],
        ['k' => 'state',    'tr' => 'Durum',           't' => RAPOR_TXT],
        ['k' => 'days',     'tr' => 'Kapanan gün',     't' => RAPOR_INT],
        ['k' => 'orders',   'tr' => 'Adisyon',         't' => RAPOR_INT],
        ['k' => 'net',      'tr' => 'Ciro',            't' => RAPOR_MONEY],
        ['k' => 'vat',      'tr' => 'KDV',             't' => RAPOR_MONEY],
        ['k' => 'discount', 'tr' => 'İndirim',         't' => RAPOR_MONEY],
        ['k' => 'average',  'tr' => 'Ort. adisyon',    't' => RAPOR_MONEY],
        ['k' => 'cash',     'tr' => 'Nakit',           't' => RAPOR_MONEY],
        ['k' => 'card',     'tr' => 'Kart',            't' => RAPOR_MONEY],
        ['k' => 'other',    'tr' => 'Diğer',           't' => RAPOR_MONEY],
        ['k' => 'cost',     'tr' => 'Maliyet',         't' => RAPOR_MONEY],
        ['k' => 'profit',   'tr' => 'Kâr',             't' => RAPOR_MONEY],
        ['k' => 'prev_net', 'tr' => 'Önceki dönem',    't' => RAPOR_MONEY],
        ['k' => 'trend',    'tr' => 'Değişim %',       't' => RAPOR_PCT],
    ];
    $rows = [];
    foreach ($pack['rows'] as $r) {
        $rows[] = [
            'branch'   => $r['code'] . ' · ' . $r['name'],
            'state'    => rapor_state_text($r),
            'days'     => $r['days'],
            'orders'   => $r['orders'],
            'net'      => $r['net'],
            'vat'      => $r['vat'],
            'discount' => $r['discount'],
            'average'  => $r['average'],
            'cash'     => $r['cash'],
            'card'     => $r['card'],
            'other'    => $r['other'],
            'cost'     => $r['cost'],
            'profit'   => $r['profit'],
            'prev_net' => $r['prev_net'],
            'trend'    => $r['trend'],
        ];
    }
    $t = $pack['total'];
    $rows[] = [
        'branch'   => 'TÜM ŞUBELER',
        'state'    => count($pack['silent']) ? count($pack['silent']) . ' şube sessiz' : '',
        'days'     => $t['days'],
        'orders'   => $t['orders'],
        'net'      => $t['net'],
        'vat'      => $t['vat'],
        'discount' => $t['discount'],
        'average'  => $t['average'],
        'cash'     => $t['cash'],
        'card'     => $t['card'],
        'other'    => $t['other'],
        'cost'     => $t['cost'],
        'profit'   => $t['profit'],
        'prev_net' => $t['prev_net'],
        'trend'    => $t['trend'],
    ];
    return ['cols' => $cols, 'rows' => $rows];
}

/** The branch's state in words, for the screen and for both exports. */
function rapor_state_text(array $r): string {
    if (!$r['is_active']) return 'pasif şube';
    if ($r['state'] === 'sessiz') {
        if ($r['last_day'] === null) return 'hiç gün sonu göndermedi';
        return (int) $r['gap'] . ' gündür gün sonu yok';
    }
    if ($r['state'] === 'bekliyor') return 'gün sonu bekleniyor';
    return 'gün sonu alındı';
}

/* ------------------------------ formatting ------------------------------ */

/** 1.234,56 - grouped, always two decimals. The screen and the PDF. */
function rapor_money($n): string {
    if ($n === null) return '—';
    $v = round((float) $n, 2);
    return number_format($v, 2, ',', '.');
}
/** 1234,56 - no grouping. A Turkish Windows Excel reads the comma as decimal. */
function rapor_csv_num($n, int $dp = 2): string {
    if ($n === null) return '';
    return str_replace('.', ',', number_format((float) $n, $dp, '.', ''));
}
/** 04.09.2026. '2026-09-04' opens in Excel as text and cannot be sorted. */
function rapor_dmy($d): string {
    if (!$d) return '';
    $s = (string) $d;
    return preg_match('/^(\d{4})-(\d{2})-(\d{2})/', $s, $m) ? "$m[3].$m[2].$m[1]" : $s;
}

function rapor_cell($v, string $type, bool $csv = false): string {
    if ($type === RAPOR_MONEY) return $v === null ? ($csv ? '' : '—') : ($csv ? rapor_csv_num($v) : rapor_money($v));
    if ($type === RAPOR_PCT)   return $v === null ? '' : ($csv ? rapor_csv_num($v, 1) : ($v > 0 ? '+' : '') . rapor_csv_num($v, 1));
    if ($type === RAPOR_INT)   return (string) (int) $v;
    return $v === null ? '' : (string) $v;
}
function rapor_is_numeric_col(string $t): bool { return $t !== RAPOR_TXT; }

/* ------------------------------- exports -------------------------------- */

/**
 * The table as a Turkish-safe CSV.
 *
 * Four things, and getting any one of them wrong hands the accountant an
 * unusable file: a UTF-8 BOM or Excel decides the file is cp1254 and ç ğ ş ı
 * arrive as mojibake; ';' as the separator, because a Turkish Windows locale
 * uses the comma as the DECIMAL mark and a comma-separated file opens as one
 * column; '1234,56' for money for the same reason; and CRLF line endings.
 */
function rapor_csv(array $pack, array $tenant): string {
    $sheet = rapor_sheet($pack);
    $out = [];
    /* The period is written into the file, not only into the filename. A file
       renamed on the way to the accountant is a file whose dates are gone. */
    $out[] = 'NOKTApp POS · Şube karşılaştırma';
    $out[] = rapor_csv_cell($tenant['company_name'] ?? '');
    $out[] = 'Dönem;' . rapor_dmy($pack['from']) . ' - ' . rapor_dmy($pack['to']);
    $out[] = 'Önceki dönem;' . rapor_dmy($pack['prev_from']) . ' - ' . rapor_dmy($pack['prev_to']);
    $out[] = 'Rapor tarihi;' . date('d.m.Y H:i');
    $out[] = '';
    $out[] = implode(';', array_map(fn($c) => rapor_csv_cell($c['tr']), $sheet['cols']));
    foreach ($sheet['rows'] as $r) {
        $out[] = implode(';', array_map(fn($c) => rapor_csv_cell(rapor_cell($r[$c['k']], $c['t'], true)), $sheet['cols']));
    }
    return "\xEF\xBB\xBF" . implode("\r\n", $out) . "\r\n";
}

function rapor_csv_cell($v): string {
    $s = $v === null ? '' : (string) $v;
    return preg_match('/[";\r\n]/', $s) ? '"' . str_replace('"', '""', $s) . '"' : $s;
}

/**
 * The same table as a PDF the accountant can file.
 *
 * The CSV is for the spreadsheet; this is for the folder. A file copy has to
 * stand up months later in front of somebody who was not there, so it carries
 * who the taxpayer is, exactly which days it covers, what is NOT in the
 * figures, and "Sayfa 1 / 3" so a missing page is visible.
 */
function rapor_pdf(array $pack, array $tenant): string {
    require_once __DIR__ . '/pdf.php';
    $sheet = rapor_sheet($pack);
    $pdf = new NpPdf();

    $head = function (NpPdf $p) use ($tenant, $pack) {
        $p->text($tenant['company_name'] ?? 'NOKTApp', 15, true, NpPdf::ORANGE);
        $bits = [];
        if (!empty($tenant['tax_office'])) $bits[] = 'Vergi dairesi: ' . $tenant['tax_office'];
        if (!empty($tenant['tax_number'])) $bits[] = 'VKN/TCKN: ' . $tenant['tax_number'];
        if ($bits) $p->text(implode('   |   ', $bits), 8.5, false, '#444');
        $addr = trim(($tenant['address'] ?? '') . ' ' . ($tenant['city'] ?? ''));
        if ($addr !== '') $p->text('Adres: ' . $addr, 8.5, false, '#444');
        $p->gap(4); $p->rule('#111', 1); $p->gap(8);
        $p->text('Şube karşılaştırma raporu', 14, true);
        $p->text('Dönem: ' . rapor_dmy($pack['from']) . ' - ' . rapor_dmy($pack['to'])
               . '   (' . $pack['days'] . ' gün)', 9);
        $p->text('Önceki dönem: ' . rapor_dmy($pack['prev_from']) . ' - ' . rapor_dmy($pack['prev_to']), 8, false, '#666');
        $p->text('Gün sonu durumu ' . rapor_dmy($pack['as_of']) . ' iş günü için değerlendirilmiştir.', 8, false, '#666');
        $p->text('Rapor tarihi: ' . date('d.m.Y H:i'), 8, false, '#666');
        $p->gap(10);
    };
    $pdf->onNewPage($head);
    $pdf->addPage();

    /* Not closed yet, before the table. It is the one thing on this page an
       area manager cannot get anywhere else, so it goes first on the paper as
       well as on the screen. */
    $lines = [];
    foreach ($pack['silent'] as $s) {
        $lines[] = 'SESSİZ: ' . $s['code'] . ' · ' . $s['name'] . ' — '
                 . ($s['last_day'] ? rapor_dmy($s['last_day']) . ' tarihinden beri gün sonu yok'
                                   : 'hiç gün sonu göndermedi');
    }
    foreach ($pack['open'] as $s) {
        $lines[] = 'BEKLİYOR: ' . $s['code'] . ' · ' . $s['name'] . ' — ' . rapor_dmy($pack['as_of']) . ' günü kapanmadı';
    }
    if (!$lines) $lines[] = 'Tüm şubeler ' . rapor_dmy($pack['as_of']) . ' gün sonunu göndermiştir.';
    $pdf->block('Gün sonu durumu', $lines);

    $facts = [
        ['Toplam ciro (KDV dahil)', rapor_money($pack['total']['net']) . ' TL'],
        ['KDV (fiyatlara dahil)', rapor_money($pack['total']['vat']) . ' TL'],
        ['Adisyon', (string) $pack['total']['orders']],
        ['Ortalama adisyon', rapor_money($pack['total']['average']) . ' TL'],
        ['Önceki döneme göre', $pack['total']['trend'] === null ? 'karşılaştırılamıyor'
            : (($pack['total']['trend'] > 0 ? '+' : '') . rapor_csv_num($pack['total']['trend'], 1) . '%')],
        ['En yüksek ciro', $pack['best'] ? $pack['best']['code'] . ' · ' . rapor_money($pack['best']['net']) . ' TL' : '—'],
        ['En düşük ciro', $pack['worst'] ? $pack['worst']['code'] . ' · ' . rapor_money($pack['worst']['net']) . ' TL' : '—'],
    ];
    $pdf->facts('Dönem özeti', $facts);
    $pdf->table($sheet['cols'], $sheet['rows']);
    $pdf->block('Kapsam', [
        'İptal edilen ve rapor dışı bırakılan adisyonlar hiçbir rakama dahil DEĞİLDİR.',
        'KDV, kasanın adisyon adisyon hesapladığı tutardır; fiyatlara dahildir ve burada yeniden hesaplanmaz.',
        'Kapanan gün sayısı sıfır olan şube o dönemde ciro yapmamış değil, gün sonu göndermemiş şubedir.',
        'Bir gün birden fazla kez kapatıldıysa yalnızca son kapanış raporlanır.',
    ]);
    return $pdf->output();
}
