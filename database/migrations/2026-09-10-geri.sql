-- ---------------------------------------------------------------------------
-- Geri yükleme (restore).
--
-- `np_backups.kind` was an enum of the three ways a backup gets TAKEN. Restore
-- adds two ways one gets HANDLED, and both have to be tellable apart from a
-- routine snapshot:
--
--   pre-restore  the snapshot taken in the seconds before somebody overwrote
--                the database. It is the only copy of everything the restore
--                is about to erase, so prune() must never delete it by age -
--                and prune() can only spare what it can recognise.
--   cloud-fetch  a nightly backup pulled back down from the panel. It sits in
--                the same folder as the local snapshots and would otherwise be
--                indistinguishable from one taken here, which matters when the
--                owner is choosing which file to restore from.
--
-- An enum and not a free string because the four values are a closed list and
-- a typo'd kind is a backup that silently stops being found by the screen that
-- offers it.
--
-- MODIFY rather than anything conditional: it is idempotent by nature (the
-- second run sets the column to what it already is) and the till re-runs every
-- migration on every start.
-- ---------------------------------------------------------------------------

ALTER TABLE `np_backups`
  MODIFY `kind` enum('local','cloud','manual','pre-restore','cloud-fetch')
  NOT NULL DEFAULT 'local';
