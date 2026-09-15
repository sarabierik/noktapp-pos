-- Getir Yemek is not a legacy connection.
--
-- The integration shipped with the provider key GETIR_LEGACY, disabled by
-- default, on the belief that Getir Yemek orders now reach a restaurant
-- through Uber Eats Trendyol Go and that a direct connector would only open
-- every order twice. That is wrong: Getir Yemek is still its own platform with
-- its own restaurant agreement, and a restaurant asking for Getir is asking
-- for a direct connection, not for Trendyol Go.
--
-- The key is stored on four tables. Renaming it here rather than leaving both
-- spellings alive keeps one name in the logs a support call will read. Each
-- statement is idempotent by its WHERE clause, so a re-run does nothing - the
-- migrations are replayed on every start.

UPDATE `np_int_connections` SET `provider` = 'GETIR_YEMEK' WHERE `provider` = 'GETIR_LEGACY';
UPDATE `np_int_orders`      SET `provider` = 'GETIR_YEMEK' WHERE `provider` = 'GETIR_LEGACY';
UPDATE `np_int_events`      SET `provider` = 'GETIR_YEMEK' WHERE `provider` = 'GETIR_LEGACY';
UPDATE `np_int_logs`        SET `provider` = 'GETIR_YEMEK' WHERE `provider` = 'GETIR_LEGACY';
UPDATE `np_int_menu_map`    SET `provider` = 'GETIR_YEMEK' WHERE `provider` = 'GETIR_LEGACY';
