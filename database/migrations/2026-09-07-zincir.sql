-- ---------------------------------------------------------------------------
-- ZİNCİR (çok şubeli) - the till's half of the master menu.
--
-- Head office keeps the house menu in the panel and publishes versions of it.
-- Every till PULLS. What this file adds is the only thing the local database
-- was missing to be able to receive one of those versions without destroying
-- what the branch already has.
--
-- WHY master_code, and why a unique index on it
-- --------------------------------------------
-- A branch's `products.id` has nothing to do with the master row's id: the
-- local rows were created by the seed, by the import, or by hand, years apart,
-- on ten different machines. Matching a published row to a local one by NAME
-- is the obvious shortcut and it is the one that breaks the business: rename
-- "Kofte" to "Izgara Köfte" at head office and every branch grows a second
-- product, the original is orphaned, and every historical order line, recipe
-- and stock movement still points at the old row. So the master's own stable
-- code is carried on the local row and the match is made on that, never on the
-- name. The unique index is what makes "find the local row for this master
-- code" a single lookup and what stops two local rows ever claiming the same
-- master row. NULL is the ordinary case and stays legal: MariaDB treats every
-- NULL in a unique index as distinct, so a shop with 400 local-only products
-- has 400 NULLs here and no conflict. `master_code IS NULL` is the branch's
-- own product and a pull must never touch it.
--
-- WHY the master_* shadow columns
-- -------------------------------
-- `price`, `is_active` on the local row are what the till SELLS at. They are
-- not the same thing as what head office published, because a branch may hold
-- an exception: no pizza oven at Gazipaşa (available=0), or a licensed price
-- on an unlocked product. Those exceptions live in the panel, they are not
-- versioned, and they arrive as the branch's FULL current set on every pull -
-- which means an exception can be REMOVED, and when it is, the till has to put
-- the house value back. With only the effective value stored, "the 25.00
-- override on Çay was withdrawn" would leave the branch selling Çay at 25.00
-- for ever, or until head office happened to publish that product again.
-- So the master's own price, its own active flag and its price_locked flag are
-- kept beside the effective ones. Every pull recomputes:
--
--     effective price     = override price (only if master_price_locked=0)
--                           otherwise master_price
--     effective is_active = master_is_active AND NOT (override.available = 0)
--
-- which is idempotent, survives an incremental pull that does not mention the
-- product at all, and is the reason re-applying a version is a genuine no-op.
--
-- WHY price_change_log gains 'merkez'
-- -----------------------------------
-- The enum was ai / manual / import. A price that arrived from head office is
-- none of the three, and a branch manager who opens the price history of an
-- item that changed overnight is entitled to read "Merkez menü" rather than
-- "Elle" next to a change nobody at the branch made.
--
-- WHY an apply log rather than one more setting
-- ---------------------------------------------
-- The applied version itself is a setting (`menu_version`) because that is
-- what the next pull sends as `since`. What a support call needs is the row
-- before it: which version, at what time, how many rows moved, whether head
-- office was told. One row per apply, so "the menu changed on Tuesday night"
-- has an answer.
--
-- Nothing here is destructive and every statement is guarded, so a second run
-- is a no-op. A single-shop install gets four nullable columns it never fills
-- and one empty table; nothing on its screens and no request it did not
-- already make.
-- ---------------------------------------------------------------------------

-- Ürünler: hangi merkez satırına ait ve merkezin kendi değerleri.
ALTER TABLE `products`
  ADD COLUMN IF NOT EXISTS `master_code` varchar(64) DEFAULT NULL
    COMMENT 'merkez menusundeki satirin kodu; NULL ise sube kendi urunu',
  ADD COLUMN IF NOT EXISTS `master_price` decimal(10,2) DEFAULT NULL
    COMMENT 'merkezin yayinladigi fiyat; yerel fiyat bundan sapabilir (istisna)',
  ADD COLUMN IF NOT EXISTS `master_is_active` tinyint(1) DEFAULT NULL
    COMMENT 'merkezde etkin mi; sube istisnasi bunu kapatabilir ama degistiremez',
  ADD COLUMN IF NOT EXISTS `master_price_locked` tinyint(1) NOT NULL DEFAULT 1
    COMMENT '1 ise sube fiyati degistiremez; merkez fiyati gecerlidir';

ALTER TABLE `products`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_product_master` (`client_id`,`master_code`);

-- Kategoriler. station_id burada YOK ve olmayacak: istasyon binaya ait bir
-- bilgidir (sozlesme, bolum 7), merkez onu bilemez ve ezemez.
ALTER TABLE `categories`
  ADD COLUMN IF NOT EXISTS `master_code` varchar(64) DEFAULT NULL
    COMMENT 'merkez menusundeki kategorinin kodu; NULL ise subenin kendi kategorisi',
  ADD COLUMN IF NOT EXISTS `master_is_active` tinyint(1) DEFAULT NULL
    COMMENT 'merkezde etkin mi';

ALTER TABLE `categories`
  ADD UNIQUE KEY IF NOT EXISTS `uniq_category_master` (`client_id`,`master_code`);

-- Fiyat gecmisi: merkezden gelen degisiklik kendi kaynagiyla yazilsin.
-- MODIFY is not guarded because it does not need to be - writing the same
-- definition twice is a no-op, and the enum must end up with all four values
-- whether the first run happened or not.
ALTER TABLE `price_change_log`
  MODIFY COLUMN `source` enum('ai','manual','import','merkez') NOT NULL DEFAULT 'manual';

-- Uygulanan surumlerin defteri. Bir satir = bir pull'un sonucu.
CREATE TABLE IF NOT EXISTS `np_menu_apply_log` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `client_id` int(11) NOT NULL,
  `branch_id` int(11) DEFAULT NULL,
  `version` int(11) NOT NULL,
  `full_pull` tinyint(1) NOT NULL DEFAULT 0,
  `inserted` int(11) NOT NULL DEFAULT 0,
  `updated` int(11) NOT NULL DEFAULT 0,
  `deactivated` int(11) NOT NULL DEFAULT 0,
  `acked` tinyint(1) NOT NULL DEFAULT 0,
  `note` varchar(255) DEFAULT NULL,
  `applied_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_apply_client` (`client_id`,`applied_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
