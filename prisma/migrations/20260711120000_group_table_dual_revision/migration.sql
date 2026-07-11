-- Group table: group-exclusive state (owner + roster revision). Identity (name/avatar/bio) stays on User.
CREATE TABLE "Group" (
    "id" SERIAL PRIMARY KEY,
    "groupUserId" INTEGER NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "rosterRev" INTEGER NOT NULL DEFAULT 0,
    "remoteRosterRev" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Group_groupUserId_key" ON "Group"("groupUserId");
CREATE INDEX "Group_ownerId_idx" ON "Group"("ownerId");
ALTER TABLE "Group" ADD CONSTRAINT "Group_groupUserId_fkey" FOREIGN KEY ("groupUserId") REFERENCES "User"("id") ON DELETE CASCADE;

-- Backfill: one Group row per existing group !-User identity row (owner = the active OWNER participant).
INSERT INTO "Group" ("groupUserId", "ownerId")
SELECT t."groupUserId", p."userId"
FROM "MessageThread" t
JOIN "ThreadParticipant" p ON p."threadId" = t."id" AND p."role" = 'OWNER' AND p."leftAt" IS NULL
WHERE t."groupUserId" IS NOT NULL
ON CONFLICT ("groupUserId") DO NOTHING;

-- User: profile revision (Int counter; replaces remoteUpdatedAt DateTime). The old timestamp cursor is
-- NOT type-convertible to the new Int revision — stubs re-probe on next chat-open (remoteProfileRev null).
ALTER TABLE "User" ADD COLUMN "profileRev" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "remoteProfileRev" INTEGER;
ALTER TABLE "User" DROP COLUMN "remoteUpdatedAt";

-- MessageThread: fedGroupAccount/originDomain moved to groupUser.account/domain; groupUserId @unique
-- replaces fedGroupAccount @unique as the one-thread-per-group guarantee.
ALTER TABLE "MessageThread" DROP COLUMN "fedGroupAccount";
ALTER TABLE "MessageThread" DROP COLUMN "originDomain";
CREATE UNIQUE INDEX "MessageThread_groupUserId_key" ON "MessageThread"("groupUserId");
