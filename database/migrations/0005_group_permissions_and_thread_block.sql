ALTER TABLE "ThreadParticipant"
  ADD COLUMN IF NOT EXISTS "blocked" boolean DEFAULT false NOT NULL;

ALTER TABLE "Group"
  ADD COLUMN IF NOT EXISTS "membersCanInvite" boolean DEFAULT true NOT NULL;

-- Carry forward existing P2P blocks into the new thread-scoped state.
UPDATE "ThreadParticipant" mine
SET "blocked" = true
FROM "UserBlock" ub, "ThreadParticipant" peer, "MessageThread" thread
WHERE mine."userId" = ub."blockerId"
  AND peer."userId" = ub."blockedId"
  AND peer."threadId" = mine."threadId"
  AND thread.id = mine."threadId"
  AND thread.type = 'P2P';

CREATE UNIQUE INDEX IF NOT EXISTS "ThreadParticipant_one_active_group_owner_key"
  ON "ThreadParticipant" ("threadId")
  WHERE "role" = 'OWNER' AND "leftAt" IS NULL;
