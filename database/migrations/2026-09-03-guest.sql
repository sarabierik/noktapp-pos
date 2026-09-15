-- ---------------------------------------------------------------------------
-- MISAFIR TARAFI - dijital menu, musteri karti, sadakat yonetimi.
--
-- The guest-facing half of the product was the half the old system never
-- finished. Three gaps, all of them in columns rather than tables:
--
--   * `qr_menu_settings` could say what the venue is CALLED but not what it
--     looks like: no logo, no welcome line. Every printed card therefore
--     opened a page that was typographically identical to every other
--     restaurant's, which is the one thing a menu on a table must not be.
--   * nothing recorded WHEN the digital menu was last changed, so "the prices
--     on the QR are old" had no answer.
--   * `loyalty_events.note` exists but no screen could write it, so a stamp
--     given by hand at the counter - the one kind that is not evidenced by a
--     bill - was indistinguishable from one the till awarded. A manual stamp
--     with no reason is how a card gets quietly filled for a friend.
--     Nothing is added here for that; the column is simply put to work.
--
-- Re-running this is harmless: MariaDB's IF NOT EXISTS on ADD COLUMN makes a
-- second run a no-op rather than an error, which is what the desktop shell
-- needs since it replays every migration on each start.
-- ---------------------------------------------------------------------------

-- The venue's own mark. A path or a data: URI, not a remote URL we fetch on
-- the guest's phone: the menu has to render on a table with one bar of signal.
ALTER TABLE `qr_menu_settings`
  ADD COLUMN IF NOT EXISTS `logo_url` varchar(255) DEFAULT NULL
  COMMENT 'menunun basindaki isletme logosu - yerel dosya yolu veya data: URI';

-- One line of welcome. `about` already exists and is a paragraph shown at the
-- foot; this is the sentence under the name at the top, and conflating the two
-- meant every venue either had a wall of text at the top or nothing at all.
ALTER TABLE `qr_menu_settings`
  ADD COLUMN IF NOT EXISTS `welcome_text` varchar(400) DEFAULT NULL
  COMMENT 'menunun ustunde gorunen tek satirlik karsilama';

-- A menu without prices is a real request - hotel breakfast rooms, tasting
-- menus, all-inclusive. It is a display switch only; the till is unaffected.
ALTER TABLE `qr_menu_settings`
  ADD COLUMN IF NOT EXISTS `show_prices` tinyint(1) NOT NULL DEFAULT 1
  COMMENT 'fiyatlar misafire gosterilsin mi';

-- "Are the prices on the table today's prices?" needs a timestamp to answer.
ALTER TABLE `qr_menu_settings`
  ADD COLUMN IF NOT EXISTS `updated_at` datetime DEFAULT NULL
  COMMENT 'ayarlarin son degistigi an';

-- The guest page's only query filters on exactly this, and it runs on a phone
-- that is waiting: without the index it is a full scan of the whole menu on
-- every scan of every card.
ALTER TABLE `products`
  ADD KEY IF NOT EXISTS `idx_products_qr` (`client_id`,`use_in_qr`,`sort_order`);

ALTER TABLE `categories`
  ADD KEY IF NOT EXISTS `idx_categories_qr` (`client_id`,`use_in_qr`,`sort_order`);
