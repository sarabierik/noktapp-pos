-- ---------------------------------------------------------------------------
-- YEMEK PLATFORMU ENTEGRASYONU — Uber Eats Trendyol Go, Yemeksepeti,
-- Migros Yemek, Getir (eski).
--
-- Why these tables exist at all, and why NONE of them is an order table.
--
-- A platform order is an ORDINARY paket adisyon. It is opened through
-- modules/orders, it is priced by recalc, it prints through print/index.js,
-- its stock moves in closeIfPaid like every other bill, and it appears in the
-- Z report because it IS in `orders`. Nothing here duplicates that. What the
-- till did not have was somewhere to keep the PLATFORM's own view of the same
-- sale - the id Trendyol knows it by, the status Yemeksepeti is waiting for,
-- the raw payload support has to look at when the restaurant says "the order
-- came in wrong". That is `np_int_orders`: a MIRROR beside the real bill, with
-- a foreign key to it, never instead of it.
--
--  1. np_int_connections  one row per (tenant, branch, provider). Credentials
--     are stored ENCRYPTED (AES-256-GCM, src/integrations/crypto.js) in
--     `credentials_enc`; `cred_hint` is the masked text the screen shows so
--     the UI never needs the plaintext back. A provider is disabled by
--     default - GETIR_LEGACY doubly so, because new Getir orders arrive
--     through TGO now and the legacy connector is only for a restaurant that
--     already holds legacy credentials.
--
--  2. np_int_orders  the mirror. The unique key
--     (client_id, provider, provider_store_id, external_order_id,
--      external_package_id)
--     is the whole idempotency story: the poller and the webhook can deliver
--     the same package any number of times and the second INSERT collides
--     instead of opening a second adisyon. The three text columns are NOT
--     NULL with a '' default ON PURPOSE - MySQL lets NULLs repeat inside a
--     UNIQUE index, so a nullable provider_store_id would quietly let the
--     same order in twice.
--     `accept_print_job_id` / `cancel_print_job_id` are the same trick for
--     paper: the print job is claimed with a compare-and-set UPDATE, so a
--     provider that retries its webhook five times still produces exactly one
--     kitchen slip and exactly one cancellation notice.
--
--  3. np_int_order_items  external line -> order_items line. Needed for
--     PARTIAL item cancellation, which some platforms support and which
--     cannot be done by matching on product name.
--
--  4. np_int_events  every raw event, webhook or poll, before it is looked
--     at. The pipeline persists here first and answers the provider
--     immediately; processing happens afterwards, so a slow local database
--     can never make us miss the provider's acknowledgement window.
--     `event_key` is unique per tenant+provider - that is webhook replay
--     protection. `status='dead'` is the dead-letter shelf.
--
--  5. np_int_cursors  the poller's memory: the last modification timestamp we
--     successfully consumed, per supplier. Polling is SUPPLIER-WIDE and the
--     rows are routed to branches by store id, so there is one cursor per
--     supplier and not one poller per branch. `backoff_until` and
--     `consecutive_errors` are where the exponential backoff with jitter
--     lives across restarts.
--
--  6. np_int_menu_map  NOKTApp entity <-> provider entity, for branch,
--     category, product, modifier group and modifier. Carries the provider's
--     own price, availability and tax rate, because those are the platform's
--     numbers and not ours.
--
--  7. np_int_logs  the sync/audit trail the Entegrasyonlar screen reads.
--
-- Idempotent: every statement is CREATE TABLE IF NOT EXISTS / ADD COLUMN IF
-- NOT EXISTS, because the desktop shell replays this whole folder on boot.
-- ---------------------------------------------------------------------------

