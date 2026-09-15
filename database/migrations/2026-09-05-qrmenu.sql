-- ---------------------------------------------------------------------------
-- QR MENU - sablon secimi, masa karti tasarimi, urun gorseli.
--
-- Three columns, one job each. All of them exist because something that was
-- previously a decision taken in code has to become a decision the restaurant
-- takes for itself, and survive a restart.
--
--  * qr_menu_settings.template
--      Which of the twelve guest-menu designs the karekod opens. The designs
--      are twelve stylesheets over ONE page (public/menu.html): forking the
--      markup would mean a menu bug has to be fixed twelve times. Stored as a
--      key, not as CSS - a stylesheet in a column is a stylesheet nobody can
--      review, and an injection hole on the one page served without a login.
--      Default 'noktapp' so an existing venue keeps exactly the page it has.
--
--  * qr_menu_settings.card_design
--      Which A5 table card gets printed. Same reasoning, different paper.
--
--  * products.image_url
--      The photo-led template ('fotograf') needs somewhere to read a photo
--      from, and until now `products` had no such column - the QR menu could
--      only ever be a price list. NULL is the normal case and every template
--      is built to look finished without it, because most venues will never
--      photograph two hundred products.
--
--      It is a path/URL and not a data: URI on purpose: this column is read by
--      the till's product list on every menu load, and a base64 photograph in
--      a row that is SELECTed a hundred times an hour is a slow till.
--
-- The table token itself needs no migration: restaurant_tables.qr_token is
-- already varchar(32) UNIQUE with qr_token_at beside it, which is the shape a
-- printed card needs (stable, random, re-issuable per table).
--
-- Re-running this is harmless.
-- ---------------------------------------------------------------------------

ALTER TABLE `qr_menu_settings`
  ADD COLUMN IF NOT EXISTS `template` varchar(24) NOT NULL DEFAULT 'noktapp'
    COMMENT 'misafir menusu tasarimi - public/menu-templates.css anahtari',
  ADD COLUMN IF NOT EXISTS `card_design` varchar(24) NOT NULL DEFAULT 'klasik'
    COMMENT 'A5 masa karti tasarimi - klasik|cerceve|serit';

ALTER TABLE `products`
  ADD COLUMN IF NOT EXISTS `image_url` varchar(255) DEFAULT NULL
    COMMENT 'misafir menusundeki urun fotografi (yol ya da adres, data: URI degil)';
