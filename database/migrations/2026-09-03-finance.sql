-- ---------------------------------------------------------------------------
-- FİNANS - gün sonu kaydı ve silinen adisyon kütüğü.
--
-- Two holes the old system left, both of them the kind that only shows up
-- after the money is already wrong:
--
--   * `daily_closings` had NO unique key. The close handler guarded itself with
--     a SELECT and nothing else, so two clicks half a second apart - or a till
--     and a phone closing the same day at once - wrote two closing rows for the
--     same date. The comment in the PHP records that this actually happened
--     ("re-clicking duplicated rows"). A closing is a signature; there can be
--     one per attempt, and the attempt is `close_seq`, which the reopen /
--     re-close cycle increments. The database should be the thing that enforces
--     that, not a race between two SELECTs.
--
--   * `order_delete_logs` was only indexed by `client_id`. Restoring a bill has
--     to find its delete log by `order_id`, and so does the cancellations
--     report; on a site with a year of deletions that is a full scan of the
--     table for every "Geri al".
--
-- Re-running this is harmless: both statements are guarded with IF NOT EXISTS.
-- ---------------------------------------------------------------------------

-- One closing row per (tenant, business day, attempt). A reopen flags the row
-- `is_reopened=1` and leaves it in place, so the next close takes the next
-- close_seq and the history of who signed off what, and when, survives.
ALTER TABLE `daily_closings`
  ADD UNIQUE KEY IF NOT EXISTS `uq_dc_client_date_seq` (`client_id`, `date`, `close_seq`);

-- "Which bill was this deletion for" - the question restore asks every time.
ALTER TABLE `order_delete_logs`
  ADD KEY IF NOT EXISTS `idx_odl_client_order` (`client_id`, `order_id`);
