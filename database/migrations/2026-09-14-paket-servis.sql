-- ---------------------------------------------------------------------------
-- PAKET SERVİS — the restaurant's OWN delivery, and the board every delivery
-- lands on whatever door it came through.
--
-- Same rule as the platform integration beside it: none of these is an order
-- table. A delivery is an ORDINARY adisyon in `orders` - opened through
-- modules/orders, priced by recalc, printed through print/index.js, counted in
-- the Z report because it IS a bill. What the till had nowhere to keep was the
-- half of a delivery that a table order has no use for: where it goes, who is
-- carrying it, and how much of the restaurant's cash is in that person's
-- pocket right now. That is `delivery_orders`: a companion row beside the
-- bill, one to one, never instead of it.
--
--   delivery_zones      the fee. A restaurant that wants one flat fee gets the
--                       single default zone and never opens this screen; one
--                       that charges more for the far side of town adds rows.
--                       There is ALWAYS exactly one default zone per tenant so
--                       an order can never fail for want of a fee.
--   customer_addresses  many per customer, with the door note attached. The
--                       note is the point: "kapıda zil çalışmıyor, arayın" is
--                       the difference between a delivery and a phone call,
--                       and it belongs to the ADDRESS, not to one order.
--   couriers            a courier may or may not be a `users` row. Most are
--                       not - they never touch the till - so user_id is
--                       nullable and the name stands on its own.
--   courier_shifts      one row per courier per stretch of work, and the thing
--                       that makes the money add up: cash collected on the
--                       road is the restaurant's money sitting in somebody's
--                       jacket until it is handed in. `cash_expected_minor` is
--                       recomputed from the bills, never accumulated, for the
--                       same reason the pos_shifts figures are.
--   delivery_orders     the companion row. Status, courier, address SNAPSHOT.
--   delivery_events     who moved it, when, from what to what.
--
-- WHY THE ADDRESS IS SNAPSHOT ONTO THE ORDER.
-- A customer edits their address - moves flat, fixes a typo - and every past
-- delivery would otherwise silently claim it went somewhere it did not. The
-- courier's own printed slip has to keep saying what it said on the night.
-- `address_text` is therefore written once, at order time, and never chased.
--
-- MONEY IS IN MINOR UNITS, like pos_shifts and unlike orders. Cash that has to
-- reconcile to the kuruş does not go through a DECIMAL round trip.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `delivery_zones` (
  `id`            int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`     int(11) NOT NULL,
  `name`          varchar(120) NOT NULL,
  `fee`           decimal(10,2) NOT NULL DEFAULT 0.00,
  `min_order`     decimal(10,2) NOT NULL DEFAULT 0.00,
  `est_minutes`   smallint(5) UNSIGNED NOT NULL DEFAULT 30,
  `is_default`    tinyint(1) NOT NULL DEFAULT 0 COMMENT 'the zone an address falls back to',
  `sort_order`    int(11) NOT NULL DEFAULT 0,
  `is_active`     tinyint(1) NOT NULL DEFAULT 1,
  `created_at`    datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at`    datetime DEFAULT NULL ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_dz_client` (`client_id`, `is_active`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

CREATE TABLE IF NOT EXISTS `customer_addresses` (
  `id`            int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`     int(11) NOT NULL,
  `customer_id`   int(10) UNSIGNED NOT NULL,
  `tag`           varchar(16) NOT NULL DEFAULT 'EV' COMMENT 'EV | IS | DIGER, free text',
  `zone_id`       int(10) UNSIGNED DEFAULT NULL,
  `district`      varchar(120) DEFAULT NULL COMMENT 'mahalle / semt',
  `address_text`  varchar(400) NOT NULL,
  `directions`    varchar(255) DEFAULT NULL COMMENT 'kapıda zil çalışmıyor, 3. kat, arka bahçe',
  `lat`           decimal(10,7) DEFAULT NULL,
  `lng`           decimal(10,7) DEFAULT NULL,
  `is_default`    tinyint(1) NOT NULL DEFAULT 0,
  `is_active`     tinyint(1) NOT NULL DEFAULT 1,
  `created_at`    datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at`    datetime DEFAULT NULL ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_ca_customer` (`client_id`, `customer_id`, `is_active`),
  KEY `idx_ca_zone` (`client_id`, `zone_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

CREATE TABLE IF NOT EXISTS `couriers` (
  `id`            int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`     int(11) NOT NULL,
  `user_id`       int(11) DEFAULT NULL COMMENT 'set only when the courier also signs in',
  `name`          varchar(120) NOT NULL,
  `phone`         varchar(40) DEFAULT NULL,
  `is_active`     tinyint(1) NOT NULL DEFAULT 1,
  `created_at`    datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at`    datetime DEFAULT NULL ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_ku_client` (`client_id`, `is_active`),
  KEY `idx_ku_user` (`client_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

CREATE TABLE IF NOT EXISTS `courier_shifts` (
  `id`                  bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`           int(11) NOT NULL,
  `courier_id`          int(10) UNSIGNED NOT NULL,
  `business_date`       date NOT NULL,
  `pos_shift_id`        bigint(20) UNSIGNED DEFAULT NULL COMMENT 'the till shift it opened under',
  `opened_at`           datetime NOT NULL DEFAULT current_timestamp(),
  `opened_by`           int(11) NOT NULL DEFAULT 0,
  `closed_at`           datetime DEFAULT NULL,
  `closed_by`           int(11) DEFAULT NULL,
  `cash_expected_minor` bigint(20) NOT NULL DEFAULT 0 COMMENT 'recomputed from the bills at settlement',
  `cash_taken_minor`    bigint(20) NOT NULL DEFAULT 0 COMMENT 'what the cashier actually took in',
  `variance_minor`      bigint(20) NOT NULL DEFAULT 0,
  `deliveries`          int(11) NOT NULL DEFAULT 0,
  `note`                varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ks_open` (`client_id`, `courier_id`, `closed_at`),
  KEY `idx_ks_day` (`client_id`, `business_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

-- A courier has at most ONE open shift. Same trick as daily_closings: a
-- generated column that is the courier while the shift is open and NULL once
-- it is closed, with a unique index over it. MySQL lets NULLs repeat inside a
-- unique index, so closed shifts stack up freely and a second open one cannot
-- be created even by two cashiers pressing at the same moment.
ALTER TABLE `courier_shifts`
  ADD COLUMN IF NOT EXISTS `open_courier_id` int(10) UNSIGNED
    GENERATED ALWAYS AS (IF(`closed_at` IS NULL, `courier_id`, NULL)) STORED;
ALTER TABLE `courier_shifts`
  ADD UNIQUE KEY IF NOT EXISTS `uq_ks_open` (`client_id`, `open_courier_id`);

CREATE TABLE IF NOT EXISTS `delivery_orders` (
  `id`              bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`       int(11) NOT NULL,
  `order_id`        int(10) UNSIGNED NOT NULL COMMENT 'the adisyon in `orders` - one to one',
  `business_date`   date NOT NULL,
  `source`          varchar(24) NOT NULL DEFAULT 'PHONE'
                    COMMENT 'PHONE | COUNTER | UBER_EATS_TGO | YEMEKSEPETI | MIGROS_YEMEK | GETIR_YEMEK',
  `int_order_id`    bigint(20) UNSIGNED DEFAULT NULL COMMENT 'np_int_orders.id when it came from a platform',
  `customer_id`     int(10) UNSIGNED DEFAULT NULL,
  `address_id`      int(10) UNSIGNED DEFAULT NULL COMMENT 'null for a platform order - we get text, not a row',
  `zone_id`         int(10) UNSIGNED DEFAULT NULL,
  `customer_name`   varchar(160) DEFAULT NULL,
  `phone`           varchar(40) DEFAULT NULL,
  `address_text`    varchar(400) NOT NULL DEFAULT '' COMMENT 'SNAPSHOT - never chased if the address is edited',
  `directions`      varchar(255) DEFAULT NULL,
  `delivery_fee`    decimal(10,2) NOT NULL DEFAULT 0.00,
  `status`          varchar(16) NOT NULL DEFAULT 'NEW'
                    COMMENT 'NEW | PREPARING | ON_ROUTE | DELIVERED | CANCELLED',
  `courier_id`      int(10) UNSIGNED DEFAULT NULL,
  `courier_shift_id` bigint(20) UNSIGNED DEFAULT NULL,
  `is_prepaid`      tinyint(1) NOT NULL DEFAULT 0 COMMENT 'the platform already took the money',
  `payment_method`  varchar(24) DEFAULT NULL COMMENT 'what the courier is expected to collect',
  `cash_collected_minor` bigint(20) NOT NULL DEFAULT 0,
  `promised_minutes` smallint(5) UNSIGNED NOT NULL DEFAULT 30,
  `note`            varchar(255) DEFAULT NULL,
  `created_by`      int(11) NOT NULL DEFAULT 0,
  `created_at`      datetime NOT NULL DEFAULT current_timestamp(),
  `assigned_at`     datetime DEFAULT NULL,
  `dispatched_at`   datetime DEFAULT NULL,
  `delivered_at`    datetime DEFAULT NULL,
  `cancelled_at`    datetime DEFAULT NULL,
  `cancel_reason`   varchar(190) DEFAULT NULL,
  `updated_at`      datetime DEFAULT NULL ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  -- one companion row per bill. Two "Yeni paket siparişi" taps on the same
  -- adisyon collide here rather than putting the order on the board twice.
  UNIQUE KEY `uq_do_order` (`client_id`, `order_id`),
  KEY `idx_do_board` (`client_id`, `status`, `created_at`),
  KEY `idx_do_courier` (`client_id`, `courier_id`, `status`),
  KEY `idx_do_day` (`client_id`, `business_date`),
  KEY `idx_do_int` (`client_id`, `int_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

CREATE TABLE IF NOT EXISTS `delivery_events` (
  `id`            bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`     int(11) NOT NULL,
  `delivery_id`   bigint(20) UNSIGNED NOT NULL,
  `from_status`   varchar(16) DEFAULT NULL,
  `to_status`     varchar(16) NOT NULL,
  `courier_id`    int(10) UNSIGNED DEFAULT NULL,
  `actor_id`      int(11) NOT NULL DEFAULT 0,
  `actor_name`    varchar(120) DEFAULT NULL,
  `note`          varchar(255) DEFAULT NULL,
  `created_at`    datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_de_delivery` (`client_id`, `delivery_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

-- Give every tenant that already exists one default zone, so an install that
-- is upgraded into this release has a working delivery fee from the first
-- order without anyone opening the Bölgeler tab.
--
-- This is a convenience, NOT the guarantee. On a brand new machine the
-- migrations run before setup has created anything at all, so there is no
-- tenant here to seed and this statement matches nothing. The guarantee is
-- `ensureDefaultZone()` in modules/delivery.js, which creates the zone the
-- first time a delivery needs one. A migration cannot know a client_id that
-- does not exist yet, and pretending otherwise by hardcoding 1 is how a
-- second tenant ends up quietly using the first one's delivery fee.
INSERT INTO `delivery_zones` (`client_id`, `name`, `fee`, `est_minutes`, `is_default`, `sort_order`)
SELECT c.client_id, 'Standart bölge', 0.00, 30, 1, 0
  FROM (SELECT DISTINCT `client_id` FROM `users`
        UNION SELECT DISTINCT `client_id` FROM `orders`) c
 WHERE NOT EXISTS (
   SELECT 1 FROM `delivery_zones` z WHERE z.`client_id` = c.`client_id` AND z.`is_default` = 1);
