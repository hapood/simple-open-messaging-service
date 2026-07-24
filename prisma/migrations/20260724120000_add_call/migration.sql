-- 1:1 WebRTC call lifecycle + history. The app server is signaling coordinator ONLY (never
-- carries media — P2P DTLS-SRTP; a separate coturn is the TURN relay fallback). One row per call
-- attempt; status is the authoritative state machine. callSid is the client-generated idempotency
-- key + the stable address every signaling frame carries (mirrors Message.clientMessageId).
--
-- Purely ADDITIVE: two enums + one table. The live DB carries pre-existing drift (columns/indexes
-- other migrations already dropped from the schema but never applied here) — that is intentionally
-- NOT reconciled by this migration.

-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACCEPTED', 'ENDED', 'DECLINED', 'CANCELLED', 'MISSED');

-- CreateTable
CREATE TABLE "Call" (
    "id" SERIAL NOT NULL,
    "callSid" VARCHAR(36) NOT NULL,
    "threadId" INTEGER NOT NULL,
    "callerId" INTEGER NOT NULL,
    "calleeId" INTEGER NOT NULL,
    "type" "CallType" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" VARCHAR(31),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Call_callSid_key" ON "Call"("callSid");

-- CreateIndex
CREATE INDEX "Call_calleeId_status_idx" ON "Call"("calleeId", "status");

-- CreateIndex
CREATE INDEX "Call_callerId_status_idx" ON "Call"("callerId", "status");

-- CreateIndex
CREATE INDEX "Call_threadId_idx" ON "Call"("threadId");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_calleeId_fkey" FOREIGN KEY ("calleeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
