-- Stabilize unacknowledged per-peer feed IDs across process restarts and give the
-- tombstone feed an allocator/HWM independent from the message feed.

CREATE TABLE "FederationMessageFeedAllocation" (
  "peerDomain" VARCHAR(63) NOT NULL,
  "feedId" BIGINT NOT NULL,
  "epochId" BIGINT NOT NULL,
  "messageId" BIGINT NOT NULL,
  "messageSeq" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationMessageFeedAllocation_pkey" PRIMARY KEY ("peerDomain", "feedId"),
  CONSTRAINT "FederationMessageFeedAllocation_peerDomain_fkey"
    FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederationMessageFeedAllocation_epochId_fkey"
    FOREIGN KEY ("epochId") REFERENCES "FederationAudienceEpoch"("id") ON DELETE CASCADE,
  CONSTRAINT "FederationMessageFeedAllocation_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE,
  CONSTRAINT "FederationMessageFeedAllocation_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "FederationMessageFeedAllocation_messageSeq_check" CHECK ("messageSeq" >= 0)
);

CREATE UNIQUE INDEX "FederationMessageFeedAllocation_message_key"
  ON "FederationMessageFeedAllocation" ("peerDomain", "epochId", "messageId");

ALTER TABLE "FederationTombstoneServeCursor"
  ADD COLUMN "allocatedThrough" BIGINT NOT NULL DEFAULT 0;

UPDATE "FederationTombstoneServeCursor"
SET "allocatedThrough" = GREATEST("startChangeId", "acknowledgedThrough", "lastServedThrough");

ALTER TABLE "FederationTombstoneServeCursor"
  DROP CONSTRAINT "FederationTombstoneServeCursor_order_check";

ALTER TABLE "FederationTombstoneServeCursor"
  ADD CONSTRAINT "FederationTombstoneServeCursor_order_check" CHECK (
    "startChangeId" >= 0
    AND "acknowledgedThrough" >= "startChangeId"
    AND "lastServedThrough" >= "acknowledgedThrough"
    AND "allocatedThrough" >= "lastServedThrough"
  );

CREATE TABLE "FederationTombstoneFeedAllocation" (
  "peerDomain" VARCHAR(63) NOT NULL,
  "feedId" BIGINT NOT NULL,
  "epochId" BIGINT NOT NULL,
  "deletionId" BIGINT NOT NULL,
  "threadId" INTEGER NOT NULL,
  "messageSeq" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationTombstoneFeedAllocation_pkey" PRIMARY KEY ("peerDomain", "feedId"),
  CONSTRAINT "FederationTombstoneFeedAllocation_peerDomain_fkey"
    FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederationTombstoneFeedAllocation_epochId_fkey"
    FOREIGN KEY ("epochId") REFERENCES "FederationAudienceEpoch"("id") ON DELETE CASCADE,
  CONSTRAINT "FederationTombstoneFeedAllocation_deletionId_fkey"
    FOREIGN KEY ("deletionId") REFERENCES "DeletedMessage"("id") ON DELETE CASCADE,
  CONSTRAINT "FederationTombstoneFeedAllocation_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE,
  CONSTRAINT "FederationTombstoneFeedAllocation_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "FederationTombstoneFeedAllocation_messageSeq_check" CHECK ("messageSeq" >= 0)
);

CREATE UNIQUE INDEX "FederationTombstoneFeedAllocation_deletion_key"
  ON "FederationTombstoneFeedAllocation" ("peerDomain", "epochId", "deletionId");

-- A zero cursor is a valid remote position, so persist whether bootstrap without `after` completed.
ALTER TABLE "PeerStateFeedPullCursor"
  ADD COLUMN "initialized" BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE "PeerStateFeedPullCursor" SET "initialized" = TRUE;

ALTER TABLE "FederationPullCursor"
  ADD COLUMN "initialized" BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE "FederationPullCursor" SET "initialized" = TRUE;

ALTER TABLE "FederationTombstonePullCursor"
  ADD COLUMN "initialized" BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE "FederationTombstonePullCursor" SET "initialized" = TRUE;
