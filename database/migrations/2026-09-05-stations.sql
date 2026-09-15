-- ---------------------------------------------------------------------------
-- İSTASYONLAR - the screen that was never built.
--
-- Mutfak, Bar, Pide, Tatlı are referenced by every part of the till: a printer
-- points at one, a category routes to one, the mutfak panosu is filtered by
-- one, and sendToStations fans a bill out across them. Until now the only way
-- a station came into existence was the seed, so nobody could add "Pide" after
-- opening day, and nobody could see that a station had no printer - the slips
-- simply went nowhere and "garson istasyona gönderemiyor" was the complaint
-- that reached us.
--
-- The columns the screen needs (display_name, is_active, sort_order) already
-- exist. What did not exist is any index for the two questions the screen asks
-- about EVERY station on EVERY load:
--
--   * "kaç kategori bu istasyona düşüyor" - a full scan of categories per
--     station, once per row, on a table that also carries the QR menu
--   * "hangi yazıcı bu istasyona basıyor" - the same, on printers
--
-- Small tables today, but the count is drawn on the row as a warning ("Kategori
-- yok - bu istasyona hiçbir sipariş düşmez") so it is read on every paint, and
-- an unindexed correlated subquery is how a settings screen becomes slow on the
-- one machine that has 400 categories.
--
-- No column is added or dropped. Re-running this is harmless: MariaDB's
-- IF NOT EXISTS on ADD KEY makes a second run a no-op rather than an error.
-- ---------------------------------------------------------------------------

-- "Bu istasyona kaç kategori bağlı" - and, on the products side, "bu kategori
-- nereye basar". Both walk (client_id, station_id).
ALTER TABLE `categories`
  ADD KEY IF NOT EXISTS `idx_cat_station` (`client_id`,`station_id`);

-- "Bu istasyona hangi yazıcı basıyor". The station row shows the printer's
-- name, not a count, so this join happens for every station on the screen.
ALTER TABLE `printers`
  ADD KEY IF NOT EXISTS `idx_printer_station` (`client_id`,`station_id`);

-- Every list of stations - this screen, the kitchen board's chip row, the
-- printer form's dropdown - is ORDER BY sort_order. Without this it is a
-- filesort, and the board redraws it on a timer.
ALTER TABLE `stations`
  ADD KEY IF NOT EXISTS `idx_station_order` (`client_id`,`is_active`,`sort_order`);

-- The hard-delete guard asks "has anything ever been sent here" against
-- print_jobs.station_id. There is an index on (client_id,status,id) but none
-- that reaches station_id, so the guard scans the whole print history.
ALTER TABLE `print_jobs`
  ADD KEY IF NOT EXISTS `idx_pj_station` (`client_id`,`station_id`);
