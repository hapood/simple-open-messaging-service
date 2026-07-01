-- ThreadParticipant.role must be NULL for P2P conversations (role only applies to GROUP). The previous
-- migration left @default(MEMBER), so P2P participants created in approveInTx (which omits role) inherited
-- MEMBER. Drop the default so role is null unless explicitly set, and null out the role on existing P2P rows.

ALTER TABLE "ThreadParticipant" ALTER COLUMN "role" DROP DEFAULT;

UPDATE "ThreadParticipant"
SET "role" = NULL
WHERE "threadId" IN (SELECT "id" FROM "MessageThread" WHERE "type" = 'P2P');