-- --------------------------------------------------------------- connections
CREATE TABLE IF NOT EXISTS `np_int_connections` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `branch_id` int(11) NOT NULL DEFAULT 1 COMMENT 'tek kurulum = tek sube, ileride zincir icin',
  `provider` varchar(32) NOT NULL COMMENT 'UBER_EATS_TGO | YEMEKSEPETI | MIGROS_YEMEK | GETIR_YEMEK',
  `environment` enum('stage','production','simulator') NOT NULL DEFAULT 'simulator',
  `enabled` tinyint(1) NOT NULL DEFAULT 0,
  `credentials_enc` mediumtext DEFAULT NULL COMMENT 'AES-256-GCM zarf; asla duz metin donmez',
  `cred_hint` varchar(255) DEFAULT NULL COMMENT 'ekranda gosterilen maskeli ozet',
  `provider_store_id` varchar(64) NOT NULL DEFAULT '' COMMENT 'restoran/store/vendor kodu',
  `supplier_id` varchar(64) NOT NULL DEFAULT '' COMMENT 'TGO supplierId / DH chain code',
  `chain_id` varchar(64) NOT NULL DEFAULT '' COMMENT 'Migros restoran grup id',
  `acceptance_mode` enum('PROVIDER_TABLET','POS_DIRECT') NOT NULL DEFAULT 'PROVIDER_TABLET',
  `auto_accept` tinyint(1) NOT NULL DEFAULT 0,
  `default_prep_minutes` smallint(6) NOT NULL DEFAULT 20,
  `delivery_minutes` smallint(6) NOT NULL DEFAULT 40,
  `poll_interval_sec` smallint(6) NOT NULL DEFAULT 7 COMMENT '5-10 sn arasi',
  `station_id` int(10) unsigned DEFAULT NULL COMMENT 'mutfak fisi hangi istasyona',
  `receipt_station_id` int(10) unsigned DEFAULT NULL COMMENT 'paket fisi hangi yaziciya',
  `restaurant_open` tinyint(1) NOT NULL DEFAULT 1,
  `status` varchar(24) NOT NULL DEFAULT 'disconnected' COMMENT 'connected|disconnected|error',
  `last_ok_at` datetime DEFAULT NULL,
  `last_sync_at` datetime DEFAULT NULL,
  `last_error` varchar(500) DEFAULT NULL,
  `last_error_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_conn` (`client_id`,`provider`,`branch_id`),
  KEY `ix_enabled` (`enabled`,`provider`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------- order mirror
CREATE TABLE IF NOT EXISTS `np_int_orders` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL COMMENT 'tenant',
  `branch_id` int(11) NOT NULL DEFAULT 1,
  `connection_id` int(10) unsigned DEFAULT NULL,
  `order_id` int(10) unsigned DEFAULT NULL COMMENT 'orders.id - gercek POS adisyonu',
  `provider` varchar(32) NOT NULL,
  `provider_store_id` varchar(64) NOT NULL DEFAULT '',
  `external_order_id` varchar(64) NOT NULL DEFAULT '',
  `external_package_id` varchar(64) NOT NULL DEFAULT '',
  `external_no` varchar(64) DEFAULT NULL COMMENT 'musteriye gorunen siparis numarasi',
  `source_application` varchar(32) DEFAULT NULL COMMENT 'Trendyol | TrendyolGo | Galaxy | ...',
  `provider_status` varchar(48) DEFAULT NULL COMMENT 'platformun kendi durumu, oldugu gibi',
  `status` varchar(16) NOT NULL DEFAULT 'RECEIVED'
      COMMENT 'RECEIVED ACCEPTED PREPARING READY DISPATCHED DELIVERED REJECTED CANCELLED',
  `acceptance_mode` enum('PROVIDER_TABLET','POS_DIRECT') NOT NULL DEFAULT 'PROVIDER_TABLET',
  `fulfillment_type` varchar(24) DEFAULT NULL COMMENT 'PLATFORM_COURIER|RESTAURANT_COURIER|PICKUP',
  `payment_type` varchar(32) DEFAULT NULL,
  `is_prepaid` tinyint(1) NOT NULL DEFAULT 0 COMMENT '1 ise kasada bir daha odeme ISTENMEZ',
  `provider_total` decimal(10,2) NOT NULL DEFAULT 0.00,
  `delivery_charge` decimal(10,2) NOT NULL DEFAULT 0.00,
  `promotion_total` decimal(10,2) NOT NULL DEFAULT 0.00,
  `coupon_total` decimal(10,2) NOT NULL DEFAULT 0.00,
  `promotions_json` mediumtext DEFAULT NULL,
  `customer_label` varchar(120) DEFAULT NULL COMMENT 'maskeli ad - KVKK',
  `customer_phone` varchar(48) DEFAULT NULL COMMENT 'maskeli',
  `address_label` varchar(255) DEFAULT NULL COMMENT 'maskeli',
  `customer_note` varchar(500) DEFAULT NULL,
  `scheduled_at` datetime DEFAULT NULL COMMENT 'ileri tarihli siparis',
  `prep_minutes` smallint(6) DEFAULT NULL,
  `reject_reason` varchar(120) DEFAULT NULL,
  `cancel_reason` varchar(255) DEFAULT NULL,
  `raw_json` longtext DEFAULT NULL COMMENT 'saglayicinin gonderdigi ham govde',
  `normalized_json` longtext DEFAULT NULL,
  `unmapped_count` smallint(6) NOT NULL DEFAULT 0,
  `accept_print_job_id` int(11) DEFAULT NULL COMMENT 'tek fis garantisi - compare and set',
  `cancel_print_job_id` int(11) DEFAULT NULL,
  `reprint_count` smallint(6) NOT NULL DEFAULT 0,
  `provider_created_at` datetime DEFAULT NULL,
  `provider_modified_at` datetime DEFAULT NULL,
  `received_at` datetime NOT NULL DEFAULT current_timestamp(),
  `accepted_at` datetime DEFAULT NULL,
  `closed_at` datetime DEFAULT NULL,
  `last_event_at` datetime DEFAULT NULL,
  `synced_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_external` (`client_id`,`provider`,`provider_store_id`,`external_order_id`,`external_package_id`),
  KEY `ix_order` (`client_id`,`order_id`),
  KEY `ix_status` (`client_id`,`status`,`received_at`),
  KEY `ix_provider` (`provider`,`provider_modified_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `np_int_order_items` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `int_order_id` bigint(20) unsigned NOT NULL,
  `order_item_id` int(10) unsigned DEFAULT NULL COMMENT 'order_items.id',
  `external_item_id` varchar(64) NOT NULL DEFAULT '',
  `external_name` varchar(190) DEFAULT NULL,
  `product_id` int(10) unsigned DEFAULT NULL,
  `qty` decimal(10,2) NOT NULL DEFAULT 1.00,
  `unit_price` decimal(10,2) NOT NULL DEFAULT 0.00,
  `line_total` decimal(10,2) NOT NULL DEFAULT 0.00,
  `role` varchar(16) NOT NULL DEFAULT 'item' COMMENT 'item|modifier|fee',
  `status` varchar(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE|CANCELLED',
  `mapped` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_line` (`int_order_id`,`external_item_id`,`role`),
  KEY `ix_int_order` (`int_order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------- raw event log
CREATE TABLE IF NOT EXISTS `np_int_events` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `provider` varchar(32) NOT NULL,
  `source` varchar(12) NOT NULL DEFAULT 'poll' COMMENT 'poll|webhook|manual',
  `event_key` varchar(190) NOT NULL COMMENT 'tekrar gelen ayni olay = ayni anahtar',
  `event_type` varchar(48) DEFAULT NULL,
  `provider_store_id` varchar(64) NOT NULL DEFAULT '',
  `external_order_id` varchar(64) NOT NULL DEFAULT '',
  `external_package_id` varchar(64) NOT NULL DEFAULT '',
  `signature_ok` tinyint(1) NOT NULL DEFAULT 1,
  `payload` longtext DEFAULT NULL,
  `status` enum('new','processing','done','failed','dead') NOT NULL DEFAULT 'new',
  `attempts` smallint(6) NOT NULL DEFAULT 0,
  `last_error` varchar(500) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `processed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_event` (`client_id`,`provider`,`event_key`),
  KEY `ix_pending` (`status`,`attempts`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------- poll cursors
CREATE TABLE IF NOT EXISTS `np_int_cursors` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `provider` varchar(32) NOT NULL,
  `scope` varchar(64) NOT NULL DEFAULT '' COMMENT 'supplierId - sube degil, tedarikci',
  `last_modified_at` datetime DEFAULT NULL COMMENT 'basariyla islenen en son degisiklik zamani',
  `last_cursor` varchar(190) DEFAULT NULL,
  `last_run_at` datetime DEFAULT NULL,
  `last_ok_at` datetime DEFAULT NULL,
  `consecutive_errors` smallint(6) NOT NULL DEFAULT 0,
  `backoff_until` datetime DEFAULT NULL,
  `last_error` varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cursor` (`client_id`,`provider`,`scope`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- menu map
CREATE TABLE IF NOT EXISTS `np_int_menu_map` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `branch_id` int(11) NOT NULL DEFAULT 1,
  `provider` varchar(32) NOT NULL,
  `entity_type` varchar(20) NOT NULL COMMENT 'branch|category|product|modifier_group|modifier',
  `external_id` varchar(96) NOT NULL,
  `external_name` varchar(190) DEFAULT NULL,
  `external_parent_id` varchar(96) DEFAULT NULL,
  `local_id` int(10) unsigned DEFAULT NULL COMMENT 'products.id / categories.id',
  `local_ref` varchar(190) DEFAULT NULL COMMENT 'esi olmayan varyant icin serbest metin',
  `provider_price` decimal(10,2) DEFAULT NULL,
  `tax_rate` decimal(5,2) DEFAULT NULL,
  `is_available` tinyint(1) NOT NULL DEFAULT 1,
  `mapped_by` varchar(8) NOT NULL DEFAULT 'auto' COMMENT 'auto|manual',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_map` (`client_id`,`provider`,`branch_id`,`entity_type`,`external_id`),
  KEY `ix_local` (`client_id`,`entity_type`,`local_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ------------------------------------------------------------------- logs
CREATE TABLE IF NOT EXISTS `np_int_logs` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `provider` varchar(32) NOT NULL DEFAULT '',
  `branch_id` int(11) NOT NULL DEFAULT 1,
  `level` varchar(8) NOT NULL DEFAULT 'info' COMMENT 'info|warn|error',
  `action` varchar(48) NOT NULL DEFAULT '',
  `order_id` int(10) unsigned DEFAULT NULL,
  `external_order_id` varchar(64) DEFAULT NULL,
  `message` varchar(500) NOT NULL DEFAULT '',
  `detail` mediumtext DEFAULT NULL COMMENT 'yetki basliklari ve kisisel veri temizlenmis',
  `actor` varchar(120) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `ix_log` (`client_id`,`provider`,`created_at`),
  KEY `ix_level` (`level`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
