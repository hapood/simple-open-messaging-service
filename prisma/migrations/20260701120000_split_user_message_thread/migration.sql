-- Decompose the overloaded UserMessageThread into ThreadParticipant (per-user conversation membership +
-- read state, for both P2P and GROUP) and Friendship (P2P relationship / friend-request state, one row
-- per user pair). Drop GroupMember (its role folds into ThreadParticipant). Add Message query indices
-- and the creator → User foreign key for referential integrity.
--
-- Ordering is hand-edited vs the auto-diff so data backfill happens AFTER the new tables are created
-- and BEFORE the old tables are dropped. The whole migration runs in one transaction (prisma migrate
-- deploy wraps it), so a backfill failure rolls everything back.

-- ===== 1. New enums =====
CREATE TYPE "GroupRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE "FriendshipStatus" AS ENUM ('PENDING', 'APPROVED', 'BLOCKED', 'DELETED');

-- ===== 2. New tables (before backfill so we can INSERT into them) =====
CREATE TABLE "ThreadParticipant" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "threadId" INTEGER NOT NULL,
    "lastReadMsgId" BIGINT,
    "role" "GroupRole" DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "leftAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThreadParticipant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Friendship" (
    "id" SERIAL NOT NULL,
    "userAId" INTEGER NOT NULL,
    "userBId" INTEGER NOT NULL,
    "requesterId" INTEGER NOT NULL,
    "status" "FriendshipStatus" NOT NULL DEFAULT 'PENDING',
    "reqMessage" TEXT NOT NULL DEFAULT '',
    "threadId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
);

-- ===== 3. Backfill from UserMessageThread (before it is dropped) =====

-- 3a. ThreadParticipant — one row per old participant row whose thread already exists.
--     Pending P2P requests (threadId NULL) have no conversation yet → no participant row (they live in Friendship).
--     GROUP rows get role OWNER when the user owns the group, else MEMBER; P2P rows get role NULL.
INSERT INTO "ThreadParticipant" ("userId", "threadId", "lastReadMsgId", "role", "joinedAt", "createdAt", "updatedAt")
SELECT
  umt."userId",
  umt."threadId",
  umt."lastRead",
  CASE
    WHEN umt."toObjType" = 'GROUP'
      THEN CASE WHEN g."ownerId" = umt."userId" THEN 'OWNER'::"GroupRole" ELSE 'MEMBER'::"GroupRole" END
    ELSE NULL
  END,
  umt."createdAt",
  umt."createdAt",
  umt."updatedAt"
FROM "UserMessageThread" umt
LEFT JOIN "Group" g ON umt."toObjType" = 'GROUP' AND umt."toObjId" = g."id"
WHERE umt."threadId" IS NOT NULL;

-- 3b. Friendship — collapse the two half-edges (FROM_PENDING + TO_PENDING) of each P2P pair into ONE row.
--     Pair normalized via LEAST/GREATEST (userAId < userBId); requesterId = the FROM_PENDING side's userId.
--     FROM_PENDING/TO_PENDING both map to PENDING; APPROVED/BLOCKED/DELETED map to themselves.
--     (Each GROUP BY pair yields exactly one row, so no ON CONFLICT needed; the unique index is added in step 4.)
INSERT INTO "Friendship" ("userAId", "userBId", "requesterId", "status", "reqMessage", "threadId", "createdAt", "updatedAt")
SELECT
  LEAST(umt."userId", umt."toObjId")   AS "userAId",
  GREATEST(umt."userId", umt."toObjId") AS "userBId",
  CASE
    WHEN MAX(umt."userId") FILTER (WHERE umt."status" = 'FROM_PENDING') IS NOT NULL
      THEN MAX(umt."userId") FILTER (WHERE umt."status" = 'FROM_PENDING')
    ELSE LEAST(umt."userId", umt."toObjId")
  END AS "requesterId",
  CASE MAX(umt."status")
    WHEN 'APPROVED' THEN 'APPROVED'::"FriendshipStatus"
    WHEN 'BLOCKED'  THEN 'BLOCKED'::"FriendshipStatus"
    WHEN 'DELETED'  THEN 'DELETED'::"FriendshipStatus"
    ELSE 'PENDING'::"FriendshipStatus"
  END AS "status",
  COALESCE(MAX(umt."reqMessage"), '') AS "reqMessage",
  MAX(umt."threadId")                  AS "threadId",
  MIN(umt."createdAt")                 AS "createdAt",
  MAX(umt."updatedAt")                 AS "updatedAt"
FROM "UserMessageThread" umt
WHERE umt."toObjType" = 'P2P'
GROUP BY LEAST(umt."userId", umt."toObjId"), GREATEST(umt."userId", umt."toObjId");

-- ===== 4. Indices (new tables + Message hot paths) =====
CREATE INDEX "ThreadParticipant_threadId_idx" ON "ThreadParticipant"("threadId");
CREATE INDEX "ThreadParticipant_userId_idx" ON "ThreadParticipant"("userId");
CREATE UNIQUE INDEX "ThreadParticipant_userId_threadId_key" ON "ThreadParticipant"("userId", "threadId");
CREATE INDEX "Friendship_userBId_idx" ON "Friendship"("userBId");
CREATE UNIQUE INDEX "Friendship_userAId_userBId_key" ON "Friendship"("userAId", "userBId");
CREATE INDEX "Message_threadId_id_idx" ON "Message"("threadId", "id");
CREATE INDEX "Message_threadId_createdAt_idx" ON "Message"("threadId", "createdAt");
CREATE INDEX "Message_creator_idx" ON "Message"("creator");

-- ===== 5. Foreign keys on new tables + Message.creator =====
ALTER TABLE "ThreadParticipant" ADD CONSTRAINT "ThreadParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ThreadParticipant" ADD CONSTRAINT "ThreadParticipant_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Friendship" ADD CONSTRAINT "Friendship_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_creator_fkey" FOREIGN KEY ("creator") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== 6. Drop old tables + enum (data already migrated above) =====
ALTER TABLE "GroupMember" DROP CONSTRAINT "GroupMember_groupId_fkey";
ALTER TABLE "GroupMember" DROP CONSTRAINT "GroupMember_userId_fkey";
ALTER TABLE "UserMessageThread" DROP CONSTRAINT "UserMessageThread_threadId_fkey";
ALTER TABLE "UserMessageThread" DROP CONSTRAINT "UserMessageThread_userId_fkey";
DROP TABLE "GroupMember";
DROP TABLE "UserMessageThread";
DROP TYPE "UserMessageThreadStatus";
