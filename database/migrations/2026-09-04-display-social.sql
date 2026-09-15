-- ---------------------------------------------------------------------------
-- MUSTERI EKRANI - sosyal medya hesaplari.
--
-- A restaurant's Instagram is the thing it most wants on a screen the guest is
-- already looking at while they wait for their change, and until now the only
-- way to put it there was to burn it into the karekod - one address, no name,
-- and nothing to read if the guest does not scan.
--
-- So: three handles, stored as the restaurant writes them ("@bellaalanya" or
-- "bellaalanya" - the screen strips the @ and puts it back itself), rendered
-- next to a drawn mark for each network. Not links, because nobody taps a
-- customer display; a name to type into the app they already have open.
--
-- media_size gains 'buyuk': the second monitor is usually a television, and
-- "orta" across a counter is still a postage stamp.
--
-- Re-running this is harmless.
-- ---------------------------------------------------------------------------

ALTER TABLE `np_display_settings`
  ADD COLUMN IF NOT EXISTS `social_enabled` tinyint(1) NOT NULL DEFAULT 0
    COMMENT 'sosyal medya satiri gorunsun mu',
  ADD COLUMN IF NOT EXISTS `social_instagram` varchar(80) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `social_facebook`  varchar(80) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `social_tiktok`    varchar(80) DEFAULT NULL;

ALTER TABLE `np_display_settings`
  MODIFY `media_size` varchar(10) NOT NULL DEFAULT 'kucuk' COMMENT 'kucuk|orta|buyuk';
