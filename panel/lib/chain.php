<?php
/**
 * The chain layer, shared between the head-office screens and the two
 * desktop endpoints.
 *
 * It lives here rather than in either caller because the publish rules, the
 * price lock and the shape of a menu row have to be identical on both sides.
 * If the screen let a locked price be overridden and the endpoint filtered it
 * out, the panel would show a branch a price its till never received.
 *
 * Every function takes tenant_id explicitly and every query filters on it.
 * Nothing in here ever resolves a branch from anything but (tenant, ...).
 */
require_once __DIR__ . '/db.php';

/** How many branches this tenant has. Below two, the chain screens stay hidden. */
function chain_branch_count(int $tenantId): int {
    return (int) val('SELECT COUNT(*) FROM np_branches WHERE tenant_id=?', [$tenantId]);
}

/** True once the tenant is actually a chain. The single-shop customer never sees any of this. */
function chain_enabled(int $tenantId): bool {
    return chain_branch_count($tenantId) >= 2;
}

/**
 * The wire shape of one master category.
 *
 * Deliberately no panel-side id: the branch matches on master_code and
 * nothing else, so handing it our primary key would only invite someone to
 * join on it one day and break every install that was seeded in a different
 * order. Key order is fixed because the JSON is hashed for the diff.
 */
function chain_category_payload(array $r): array {
    return [
        'master_code'  => (string) $r['master_code'],
        'name'         => (string) $r['name'],
        'station_hint' => $r['station_hint'] !== null ? (string) $r['station_hint'] : null,
        'sort_order'   => (int) $r['sort_order'],
        'is_active'    => (int) $r['is_active'],
        'use_in_pos'   => (int) $r['use_in_pos'],
        'use_in_qr'    => (int) $r['use_in_qr'],
        'price_locked' => (int) $r['price_locked'],
    ];
}

/** The wire shape of one master product. `category_code`, never category_id, for the same reason. */
function chain_product_payload(array $r): array {
    return [
        'master_code'   => (string) $r['master_code'],
        'category_code' => $r['category_code'] !== null ? (string) $r['category_code'] : null,
        'name'          => (string) $r['name'],
        'description'   => $r['description'] !== null ? (string) $r['description'] : null,
        'price'         => number_format((float) $r['price'], 2, '.', ''),
        'cost_price'    => $r['cost_price'] !== null ? number_format((float) $r['cost_price'], 2, '.', '') : null,
        'vat_rate'      => number_format((float) $r['vat_rate'], 2, '.', ''),
        'track_stock'   => (int) $r['track_stock'],
        'use_in_pos'    => (int) $r['use_in_pos'],
        'use_in_qr'     => (int) $r['use_in_qr'],
        'image_url'     => $r['image_url'] !== null ? (string) $r['image_url'] : null,
        'sort_order'    => (int) $r['sort_order'],
        'is_active'     => (int) $r['is_active'],
        'price_locked'  => (int) $r['price_locked'],
    ];
}

function chain_encode(array $payload): string {
    return json_encode($payload, JSON_UNESCAPED_UNICODE);
}

/**
 * Mint the next version and freeze the current master menu into it.
 *
 * Only ACTIVE rows are frozen. That is what makes `withdrawn` computable: a
 * code that was in the previous version's snapshot and is not in this one has
 * been withdrawn, whether head office ticked it inactive or deleted the row
 * outright. The branch then deactivates it locally and never deletes it,
 * because its order lines still point at that row.
 *
 * Returns the new version number.
 */
