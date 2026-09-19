-- Drop the legacy `users` table.
--
-- This table was created in the initial baseline as a placeholder for a
-- future local-auth source of truth ("Replaces Supabase auth.users for
-- the BFF"). That migration never happened: Supabase `auth.users` is
-- the active IdP and the BFF's user record lives in `profiles`, keyed
-- by Supabase user_id. The `users` table has 0 rows in prod and 0 rows
-- locally, no code reads or writes it, and the drizzle relations that
-- pointed at it have been re-pointed at `profiles`.
--
-- Drop it so the schema reflects reality.

DROP TABLE IF EXISTS "users";
