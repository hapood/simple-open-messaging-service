-- User: thread-list revision cursor (per-user, monotonic; bumped on thread add/delete).
ALTER TABLE "User" ADD COLUMN "threadRevision" INTEGER NOT NULL DEFAULT 0;

-- ThreadRevisionDirection enum
CREATE TYPE "ThreadRevisionDirection" AS ENUM ('ADD', 'DELETE');

-- Per-user thread-list operation log (one ADD + one DELETE per user×thread).
CREATE TABLE "ThreadRevision" (
    "id"        BIGSERIAL    PRIMARY KEY,
    "userId"    INTEGER      NOT NULL,
    "threadId"  INTEGER      NOT NULL,
    "direction" "ThreadRevisionDirection" NOT NULL,
    "revision"  INTEGER      NOT NULL,
    "isDelete"  BOOLEAN      NOT NULL DEFAULT FALSE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ThreadRevision_userId_threadId_direction_key" ON "ThreadRevision"("userId", "threadId", "direction");
CREATE INDEX "ThreadRevision_userId_revision_idx" ON "ThreadRevision"("userId", "revision");
ALTER TABLE "ThreadRevision" ADD CONSTRAINT "ThreadRevision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "ThreadRevision" ADD CONSTRAINT "ThreadRevision_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE;

-- Backfill: seed an ADD record (revision=0) for every currently-active thread participation, so the
-- snapshot at revision=0 contains all existing threads. User.threadRevision stays 0 (the seed revision).
INSERT INTO "ThreadRevision" ("userId", "threadId", "direction", "revision", "isDelete")
SELECT tp."userId", tp."threadId", 'ADD', 0, false
FROM "ThreadParticipant" tp
WHERE tp."leftAt" IS NULL
ON CONFLICT ("userId", "threadId", "direction") DO NOTHING;
