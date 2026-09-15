-- ---------------------------------------------------------------------------
-- KASA TEŞHİS - the till's half.
--
-- WHAT this adds: two indexes and nothing else. No new table, no new column,
-- no change to anything the till writes.
--
-- WHY there is no table
-- ---------------------
-- The diagnostics document (src/modules/teshis.js) is BUILT on demand and sent
-- on the licence heartbeat; it is never stored locally. Storing it here would
-- mean a second copy of facts the till can always recompute in a few
-- milliseconds, a retention policy to get wrong, and a table that grows on a
-- restaurant's own PC to serve a screen in another city. The panel keeps the
-- history because the panel is where the history is read.
--
-- The one piece of state the feature needs - when the last document was
-- accepted - is a single np_settings row (`diag_last_sent_at`), written
-- through db.setSetting(). np_settings already exists (02_schema_local.sql),
-- so there is nothing to create.
--
-- WHY these two indexes
-- ---------------------
-- 1) np_app_log(level, created_at)
--    The document carries the last error lines and a 24-hour error count, and
--    both ask "level='error' AND created_at > ...". The only index on this
--    table is ix_area(area, created_at), which cannot serve either: the filter
--    does not mention `area`, so both queries scan the whole log. On a till
--    that has been running for two years that is the most expensive thing in
--    the document, and it would be paid on a machine that is also taking
--    orders. This is the difference between a build that finishes in
--    milliseconds and one that hits the 3-second guard in teshis.js and gets
--    silently dropped.
--
-- 2) print_jobs(client_id, station_id, id)
--    "What happened to the last thing sent to this printer" is read per
--    printer, ordered by id DESC, limit 1. idx_pj_station(client_id,
--    station_id) already narrows it, but leaves the engine sorting whatever
--    matched - the entire print history of that station, which on a busy
--    kitchen printer is hundreds of thousands of rows for one row of answer.
--    With id on the end the lookup walks backwards from the newest and stops
--    at the first row. The older index is deliberately left in place: the
--    hard-delete guard in the stations module uses it as an existence check
--    and gains nothing from the third column.
--
-- Neither index changes a single value in the database, and both are additive:
-- every existing query keeps the plan it had or gets a better one.
--
-- Idempotent: ADD KEY IF NOT EXISTS throughout, so the desktop shell can run
-- this file on every start exactly as it runs the others.
-- ---------------------------------------------------------------------------

ALTER TABLE `np_app_log`
  ADD KEY IF NOT EXISTS `ix_log_level` (`level`,`created_at`);

ALTER TABLE `print_jobs`
  ADD KEY IF NOT EXISTS `idx_pj_station_last` (`client_id`,`station_id`,`id`);
