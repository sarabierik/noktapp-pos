-- ---------------------------------------------------------------------------
-- FİŞ, YAZICI VE MÜŞTERİ EKRANI
--
-- Three things the owner said did not exist. Two of them needed columns:
--
--   * a printer had no paper width. 58 mm and 80 mm are not a preference, they
--     are 32 and 48 characters, and the till assumed 48 for everyone - so a
--     58 mm printer cut every line of the bill in half and nobody could say
--     why. The width now belongs to the printer, because that is where the
--     paper is.
--   * the customer display could show two lines of text and nothing else. The
--     owner asked for a small QR (wifi, menu, Google review) and a small image
--     (logo or a campaign) INSIDE the layout that already exists - so these are
--     additions to np_display_settings, not a new table and not a new template.
--
-- The QR is rendered to SVG when it is SAVED, not when it is shown: /api/display
-- is the unauthenticated feed the second screen polls twice a second, and it
-- must not be doing barcode arithmetic on every poll.
--
-- The receipt TEXT settings need no schema at all: the header and the footer
-- already live on clients.receipt_header / clients.receipt_footer (which is
-- what print/document.js reads), and every switch is a row in np_settings.
--
-- Safe to re-run: the desktop shell replays every migration on each start.
-- ---------------------------------------------------------------------------
SET NAMES utf8mb4;

-- The paper in the printer. 58 or 80; anything else is treated as 80.
ALTER TABLE `printers`
  ADD COLUMN IF NOT EXISTS `paper_width` smallint(6) NOT NULL DEFAULT 80
    COMMENT '58|80 mm - fis genisligi bu yazicidan gelir';

-- The second screen. Small additions inside the template that is already there.
ALTER TABLE `np_display_settings`
  ADD COLUMN IF NOT EXISTS `foot_note`     varchar(120) DEFAULT NULL COMMENT 'ekranin altindaki kucuk yazi',
  ADD COLUMN IF NOT EXISTS `qr_enabled`    tinyint(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `qr_data`       varchar(500) DEFAULT NULL COMMENT 'karekodun icerigi - adres ya da metin',
  ADD COLUMN IF NOT EXISTS `qr_caption`    varchar(120) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `qr_svg`        mediumtext DEFAULT NULL COMMENT 'kayit aninda uretilir - ekran her istekte hesap yapmasin',
  ADD COLUMN IF NOT EXISTS `image_enabled` tinyint(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `image_data`    mediumtext DEFAULT NULL COMMENT 'data: URI ya da adres',
  ADD COLUMN IF NOT EXISTS `image_caption` varchar(120) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `media_size`    varchar(10) NOT NULL DEFAULT 'kucuk' COMMENT 'kucuk|orta';

-- Existing installations have one row; a fresh one may not.
INSERT INTO `np_display_settings` (`id`,`template`,`headline`,`subline`,`enabled`)
VALUES (1,'marka','Hos geldiniz','Afiyet olsun',0)
  ON DUPLICATE KEY UPDATE `id`=1;
