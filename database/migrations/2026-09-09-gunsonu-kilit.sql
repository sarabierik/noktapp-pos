-- ---------------------------------------------------------------------------
-- Gün sonu: iki kasa aynı anda kapatamasın.
--
-- closeDay checked "is this day already closed?" with a plain SELECT and then
-- INSERTed. Two tills pressing "Gün sonu" in the same second both read nothing
-- and both wrote a closing: two Z reports for one day, two checkpoints, and a
-- day that appears twice in the accountant's list. The test written for
-- exactly this had been failing.
--
-- The check now happens inside the transaction, but a check is only as good as
-- the lock under it, so the real guard is here: the database refuses the
-- second row. Re-closing a REOPENED day is legitimate and gets close_seq 2,
-- 3, … so the key includes the sequence rather than forbidding a second close.
--
-- Existing installs may already carry a duplicate pair from before this fix.
-- Nothing is deleted - a closing is a financial record, and a wrong one is
-- still evidence of what happened. The later row of each pair is renumbered so
-- the key can be created and both stay visible.
-- ---------------------------------------------------------------------------

UPDATE daily_closings d
  JOIN (
    SELECT a.id,
           (SELECT MAX(b.close_seq) FROM daily_closings b
             WHERE b.client_id = a.client_id AND b.date = a.date)
           + ROW_NUMBER() OVER (PARTITION BY a.client_id, a.date, a.close_seq ORDER BY a.id) AS yeni
      FROM daily_closings a
      JOIN (SELECT client_id, date, close_seq
              FROM daily_closings
             GROUP BY client_id, date, close_seq
            HAVING COUNT(*) > 1) dup
        ON dup.client_id = a.client_id AND dup.date = a.date AND dup.close_seq = a.close_seq
     WHERE a.id > (SELECT MIN(c.id) FROM daily_closings c
                    WHERE c.client_id = a.client_id AND c.date = a.date AND c.close_seq = a.close_seq)
  ) x ON x.id = d.id
   SET d.close_seq = x.yeni;

-- IF NOT EXISTS because main.js re-runs every migration on every start of the
-- till; a file that throws on the second boot is a file that fills the log
-- with noise nobody reads and hides the error that matters.
ALTER TABLE `daily_closings`
  ADD UNIQUE KEY IF NOT EXISTS `uq_dc_client_date_seq` (`client_id`, `date`, `close_seq`);
