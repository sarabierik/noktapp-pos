-- ---------------------------------------------------------------------------
-- PAKET SERVİS — the second half.
--
-- The first release moved orders across a board and reconciled a courier's
-- cash. This adds the things a restaurant asks for in the first week of using
-- it, and fixes one thing that was half-built.
--
--  1. THE ZONE MINIMUM WAS DEAD. `delivery_zones.min_order` has been stored,
--     editable and displayed since day one and nothing anywhere read it. A
--     setting that does nothing is worse than no setting: somebody types 200
--     into it, believes the till is guarding the basket, and it never was.
--     Nothing changes in the schema for this - the fix is in the code - but it
--     is written down here because it is the reason for this migration's date.
--
--  2. KURYE HAKEDİŞİ. Couriers in Turkey are usually paid per drop, not per
--     hour, and until now the till had no idea what a delivery COST. The fee
--     can be set per zone (a far semt is worth more) and overridden per
--     courier (one man is on a different arrangement), and it is SNAPSHOT onto
--     the delivery when the courier is assigned - so raising the rate next
--     month does not silently rewrite what last month's shifts owed.
--
--  3. PARA ÜSTÜ. "He said he'd pay with a five hundred." The courier needs to
--     leave with the change already counted, and that is a number the cashier
--     hears on the phone and has nowhere to put.
--
--  4. İLERİ TARİHLİ SİPARİŞ. An order taken at 15:00 for 20:30 must not sit in
--     the Yeni lane looking late for five hours.
--
--  5. KARA LİSTE. Repeated fake orders and refused deliveries are a real cost
--     in phone delivery. The flag lives on the CUSTOMER and is scoped to this
--     restaurant: `customers` is shared across tenants by the loyalty app, and
--     one restaurant's bad experience is not another's judgement to inherit.
--
--  6. İPTAL SEBEBİ, as a code and not only free text, so the report can say
--     whether it is the kitchen, the courier or the customer.
-- ---------------------------------------------------------------------------

/* ---- 2. courier pay ---------------------------------------------------- */
ALTER TABLE `delivery_zones`
  ADD COLUMN IF NOT EXISTS `courier_fee` decimal(10,2) NOT NULL DEFAULT 0.00
    COMMENT 'what the restaurant pays the courier for a drop in this zone';

ALTER TABLE `couriers`
  ADD COLUMN IF NOT EXISTS `fee_per_delivery` decimal(10,2) DEFAULT NULL
    COMMENT 'overrides the zone rate for this courier; NULL = use the zone';

ALTER TABLE `delivery_orders`
  ADD COLUMN IF NOT EXISTS `courier_fee` decimal(10,2) NOT NULL DEFAULT 0.00
    COMMENT 'SNAPSHOT at assignment - a later rate change must not rewrite it';

ALTER TABLE `courier_shifts`
  ADD COLUMN IF NOT EXISTS `earned_minor` bigint(20) NOT NULL DEFAULT 0
    COMMENT 'what the courier earned in this shift, recomputed at settlement';

/* ---- 3. para üstü ------------------------------------------------------ */
ALTER TABLE `delivery_orders`
  ADD COLUMN IF NOT EXISTS `change_for_minor` bigint(20) NOT NULL DEFAULT 0
    COMMENT 'the note the guest said they would pay with, 0 when they did not say';

/* ---- 4. ileri tarihli -------------------------------------------------- */
ALTER TABLE `delivery_orders`
  ADD COLUMN IF NOT EXISTS `scheduled_at` datetime DEFAULT NULL
    COMMENT 'when the guest asked for it; NULL means as soon as possible';

/* ---- 6. iptal sebebi --------------------------------------------------- */
ALTER TABLE `delivery_orders`
  ADD COLUMN IF NOT EXISTS `cancel_code` varchar(24) DEFAULT NULL
    COMMENT 'MUSTERI_VAZGECTI | ADRES_BULUNAMADI | ODEME_YOK | MUTFAK | KURYE_YOK | SAHTE | DIGER';

/* An index for the board: scheduled orders are read on every refresh. */
ALTER TABLE `delivery_orders`
  ADD KEY IF NOT EXISTS `idx_do_sched` (`client_id`, `scheduled_at`);

/* ---- 5. kara liste ----------------------------------------------------- */
CREATE TABLE IF NOT EXISTS `customer_flags` (
  `id`          bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `client_id`   int(11) NOT NULL,
  `customer_id` int(10) UNSIGNED NOT NULL,
  `level`       varchar(12) NOT NULL DEFAULT 'watch' COMMENT 'watch | block',
  `reason`      varchar(255) NOT NULL,
  `created_by`  int(11) NOT NULL DEFAULT 0,
  `created_at`  datetime NOT NULL DEFAULT current_timestamp(),
  `cleared_at`  datetime DEFAULT NULL,
  `cleared_by`  int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_cf_customer` (`client_id`, `customer_id`, `cleared_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_turkish_ci;

/* One STANDING flag per customer per restaurant. Cleared flags stack up as
   history - a customer who was blocked twice and forgiven twice is worth
   seeing - and the generated column is NULL for those, so the unique index
   only bites on the live one. Same trick as daily_closings and courier_shifts.
   Every flag ever raised stays readable; only one can be in force. */
ALTER TABLE `customer_flags`
  ADD COLUMN IF NOT EXISTS `active_customer_id` int(10) UNSIGNED
    GENERATED ALWAYS AS (IF(`cleared_at` IS NULL, `customer_id`, NULL)) STORED;
ALTER TABLE `customer_flags`
  ADD UNIQUE KEY IF NOT EXISTS `uq_cf_active` (`client_id`, `active_customer_id`);