function chain_publish(int $tenantId, string $note, string $by): int {
    $pdo = db();
    $pdo->beginTransaction();
    try {
        /* Read the next number inside the transaction. Two admins pressing
           Yayınla in the same second would otherwise both mint version 4 and
           the unique key would reject the second one mid-write. */
        $next = 1 + (int) val('SELECT COALESCE(MAX(version),0) FROM np_menu_versions WHERE tenant_id=?', [$tenantId]);

        $cats = all('SELECT * FROM np_menu_categories WHERE tenant_id=? AND is_active=1 ORDER BY sort_order, id', [$tenantId]);
        $prods = all('SELECT p.*, c.master_code AS category_code
                        FROM np_menu_products p
                   LEFT JOIN np_menu_categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
                       WHERE p.tenant_id=? AND p.is_active=1
                    ORDER BY p.sort_order, p.id', [$tenantId]);

        q('INSERT INTO np_menu_versions (tenant_id, version, note, published_by, product_count, category_count)
           VALUES (?,?,?,?,?,?)',
          [$tenantId, $next, mb_substr($note, 0, 255) ?: null, mb_substr($by, 0, 120),
           count($prods), count($cats)]);
        $versionId = lastId();

        $ins = $pdo->prepare(
            'INSERT INTO np_menu_version_items (tenant_id, version_id, version, entity, master_code, payload, row_hash)
             VALUES (?,?,?,?,?,?,?)');
        foreach ($cats as $r) {
            $json = chain_encode(chain_category_payload($r));
            $ins->execute([$tenantId, $versionId, $next, 'category', $r['master_code'], $json, sha1($json)]);
        }
        foreach ($prods as $r) {
            $json = chain_encode(chain_product_payload($r));
            $ins->execute([$tenantId, $versionId, $next, 'product', $r['master_code'], $json, sha1($json)]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    return $next;
}

/** The tenant's current published version, or 0 when nothing has been published yet. */
function chain_current_version(int $tenantId): int {
    return (int) val('SELECT COALESCE(MAX(version),0) FROM np_menu_versions WHERE tenant_id=?', [$tenantId]);
}

/**
 * Is this master row's price locked?
 *
 * Read from the LIVE master row, not from the snapshot. Locking a price is a
 * policy decision, like the override itself; head office expects it to bite
 * immediately, not at the next Yayınla. A row that does not exist counts as
 * locked, so a stale override can never invent a price.
 */
function chain_price_locked(int $tenantId, string $entity, string $code): bool {
    $table = $entity === 'category' ? 'np_menu_categories' : 'np_menu_products';
    $v = val("SELECT price_locked FROM {$table} WHERE tenant_id=? AND master_code=?", [$tenantId, $code]);
    return $v === null ? true : (bool) (int) $v;
}

/**
 * Write or clear one branch exception.
 *
 * Returns null on success, a Turkish message on refusal. The refusal that
 * matters is a price on a locked row: the default posture is everything
 * central, so an override has to be granted deliberately upstream before it
 * can be set here.
 */
function chain_save_override(int $tenantId, int $branchId, string $entity, string $code,
                             ?int $available, ?string $price, string $by): ?string {
    if (!in_array($entity, ['product', 'category'], true)) return 'Geçersiz kayıt türü';
    $branch = one('SELECT id FROM np_branches WHERE id=? AND tenant_id=?', [$branchId, $tenantId]);
    if (!$branch) return 'Şube bulunamadı';

    /* The code must exist under the chosen type and under THIS tenant. The
       form offers products and categories in one list, so picking "Kategori"
       and then a product code is one wrong click away - and it would write an
       exception that matches nothing at any branch and can never be explained. */
    $table = $entity === 'category' ? 'np_menu_categories' : 'np_menu_products';
    if (!val("SELECT id FROM {$table} WHERE tenant_id=? AND master_code=?", [$tenantId, $code])) {
        return 'Bu kod ana menüde ' . ($entity === 'category' ? 'kategori' : 'ürün') . ' olarak bulunamadı';
    }

    $priceVal = null;
    if ($price !== null && trim($price) !== '') {
        if (chain_price_locked($tenantId, $entity, $code)) {
            return 'Bu ürünün fiyatı merkeze kilitli. Önce ana menüde kilidi açın.';
        }
        $priceVal = number_format((float) str_replace(',', '.', $price), 2, '.', '');
    }
    if ($available === null && $priceVal === null) {
        q('DELETE FROM np_branch_overrides WHERE tenant_id=? AND branch_id=? AND entity=? AND master_code=?',
          [$tenantId, $branchId, $entity, $code]);
        return null;
    }
    q('INSERT INTO np_branch_overrides (tenant_id, branch_id, entity, master_code, available, price, updated_by)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE available=VALUES(available), price=VALUES(price),
           updated_by=VALUES(updated_by), updated_at=NOW()',
      [$tenantId, $branchId, $entity, $code, $available, $priceVal, mb_substr($by, 0, 120)]);
    return null;
}

/** This branch's exceptions, in wire shape. A locked master price silently drops the override price. */
function chain_overrides_for(int $tenantId, int $branchId): array {
    $rows = all('SELECT o.entity, o.master_code, o.available, o.price
                   FROM np_branch_overrides o
                  WHERE o.tenant_id=? AND o.branch_id=?
                  ORDER BY o.entity, o.master_code', [$tenantId, $branchId]);
    $out = [];
    foreach ($rows as $r) {
        $price = $r['price'];
        /* A price granted, used, then locked again upstream must stop reaching
           the till on the next pull. Filtering here rather than deleting the
           row keeps the exception on record for when the lock is lifted. */
        if ($price !== null && chain_price_locked($tenantId, (string) $r['entity'], (string) $r['master_code'])) {
            $price = null;
        }
        if ($r['available'] === null && $price === null) continue;
        $out[] = [
            'entity'      => (string) $r['entity'],
            'master_code' => (string) $r['master_code'],
            'available'   => $r['available'] === null ? null : (int) $r['available'],
            'price'       => $price === null ? null : number_format((float) $price, 2, '.', ''),
        ];
    }
    return $out;
}

/** Which branch is this device bound to? NULL for a single-shop till, which is most of them. */
function chain_branch_of_device(int $tenantId, string $deviceId): ?array {
    if ($deviceId === '') return null;
    return one('SELECT b.* FROM np_devices d
                  JOIN np_branches b ON b.id = d.branch_id AND b.tenant_id = d.tenant_id
                 WHERE d.tenant_id=? AND d.device_id=?', [$tenantId, $deviceId]) ?: null;
}

/**
 * Bind a device to the branch whose code head office read out over the phone.
 *
 * The till sends `branch_code` on its menu pull; this is how a new machine
 * joins a branch without anyone touching the panel. An unknown or inactive
 * code binds nothing and is not an error - the till simply keeps behaving as
 * a single shop, which is the correct failure.
 */
function chain_bind_device(int $tenantId, string $deviceId, string $branchCode): ?array {
    $branchCode = strtoupper(trim($branchCode));
    if ($deviceId === '' || $branchCode === '') return null;
    $b = one('SELECT * FROM np_branches WHERE tenant_id=? AND code=? AND is_active=1', [$tenantId, $branchCode]);
    if (!$b) return null;
    q('UPDATE np_devices SET branch_id=? WHERE tenant_id=? AND device_id=?', [$b['id'], $tenantId, $deviceId]);
    return $b;
}

/**
 * The body of GET /api/desktop/menu.php.
 *
 * `since` is the version the till has already applied.
 *   - since <= 0, or a version this panel no longer holds, or a version newer
 *     than ours (a restored backup, a till moved between tenants) => full
 *     answer, `full: true`. Getting this wrong strands a till forever.
 *   - otherwise only the rows whose frozen payload differs between the two
 *     versions, plus the codes that have disappeared.
 *
 * Overrides are always sent in full. They are small, they are not versioned,
 * and a branch that has just been told to stop selling something should stop
 * selling it on the next pull rather than at the next Yayınla.
 */
function chain_menu_for(int $tenantId, ?array $branch, int $since): array {
    $target = chain_current_version($tenantId);
    $branchId = $branch ? (int) $branch['id'] : 0;

    $res = [
        'ok'         => true,
        'version'    => $target,
        'since'      => $since,
        'full'       => true,
        'categories' => [],
        'products'   => [],
        'overrides'  => $branchId ? chain_overrides_for($tenantId, $branchId) : [],
        'withdrawn'  => [],
        'withdrawn_categories' => [],
        'branch'     => $branch ? [
            'id'   => (int) $branch['id'],
            'code' => (string) $branch['code'],
            'name' => (string) $branch['name'],
        ] : null,
    ];
    if ($target <= 0) {
        // nothing published yet: the till has nothing to apply and must not
        // conclude its whole menu has been withdrawn
        $res['full'] = ($since <= 0);
        return $res;
    }

    $targetRow = one('SELECT * FROM np_menu_versions WHERE tenant_id=? AND version=?', [$tenantId, $target]);
    $res['published_at'] = $targetRow['published_at'] ?? null;
    $res['note'] = $targetRow['note'] ?? null;

    $sinceRow = $since > 0
        ? one('SELECT * FROM np_menu_versions WHERE tenant_id=? AND version=?', [$tenantId, $since])
        : null;
    $incremental = $sinceRow !== null && $since < $target;
    $res['full'] = !$incremental;

    if ($sinceRow !== null && $since === $target) {
        /* Already up to date. Send no menu rows at all - re-applying a version
           must be a no-op, and the cheapest no-op is an empty one. Overrides
           still ride along above, because those can move without a publish.
           full stays false: empty-and-full would read as "the whole menu is
           gone" to a till that deactivates whatever it was not sent. */
        $res['full'] = false;
        return $res;
    }

    $items = all('SELECT entity, master_code, payload, row_hash
                    FROM np_menu_version_items WHERE tenant_id=? AND version=?', [$tenantId, $target]);

    $prev = [];   // "entity\0code" => row_hash, the state the till is holding
    if ($incremental) {
        foreach (all('SELECT entity, master_code, row_hash FROM np_menu_version_items
                       WHERE tenant_id=? AND version=?', [$tenantId, $since]) as $r) {
            $prev[$r['entity'] . "\0" . $r['master_code']] = $r['row_hash'];
        }
    }

    $seen = [];
    foreach ($items as $r) {
        $key = $r['entity'] . "\0" . $r['master_code'];
        $seen[$key] = true;
        if ($incremental && isset($prev[$key]) && $prev[$key] === $r['row_hash']) continue;
        $row = json_decode($r['payload'], true);
        if (!is_array($row)) continue;
        if ($r['entity'] === 'category') $res['categories'][] = $row;
        else $res['products'][] = $row;
    }

    /* Withdrawn. On an incremental pull that is what the till used to have and
       no longer should. On a full pull we look wider - every code this tenant
       ever published and no longer does - because a till catching up from
       scratch has no other way to learn that last year's item is gone. */
    if ($incremental) {
        foreach ($prev as $key => $_) {
            if (isset($seen[$key])) continue;
            [$entity, $code] = explode("\0", $key, 2);
            if ($entity === 'category') $res['withdrawn_categories'][] = $code;
            else $res['withdrawn'][] = $code;
        }
    } else {
        foreach (all('SELECT DISTINCT entity, master_code FROM np_menu_version_items
                       WHERE tenant_id=? AND version<>?', [$tenantId, $target]) as $r) {
            $key = $r['entity'] . "\0" . $r['master_code'];
            if (isset($seen[$key])) continue;
            if ($r['entity'] === 'category') $res['withdrawn_categories'][] = $r['master_code'];
            else $res['withdrawn'][] = $r['master_code'];
        }
    }
    return $res;
}

/**
 * The credentials for a desktop call, from the JSON body or, for a GET that
 * carries no body, from Basic auth or the two X- headers.
 *
 * Never from the query string. `since` is public and belongs in the URL; a
 * licence key in the URL ends up in the access log, in the proxy log and in
 * the browser history of whoever pastes it once.
 */
function chain_credentials(array $in): array {
    if (!empty($in['client_id']) && !empty($in['licence_key'])) return $in;

    $h = [];
    foreach ($_SERVER as $k => $v) {
        if (strpos($k, 'HTTP_') === 0) $h[str_replace('_', '-', substr($k, 5))] = $v;
    }
    $auth = $h['AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if (stripos($auth, 'Basic ') === 0) {
        $pair = base64_decode(substr($auth, 6), true);
        if ($pair !== false && strpos($pair, ':') !== false) {
            [$u, $p] = explode(':', $pair, 2);
            $in['client_id'] = $in['client_id'] ?? $u;
            $in['licence_key'] = $in['licence_key'] ?? $p;
        }
    }
    if (empty($in['client_id']) && isset($h['X-CLIENT-ID'])) $in['client_id'] = $h['X-CLIENT-ID'];
    if (empty($in['licence_key']) && isset($h['X-LICENCE-KEY'])) $in['licence_key'] = $h['X-LICENCE-KEY'];
    if (empty($in['device_id']) && isset($h['X-DEVICE-ID'])) $in['device_id'] = $h['X-DEVICE-ID'];
    return $in;
}
