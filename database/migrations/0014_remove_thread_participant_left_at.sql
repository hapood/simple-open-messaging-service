DELETE FROM "ThreadParticipant" WHERE "leftAt" IS NOT NULL;

CREATE TYPE "ThreadParticipantState" AS ENUM ('AUTHORIZED', 'ESTABLISHED', 'REVOKED');

ALTER TABLE "ThreadParticipant"
  ADD COLUMN state "ThreadParticipantState" NOT NULL DEFAULT 'ESTABLISHED';

DROP INDEX IF EXISTS "ThreadParticipant_threadId_joinedAt_active_idx";
DROP INDEX IF EXISTS "ThreadParticipant_one_active_group_owner_key";

ALTER TABLE "ThreadParticipant" DROP COLUMN "leftAt";
ALTER TABLE "ThreadParticipant" DROP COLUMN "recognizesFriend";

CREATE INDEX "ThreadParticipant_threadId_joinedAt_idx"
  ON "ThreadParticipant" ("threadId", "joinedAt");

CREATE UNIQUE INDEX "ThreadParticipant_one_established_group_owner_key"
  ON "ThreadParticipant" ("threadId")
  WHERE role = 'OWNER' AND state = 'ESTABLISHED';
