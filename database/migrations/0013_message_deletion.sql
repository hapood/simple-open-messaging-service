CREATE TYPE "MessageDeleteType" AS ENUM ('WITHDRAW', 'REPORT');

CREATE TABLE "DeletedMessage" (
    "id" BIGSERIAL PRIMARY KEY,
    "threadId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" "MessageDeleteType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeletedMessage_threadId_fkey" FOREIGN KEY ("threadId")
        REFERENCES "MessageThread"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DeletedMessage_threadId_seq_key" ON "DeletedMessage"("threadId", "seq");
CREATE INDEX "DeletedMessage_threadId_id_idx" ON "DeletedMessage"("threadId", "id");

CREATE TABLE "FederatedMessageTombstone" (
    "id" BIGSERIAL PRIMARY KEY,
    "threadId" INTEGER NOT NULL,
    "creatorId" INTEGER NOT NULL,
    "originSeq" INTEGER NOT NULL,
    "authorityDomain" VARCHAR(255) NOT NULL,
    "sourceDomain" VARCHAR(255) NOT NULL,
    "remoteDeletedId" BIGINT NOT NULL,
    "type" "MessageDeleteType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FederatedMessageTombstone_threadId_fkey" FOREIGN KEY ("threadId")
        REFERENCES "MessageThread"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FederatedMessageTombstone_creatorId_fkey" FOREIGN KEY ("creatorId")
        REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FederatedMessageTombstone_target_key"
    ON "FederatedMessageTombstone"("threadId", "creatorId", "originSeq");
CREATE UNIQUE INDEX "FederatedMessageTombstone_source_event_key"
    ON "FederatedMessageTombstone"("sourceDomain", "remoteDeletedId");

CREATE TABLE "FederationDeletedCursor" (
    "id" BIGSERIAL PRIMARY KEY,
    "threadId" INTEGER NOT NULL,
    "peerDomain" VARCHAR(255) NOT NULL,
    "streamAccount" VARCHAR(255) NOT NULL DEFAULT '',
    "streamKind" VARCHAR(32) NOT NULL,
    "deletedHwm" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FederationDeletedCursor_threadId_fkey" FOREIGN KEY ("threadId")
        REFERENCES "MessageThread"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FederationDeletedCursor_stream_key"
    ON "FederationDeletedCursor"("threadId", "peerDomain", "streamAccount", "streamKind");
