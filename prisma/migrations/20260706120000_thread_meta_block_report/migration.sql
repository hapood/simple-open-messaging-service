-- Per-user thread display state: pin ordering + per-user "clear history" watermark.
-- These are authored by the chat header MORE menu (pin/unpin, mute already existed, clear history).
-- clearedAt is consulted by query-messages to hide rows older than it for THAT user only (the peer's
-- copy is untouched), matching WhatsApp "clear chat for me".
ALTER TABLE "ThreadParticipant" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ThreadParticipant" ADD COLUMN "pinnedAt" TIMESTAMP(3);
ALTER TABLE "ThreadParticipant" ADD COLUMN "clearedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ThreadParticipant_userId_pinned_idx" ON "ThreadParticipant"("userId", "pinned");

-- CreateTable
-- One-way block independent of the Friendship state machine (survives unfriend, applies to strangers).
-- The message path consults this to drop fan-out to the blocker and filter query-messages.
CREATE TABLE "UserBlock" (
    "id" SERIAL NOT NULL,
    "blockerId" INTEGER NOT NULL,
    "blockedId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserBlock_blockerId_blockedId_key" ON "UserBlock"("blockerId", "blockedId");

-- CreateIndex
CREATE INDEX "UserBlock_blockedId_idx" ON "UserBlock"("blockedId");

-- AddForeignKey
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
-- Abuse/complaint report. Passive ingestion for the admin console; no behavioral effect on chat.
CREATE TABLE "UserReport" (
    "id" SERIAL NOT NULL,
    "reporterId" INTEGER NOT NULL,
    "reportedUserId" INTEGER NOT NULL,
    "reason" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserReport_reportedUserId_idx" ON "UserReport"("reportedUserId");

-- AddForeignKey
ALTER TABLE "UserReport" ADD CONSTRAINT "UserReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReport" ADD CONSTRAINT "UserReport_reportedUserId_fkey" FOREIGN KEY ("reportedUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- pg_trgm GIN index to back the substring ILIKE filter in search-messages. The extension is created
-- idempotently (IF NOT EXISTS); the GIN index lets `content ILIKE '%kw%'` use trigram fast-scan
-- instead of a full-thread sequential scan. Pure-text messages only; non-text types never carry
-- searchable content (the client filters them out before sending the query).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Message_content_trgm_idx" ON "Message" USING gin ("content" gin_trgm_ops);
