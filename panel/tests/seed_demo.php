<?php
/**
 * Demo fixture - a vendor with fifty restaurant customers.
 *
 * NOT part of the panel. It lives in tests/ because its only jobs are to make
 * the screens reviewable in screenshots and to give tests/panel.php a realistic
 * spread to check its arithmetic against. Nothing in panel/ requires it.
 *
 * Every row it writes is prefixed DEMO / demo-, and it deletes those rows
 * before re-creating them, so it is idempotent and cannot touch the real
 * tenants or the throwaway tenants the chain and rapor suites make.
 *
 * Run:  php panel/tests/seed_demo.php
 *       php panel/tests/seed_demo.php --clean     (remove and stop)
 */
foreach ([
    'NP_DB_HOST' => '127.0.0.1', 'NP_DB_PORT' => '3399', 'NP_DB_NAME' => 'nokpos_panel',
    'NP_DB_USER' => 'noktapp',   'NP_DB_PASS' => 'nokpass',
] as $k => $v) { if (getenv($k) === false) putenv("$k=$v"); }

require_once __DIR__ . '/../lib/db.php';

const DEMO_PREFIX = 'DEMO';

/* ------------------------------ teardown ------------------------------ */
$ids = array_column(all("SELECT id FROM np_tenants WHERE code LIKE '" . DEMO_PREFIX . "%'"), 'id');
foreach ($ids as $id) {
    foreach (['np_branch_overrides', 'np_branch_days', 'np_menu_version_items', 'np_menu_versions',
              'np_menu_products', 'np_menu_categories', 'np_branches', 'np_devices', 'np_backups',
              'np_reports', 'np_relay_messages', 'np_licences'] as $tab) {
        try { q("DELETE FROM {$tab} WHERE tenant_id=?", [(int)$id]); } catch (Throwable $e) {}
    }
    try { q('DELETE FROM np_audit WHERE tenant_id=?', [(int)$id]); } catch (Throwable $e) {}
    q('DELETE FROM np_tenants WHERE id=?', [(int)$id]);
}
q("DELETE FROM np_versions WHERE filename LIKE 'NoktAppPOS-Setup-%'");
echo "temizlendi: " . count($ids) . " demo işletme\n";
foreach (glob(__DIR__ . '/../indir/NoktAppPOS-Setup-*') as $f) @unlink($f);

if (in_array('--clean', $argv, true)) { echo "bitti (yalnızca temizlik)\n"; exit; }

/* ------------------------------ versions ------------------------------ */
/* Three builds, so the adoption screen has something to show. 2.1.0 is the
   current one and its installer is written to indir/; 2.0.4's is deliberately
   NOT written, so the "file missing" warning has a real case to display. */
$releases = [
    ['2.1.0', 'Şube raporu, konsolide ciro, hızlı lisans uzatma.', true,  true],
    ['2.0.4', 'Yazarkasa entegrasyonu düzeltmeleri.',              false, false],
    ['2.0.1', 'Adisyon birleştirme, garson telefonu relay.',       false, true],
];
foreach ($releases as [$v, $notes, $current, $writeFile]) {
    $file = 'NoktAppPOS-Setup-' . $v . '.exe';
    $path = __DIR__ . '/../indir/' . $file;
    $size = 0;
    if ($writeFile) {
        file_put_contents($path, str_repeat("NOKTAPP-DEMO-INSTALLER-PLACEHOLDER\n", 900));
        $size = filesize($path);
    } else {
        $size = 96_452_112; // recorded, but never uploaded - that is the point
    }
    q('INSERT INTO np_versions (version, channel, filename, size_bytes, sha512, release_notes, is_current, released_at)
       VALUES (?,?,?,?,?,?,?, DATE_SUB(NOW(), INTERVAL ? DAY))',
      [$v, 'stable', $file, $size, $writeFile ? base64_encode(hash_file('sha512', $path, true)) : '',
       $notes, $current ? 1 : 0, array_search($v, array_column($releases, 0), true) * 45 + 5]);
}
echo "3 sürüm yayınlandı (v2.1.0 güncel)\n";

