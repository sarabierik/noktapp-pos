-- ---------------------------------------------------------------------------
-- SIPARIS NEREYE GIDER - a station says where its orders come out.
--
-- This till is screen-first. Mutfak and Bar read their orders off Ekranlar, and
-- a printer is the exception: most restaurants we are opening with have no
-- kitchen printer at all and never will. Nothing in the schema said so, so
-- every screen-only station looked to the program exactly like a station whose
-- printer had been unplugged - and the İstasyonlar screen told the owner, in
-- red, that his correctly configured kitchen threw its slips away. Ten sites
-- would each have opened a screen full of warnings that mean nothing, which is
-- how a person learns to stop reading them and then misses the one that is
-- true.
--
-- `output_mode` is that missing sentence: 'screen' (the board is the output),
-- 'printer' (paper is), or 'both'. The default is 'screen' because that is what
-- the product IS - a new station created on a pilot site is correct the moment
-- it exists, with nothing attached to it.
--
-- THE BACKFILL IS ONE-SHOT AND THAT MATTERS.
--
-- A site already running on paper must not be told its kitchen printer is now
-- decoration, so an existing station that HAS a printer becomes 'printer' and
-- everything else becomes 'screen'. But this file is replayed on every start of
-- the till, and an owner who later moves that station to 'screen' - unplugs the
-- old printer, puts a tablet on the pass, leaves the printer row behind - would
-- have his choice silently overwritten on the next restart, forever, with no
-- screen anywhere admitting it. So the backfill is fenced behind a marker in
-- np_settings and runs exactly once per install; every later run reads the
-- marker and does nothing.
--
-- Re-running this is harmless: ADD COLUMN IF NOT EXISTS is a no-op the second
-- time, the UPDATE is fenced, and INSERT IGNORE cannot duplicate the marker.
-- ---------------------------------------------------------------------------
SET NAMES utf8mb4;

ALTER TABLE `stations`
  ADD COLUMN IF NOT EXISTS `output_mode` enum('screen','printer','both')
  NOT NULL DEFAULT 'screen'
  COMMENT 'siparis nereye gitsin: ekrana / yaziciya / ikisine';

-- The existing install, read once. "Has a printer bound to it" is the only
-- honest evidence we have that this station was ever meant to print, and it is
-- the same join the İstasyonlar screen has always drawn the printer name with.
UPDATE `stations` s
   SET s.`output_mode` = 'printer'
 WHERE NOT EXISTS (SELECT 1 FROM `np_settings` WHERE `k` = 'station_output_backfilled')
   AND EXISTS (SELECT 1 FROM `printers` p
                WHERE p.`client_id` = s.`client_id` AND p.`station_id` = s.`id`);

-- The fence. Written after the UPDATE, so a run that dies halfway through
-- leaves the marker unset and the next start finishes the job.
INSERT IGNORE INTO `np_settings` (`k`, `v`) VALUES ('station_output_backfilled', '1');

-- The overview asks "is anybody watching this board" per station: the newest
-- moment a station's own tickets were touched, over order_items filtered by
-- client. There is an index reaching station_status but none that starts at
-- the column the answer is read from, and this runs once per station on every
-- paint of the İstasyonlar screen.
ALTER TABLE `order_items`
  ADD KEY IF NOT EXISTS `idx_oi_station_touch` (`client_id`,`station_updated_at`);
