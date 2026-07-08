-- Backfill any user whose display name is missing/empty with a random "Guest_<hex>" name.
--
-- `name` is now the primary identity (required at registration; shown in every list, header, and
-- avatar), so an empty name would render as a blank label. In practice every creation path already
-- sets a non-empty name — local users get the registration input (previously uniqName), and federated
-- stubs get the remote username (later overwritten with the remote display name on localize). This
-- migration is a defensive safety net so no row is left without a display name regardless of how it
-- got there (manual DB edits, future code paths, partial localize).
--
-- md5(random() || id) yields a stable, collision-resistant 6-char hex suffix per row.
UPDATE "User"
SET name = 'Guest_' || substring(md5(random()::text || id::text), 1, 6)
WHERE name IS NULL OR name = '';