/* ------------------------------ customers ------------------------------ */
$names = [
 ['Karadeniz Pide ve Kebap Salonu','Antalya'], ['Kaleiçi Meyhanesi','Antalya'],
 ['Bosphorus Balık Restoran','İstanbul'], ['Anadolu Lokantası','Ankara'],
 ['Zeytindalı Kahvaltı Evi','İzmir'], ['Konyalı Etli Ekmek','Konya'],
 ['Gaziantep Baklavacısı','Gaziantep'], ['Şirinyer Kebapçısı','İzmir'],
 ['Marina Cafe & Bistro','Muğla'], ['Beyoğlu Çorbacısı','İstanbul'],
 ['Uludağ Kahvaltı Bahçesi','Bursa'], ['Çeşme Deniz Restoran','İzmir'],
 ['Kapadokya Şarap Evi','Nevşehir'], ['Adana Ocakbaşı Sofrası','Adana'],
 ['Trabzon Balıkçısı','Trabzon'], ['Alaçatı Otantik Mutfak','İzmir'],
 ['Bodrum Sahil Lokantası','Muğla'], ['Eskişehir Çibörek Salonu','Eskişehir'],
 ['Van Kahvaltı Sarayı','Van'], ['Mardin Taş Konak Restoran','Mardin'],
 ['Sultanahmet Köftecisi','İstanbul'], ['İskender Kebap Merkezi','Bursa'],
 ['Ege Zeytinyağlıları','İzmir'], ['Ordu Fındık Cafe','Ordu'],
 ['Samsun Pide Salonu','Samsun'], ['Kayseri Mantı Evi','Kayseri'],
 ['Denizli Leblebi Kahvesi','Denizli'], ['Fethiye Koy Restoran','Muğla'],
 ['Ayvalık Tost Dükkanı','Balıkesir'], ['Rize Çay Bahçesi','Rize'],
 ['Bolu Aşçılar Lokantası','Bolu'], ['Safranbolu Konak Mutfağı','Karabük'],
 ['Amasya Çekirdeksiz Restoran','Amasya'], ['Tokat Kebap Salonu','Tokat'],
 ['Sivas Köftecisi','Sivas'], ['Malatya Kayısı Cafe','Malatya'],
 ['Hatay Künefecisi','Hatay'], ['Antakya Sofra Restoran','Hatay'],
 ['Mersin Tantuni Durağı','Mersin'], ['Isparta Gül Cafe','Isparta'],
 ['Burdur Şiş Salonu','Burdur'], ['Afyon Sucuk Evi','Afyon'],
 ['Kütahya Çini Restoran','Kütahya'], ['Manisa Mesir Lokantası','Manisa'],
 ['Aydın İncir Cafe','Aydın'], ['Uşak Tarhana Mutfağı','Uşak'],
 ['Edirne Ciğercisi','Edirne'], ['Tekirdağ Köftecisi','Tekirdağ'],
 ['Çanakkale Peynir Helvacısı','Çanakkale'], ['Kırklareli Hardaliye Evi','Kırklareli'],
];

$versions = ['2.1.0', '2.1.0', '2.1.0', '2.0.4', '2.0.1', ''];
$plans = ['standart', 'standart', 'pro', 'pro', 'zincir'];
$prices = ['standart' => 4800, 'pro' => 8400, 'zincir' => 16800];

mt_srand(20260904); // stable output, so re-running does not reshuffle the screenshots
$made = 0; $chainIds = [];

