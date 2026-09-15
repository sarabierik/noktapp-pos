-- ---------------------------------------------------------------------------
-- CİHAZ / ÇEVRİMDIŞI / SENKRON
--
-- Three small things the device screen needs and the schema did not have.
--
--  1. `app_device_numbers` and `app_order_counters` are declared in
--     01_schema_core.sql, but an installation that was migrated from an older
--     core (the PHP product shipped them only in _app_setup/003_offline.sql,
--     which plenty of installs never ran) has neither. Without them a device
--     cannot be given a bill-number prefix, which means it cannot open a bill
--     at all while the network is down - the one moment the whole feature
--     exists for. They are repeated here as IF NOT EXISTS so a desktop that
--     replays the migration folder on boot ends up with them either way.
--
--  2. Releasing a prefix is a DELETE, because `uq_prefix (client_id, prefix)`
--     is what makes allocation race-safe and a "released" row still occupying
--     the unique key would defeat it. That leaves no trace, and the trace is
--     the thing support needs: a prefix handed to a second tablet while bills
--     minted by the first are still sitting unsynced in its outbox produces
--     two bills with the same adisyon number, which is the exact failure the
--     prefix scheme exists to prevent. `app_device_number_history` keeps the
--     record the delete throws away.
--
--  3. `np_app_log` is only indexed by (area, created_at). The support view
--     filters by level and by time far more often than by area, and at 100k
--     rows on a restaurant PC's disk that is a table scan per keystroke.
--
-- Re-running this file is harmless: every statement is IF NOT EXISTS, which is
-- what the desktop shell relies on when it replays every migration on boot.
-- ---------------------------------------------------------------------------

-- The permanent bill-number prefix of one till. Prefix 0 belongs to this PC
-- (the server series 1, 2, 3 ...); devices get 1..9 and mint 10001, 20001 ...
-- Both unique keys are load-bearing: uq_device makes allocation idempotent for
-- a device that asks twice, uq_prefix makes two devices asking at the same
-- moment resolve to two different prefixes instead of one shared one.
CREATE TABLE IF NOT EXISTS `app_device_numbers` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `device_id` varchar(64) NOT NULL COMMENT 'cihazin kendi urettigi kimlik',
  `prefix` tinyint(3) unsigned NOT NULL COMMENT '1-9; 0 bu bilgisayarindir',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_device` (`client_id`,`device_id`),
  UNIQUE KEY `uq_prefix` (`client_id`,`prefix`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

-- The per-day, per-prefix counter. `next_no` is read and incremented in one
-- statement (LAST_INSERT_ID) so a busy service never serialises on a row lock.
CREATE TABLE IF NOT EXISTS `app_order_counters` (
  `client_id` int(11) NOT NULL,
  `business_date` date NOT NULL,
  `prefix` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `next_no` int(10) unsigned NOT NULL DEFAULT 1,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`client_id`,`business_date`,`prefix`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

-- Who held which prefix, and when it was taken back.
--
-- `released_at IS NULL` is the live allocation, mirrored from
-- app_device_numbers. The history is not decoration: when the owner retires a
-- tablet and hands its prefix to the next one, the question "did the old
-- device already mint bills on this prefix today" decides whether that is safe
-- or whether it will collide, and after the DELETE there is nowhere else to
-- ask. `numbers_seen` records what the counter had reached at release time.
CREATE TABLE IF NOT EXISTS `app_device_number_history` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `device_id` varchar(64) NOT NULL,
  `device_name` varchar(120) DEFAULT NULL COMMENT 'o andaki ad - cihaz silinse de kayit okunur kalsin',
  `prefix` tinyint(3) unsigned NOT NULL,
  `allocated_at` datetime NOT NULL DEFAULT current_timestamp(),
  `released_at` datetime DEFAULT NULL,
  `released_by` varchar(120) DEFAULT NULL,
  `numbers_seen` int(10) unsigned NOT NULL DEFAULT 0 COMMENT 'birakildiginda o gunun sayaci',
  PRIMARY KEY (`id`),
  KEY `ix_client_prefix` (`client_id`,`prefix`,`id`),
  KEY `ix_client_device` (`client_id`,`device_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

-- The support view reads this table by level and by time.
ALTER TABLE `np_app_log` ADD KEY IF NOT EXISTS `ix_level` (`level`,`created_at`);
ALTER TABLE `np_app_log` ADD KEY IF NOT EXISTS `ix_created` (`created_at`);
