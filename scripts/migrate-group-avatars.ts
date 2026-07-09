/**
 * OBSOLETE (2026-07): this one-time script moved group avatars from /uploads/shards/ (CAS chat-media
 * URLs) into /uploads/avatars/ and pointed Group.avatar at the new URL. It is now dead code:
 *   - the `Group` table is abolished (a group IS a `!`-sigil User row; see docs/account-naming.md),
 *     so `prisma.group` no longer exists, and
 *   - a full data reset ships with the group-as-User refactor, so there are no legacy group-avatar
 *     rows to migrate — group avatars are created directly under uploads/avatars/ on the `!`-User.
 *
 * Kept as an empty stub (not deleted) so the file path stays discoverable in history. No exports.
 */
export {};