foreach ($names as $i => [$name, $city]) {
    $code = DEMO_PREFIX . str_pad((string)($i + 1), 3, '0', STR_PAD_LEFT);
    $email = 'demo' . ($i + 1) . '@ornek.test';
    $plan = $plans[$i % count($plans)];

    q('INSERT INTO np_tenants (code, company_name, owner_name, email, password_hash, phone,
         tax_number, tax_office, address, city, is_active, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, DATE_SUB(NOW(), INTERVAL ? DAY))',
      [$code, $name, ['Ahmet Yılmaz','Ayşe Demir','Mehmet Kaya','Fatma Şahin','Mustafa Çelik'][$i % 5],
       $email, password_hash('demo1234', PASSWORD_BCRYPT),
       '05' . str_pad((string)mt_rand(0, 99999999), 8, '0', STR_PAD_LEFT),
       (string)mt_rand(1000000000, 9999999999), $city . ' Vergi Dairesi',
       $city . ' merkez', $city, 1, '', mt_rand(30, 900)]);
    $tid = lastId();
    $made++;

    /* Licence: a deliberate spread so every dashboard band has real names in
       it - a few already lapsed, a handful inside 30 days, more at 60 and 90,
       and the majority comfortably far out. */
    $d = $i % 25;
    if     ($d < 2)  { $days = -mt_rand(2, 20);   $st = 'active'; }   // lapsed
    elseif ($d < 6)  { $days = mt_rand(3, 29);    $st = 'active'; }   // < 30
    elseif ($d < 9)  { $days = mt_rand(31, 59);   $st = 'active'; }   // 30-60
    elseif ($d < 12) { $days = mt_rand(61, 89);   $st = 'active'; }   // 60-90
    elseif ($d < 14) { $days = mt_rand(10, 25);   $st = 'trial'; }
    elseif ($d === 14) { $days = mt_rand(40, 300); $st = 'suspended'; }
    else             { $days = mt_rand(120, 700); $st = 'active'; }

    $seats = $plan === 'zincir' ? mt_rand(3, 8) : ($plan === 'pro' ? mt_rand(1, 3) : 1);
    q('INSERT INTO np_licences (tenant_id, licence_key, plan, status, seats, starts_at, expires_at,
         grace_days, price, billing_period)
       VALUES (?,?,?,?,?, DATE_SUB(CURDATE(), INTERVAL 365 DAY), DATE_ADD(NOW(), INTERVAL ? DAY), 7, ?, ?)',
      [$tid, strtoupper(bin2hex(random_bytes(12))), $plan, $st, $seats, $days,
       $prices[$plan], 'yearly']);

    /* Tills. Four customers in fifty have nothing installed at all, which is a
       real state a vendor needs to see and chase. */
    $installed = ($i % 13 !== 5);
    if ($installed) {
        $n = min($seats, mt_rand(1, max(1, $seats)));
        /* Six customers have gone quiet - a spread of days, so the list is not
           uniform and the "N gün" column has something to say. */
        $quiet = in_array($i % 17, [3, 9], true) ? mt_rand(4, 40) : 0;
        for ($k = 0; $k < $n; $k++) {
            $ver = $versions[($i + $k) % count($versions)];
            $seen = $quiet ? 'DATE_SUB(NOW(), INTERVAL ' . ($quiet * 24 + $k) . ' HOUR)'
                           : 'DATE_SUB(NOW(), INTERVAL ' . mt_rand(1, 400) . ' MINUTE)';
            q("INSERT INTO np_devices (tenant_id, device_id, device_name, app_version, os, last_ip,
                 last_seen_at, first_seen_at, is_blocked)
               VALUES (?,?,?,?,?,?, {$seen}, DATE_SUB(NOW(), INTERVAL ? DAY), ?)",
              [$tid, 'demo-' . strtolower($code) . '-' . ($k + 1),
               $k === 0 ? 'Kasa 1' : ($k === 1 ? 'Bar kasası' : 'Kasa ' . ($k + 1)),
               $ver, 'Windows 11 Pro', '88.' . mt_rand(1, 250) . '.' . mt_rand(1, 250) . '.' . mt_rand(1, 250),
               mt_rand(40, 800), ($i % 23 === 7 && $k === 0) ? 1 : 0]);
        }

        /* Backups: most current, some late, a few that never arrived. */
        if ($i % 11 !== 4) {
            $lag = ($i % 7 === 2) ? mt_rand(50, 400) : mt_rand(1, 20);
            for ($b = 0; $b < 4; $b++) {
                q('INSERT INTO np_backups (tenant_id, device_id, filename, path, size_bytes, created_at)
                   VALUES (?,?,?,?,?, DATE_SUB(NOW(), INTERVAL ? HOUR))',
                  [$tid, 'demo-' . strtolower($code) . '-1',
                   'nokpos-' . date('Ymd', time() - $b * 86400) . '.sql.gz',
                   '/backups/' . $tid . '/x.gz', mt_rand(2, 60) * 1048576, $lag + $b * 24]);
            }
        }

        /* Today's turnover summary from most of them. */
        if (!$quiet && $i % 4 !== 1) {
            $orders = mt_rand(38, 260);
            q("INSERT INTO np_reports (tenant_id, entity, entity_id, payload, created_at)
               VALUES (?, 'daily_summary', ?, ?, DATE_SUB(NOW(), INTERVAL ? MINUTE))",
              [$tid, date('Y-m-d'),
               json_encode(['date' => date('Y-m-d'), 'orders' => $orders,
                            'total' => round($orders * mt_rand(180, 720) / 1.0, 2)], JSON_UNESCAPED_UNICODE),
               mt_rand(20, 700)]);
        }
        /* A few day-end closings for the customer page. */
        for ($z = 1; $z <= 6; $z++) {
            $orders = mt_rand(30, 210);
            q("INSERT INTO np_reports (tenant_id, entity, entity_id, payload, created_at)
               VALUES (?, 'daily_closing', ?, ?, DATE_SUB(NOW(), INTERVAL ? DAY))",
              [$tid, date('Y-m-d', strtotime("-{$z} day")),
               json_encode(['date' => date('Y-m-d', strtotime("-{$z} day")), 'orders' => $orders,
                            'net' => round($orders * mt_rand(180, 700), 2)], JSON_UNESCAPED_UNICODE), $z]);
        }
    }

    if ($plan === 'zincir' && count($chainIds) < 3) $chainIds[] = [$tid, $code, $name];
}

/* A few branches for the chain-plan customers, so the chain screens have a
   customer to open. The gate still governs: two branches or nothing. */
foreach ($chainIds as [$tid, $code, $name]) {
    foreach ([['MERKEZ', 'Merkez Şube'], ['SAHIL', 'Sahil Şubesi'], ['AVM', 'AVM Şubesi']] as $j => [$bc, $bn]) {
        q('INSERT INTO np_branches (tenant_id, code, name, city, is_active, menu_version, menu_applied_at)
           VALUES (?,?,?,?,1,?, DATE_SUB(NOW(), INTERVAL ? DAY))',
          [$tid, $bc, $bn, 'Antalya', $j === 2 ? 2 : 3, $j + 1]);
    }
}

echo "{$made} demo işletme, " . (count($chainIds) * 3) . " şube oluşturuldu\n";
echo "aktif işletme toplamı: " . val('SELECT COUNT(*) FROM np_tenants WHERE is_active=1') . "\n";
