-- PendingMedia: in-flight media send/localize staging. A media Message is committed only after its
-- bytes are confirmed (uploaded locally / localized for federation); until then only this row exists
-- (no Message, no seq, nothing visible in the thread). On success the row is deleted as the real
-- Message+MediaMessage are created (promote); on failure it is marked `failed` and left (no auto-retry).
-- Created BEFORE the file write so a crash between "intent recorded" and "bytes confirmed" always
-- leaves an attributable, GC-reclaimable record. See the model doc in schema.prisma.
CREATE TABLE "PendingMedia" (
    "id" BIGSERIAL NOT NULL,
    "threadId" INTEGER NOT NULL,
    "creatorId" INTEGER NOT NULL,
    "contentType" "ContentType" NOT NULL,
    "content" TEXT NOT NULL,
    "digest" VARCHAR(64),
    "clientMessageId" VARCHAR(36),
    "originSeq" INTEGER,
    "originDomain" VARCHAR(63),
    "originServerTime" TIMESTAMP(3),
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "failReason" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingMedia_pkey" PRIMARY KEY ("id")
);

-- LOCAL idempotency: a retried send resumes the same stage (NULL clientMessageId for federated rows
-- is distinct under Postgres unique semantics, so the two paths never collide).
CREATE UNIQUE INDEX "PendingMedia_clientMessageId_key" ON "PendingMedia"("clientMessageId");
-- FEDERATED pull dedup, mirroring Message's (threadId, creator, originSeq). NULL originSeq (local
-- rows) are distinct, so local stages coexist.
CREATE UNIQUE INDEX "PendingMedia_threadId_creatorId_originSeq_key" ON "PendingMedia"("threadId", "creatorId", "originSeq");

CREATE INDEX "PendingMedia_threadId_idx" ON "PendingMedia"("threadId");
CREATE INDEX "PendingMedia_status_createdAt_idx" ON "PendingMedia"("status", "createdAt");

ALTER TABLE "PendingMedia" ADD CONSTRAINT "PendingMedia_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
