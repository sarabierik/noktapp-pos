-- ---------------------------------------------------------------------------
-- Gün sonu: bir güne yalnızca BİR açık kapanış.
--
-- The unique key added in 2026-09-09 is on (client_id, date, close_seq), and it
-- stopped the obvious race: two tills computing the same sequence and both
-- inserting. It does not stop the subtler one, and the akis suite eventually
-- caught it.
--
-- InnoDB's REPEATABLE READ is the reason. The second transaction's `SELECT
-- MAX(close_seq) ... FOR UPDATE` is a LOCKING read, so it sees the row the
-- first transaction has just committed and computes seq 2. The "is this day
-- already closed?" check right after it is a PLAIN read, taken from the
-- snapshot the transaction started with - which predates that commit. So the
-- check finds nothing, the insert uses a sequence nobody has used, the unique
-- key is satisfied, and the day is signed off twice with two different
-- sequences. Two Z reports, and the timing that produces it is rare enough to
-- pass for days.
--
-- The invariant was never "one row per sequence". It is: A DAY HAS AT MOST ONE
-- CLOSING THAT STILL STANDS. Reopened closings are history and there may be
-- many; exactly one may be live. That is expressible, so it stops being a
-- matter of read levels and lock ordering and becomes something the engine
-- refuses:
--
--   active_date  = the date while the closing stands, NULL once it is reopened
--   UNIQUE (client_id, active_date)
--
-- NULLs do not collide in a MariaDB unique index, so any number of reopened
-- rows coexist, and the one live closing has no room for a twin - whatever the
-- isolation level, whatever the timing, whichever code path asks.
-- ---------------------------------------------------------------------------

ALTER TABLE `daily_closings`
  ADD COLUMN IF NOT EXISTS `active_date` DATE
    GENERATED ALWAYS AS (IF(COALESCE(`is_reopened`,0)=0, `date`, NULL)) STORED;

-- Any install already carrying a double-signed day cannot take the key. The
-- later row is marked reopened rather than deleted: it is a financial record,
-- and a wrong one is still evidence of what happened.
UPDATE daily_closings d
  JOIN (
    SELECT a.id
      FROM daily_closings a
      JOIN (SELECT client_id, date
              FROM daily_closings
             WHERE COALESCE(is_reopened,0)=0
             GROUP BY client_id, date
            HAVING COUNT(*) > 1) dup
        ON dup.client_id = a.client_id AND dup.date = a.date
     WHERE COALESCE(a.is_reopened,0)=0
       AND a.id > (SELECT MIN(c.id) FROM daily_closings c
                    WHERE c.client_id=a.client_id AND c.date=a.date
                      AND COALESCE(c.is_reopened,0)=0)
  ) x ON x.id = d.id
   SET d.is_reopened = 1,
       d.reopened_at = COALESCE(d.reopened_at, NOW());

ALTER TABLE `daily_closings`
  ADD UNIQUE KEY IF NOT EXISTS `uq_dc_active_day` (`client_id`, `active_date`);
