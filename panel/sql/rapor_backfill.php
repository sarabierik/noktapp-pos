<?php
/**
 * Materialise the day-ends already sitting in np_reports into np_branch_days.
 *
 * Run once after importing sql/rapor_schema.sql, and any time you want to
 * rebuild the table from source - after correcting a till that was bound to
 * the wrong branch, for instance, because the branch is resolved again from
 * np_devices as it stands now.
 *
 *   php sql/rapor_backfill.php            # every tenant
 *   php sql/rapor_backfill.php 22         # one tenant
 *
 * Safe to run as many times as you like: every write goes through the same
 * idempotent upsert the live endpoint uses, so a day cannot be counted twice.
 * A push whose till was never bound to a branch is skipped, not guessed at -
 * that is a single-shop customer and they get no rows in this table at all.
 */
require_once __DIR__ . '/../lib/rapor.php';

$tenantId = (int) ($argv[1] ?? 0);
$n = rapor_backfill($tenantId);
$total = (int) val('SELECT COUNT(*) FROM np_branch_days' . ($tenantId ? ' WHERE tenant_id=' . $tenantId : ''));
echo "np_branch_days: {$n} gün sonu işlendi, tabloda toplam {$total} satır var.\n";
