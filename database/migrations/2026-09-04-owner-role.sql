-- ---------------------------------------------------------------------------
-- ISLETME SAHIBI - the owner gets their own authority back.
--
-- Deleting a bill, taking money off the books and reopening a closed day are
-- guarded by "is this the licence holder", which passes for a tenant token or
-- a `superadmin` staff account and deliberately NOT for `admin` - an admin is
-- a manager the owner hired, and a manager should not be able to erase last
-- month's takings unnoticed.
--
-- But the owner does not work the till on a tenant token. He signs in on the
-- PIN pad like everyone else, and the setup wizard created that first account
-- as `admin`. So the screen told the person who bought the licence that only
-- the business owner may do this, and there was no way in the interface to
-- fix it.
--
-- The wizard now creates `superadmin`. This repairs the installs that are
-- already out there: if a restaurant has no owner account at all, the FIRST
-- user ever created - the one the wizard made - becomes it. A restaurant that
-- already has an owner is left exactly as it is.
--
-- Re-running this is harmless: the second run finds an owner and does nothing.
-- ---------------------------------------------------------------------------

UPDATE `users` u
   JOIN (
     SELECT MIN(id) AS id, client_id
       FROM users
      WHERE role = 'admin'
        AND client_id NOT IN (SELECT client_id FROM (SELECT DISTINCT client_id FROM users WHERE role='superadmin') x)
      GROUP BY client_id
   ) first ON first.id = u.id
    SET u.role = 'superadmin';
