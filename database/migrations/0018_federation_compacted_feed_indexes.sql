CREATE TABLE "FederationMessageFeedIndex" (
  "peerDomain" VARCHAR(63) NOT NULL,
  "threadId" INTEGER NOT NULL,
  "feedId" BIGINT NOT NULL,
  "messageEndSeq" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationMessageFeedIndex_pkey" PRIMARY KEY ("peerDomain", "threadId"),
  CONSTRAINT "FederationMessageFeedIndex_peerDomain_feedId_key" UNIQUE ("peerDomain", "feedId"),
  CONSTRAINT "FederationMessageFeedIndex_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederationMessageFeedIndex_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT,
  CONSTRAINT "FederationMessageFeedIndex_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "FederationMessageFeedIndex_messageEndSeq_check" CHECK ("messageEndSeq" >= 0)
);

CREATE TABLE "FederationTombstoneFeedIndex" (
  "peerDomain" VARCHAR(63) NOT NULL,
  "threadId" INTEGER NOT NULL,
  "feedId" BIGINT NOT NULL,
  "tombstoneEndSeq" BIGINT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationTombstoneFeedIndex_pkey" PRIMARY KEY ("peerDomain", "threadId"),
  CONSTRAINT "FederationTombstoneFeedIndex_peerDomain_feedId_key" UNIQUE ("peerDomain", "feedId"),
  CONSTRAINT "FederationTombstoneFeedIndex_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederationTombstoneFeedIndex_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT,
  CONSTRAINT "FederationTombstoneFeedIndex_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "FederationTombstoneFeedIndex_tombstoneEndSeq_check" CHECK ("tombstoneEndSeq" > 0)
);

CREATE TABLE "FederationMessageQueryCursor" (
  "peerDomain" VARCHAR(63) NOT NULL,
  "threadKey" VARCHAR(255) NOT NULL,
  "committedThrough" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationMessageQueryCursor_pkey" PRIMARY KEY ("peerDomain", "threadKey"),
  CONSTRAINT "FederationMessageQueryCursor_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederationMessageQueryCursor_committedThrough_check" CHECK ("committedThrough" >= -1)
);

CREATE TABLE "FederationTombstoneQueryCursor" (
  "peerDomain" VARCHAR(63) NOT NULL,
  "threadKey" VARCHAR(255) NOT NULL,
  "committedThrough" BIGINT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationTombstoneQueryCursor_pkey" PRIMARY KEY ("peerDomain", "threadKey"),
  CONSTRAINT "FederationTombstoneQueryCursor_peerDomain_fkey" FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederationTombstoneQueryCursor_committedThrough_check" CHECK ("committedThrough" >= 0)
);

INSERT INTO "FederationMessageFeedIndex" ("peerDomain", "threadId", "feedId", "messageEndSeq")
SELECT DISTINCT ON (allocation."peerDomain", allocation."threadId")
       allocation."peerDomain", allocation."threadId", allocation."feedId", allocation."messageSeq"
FROM "FederationMessageFeedAllocation" allocation
ORDER BY allocation."peerDomain", allocation."threadId", allocation."messageSeq" DESC, allocation."feedId" DESC;

INSERT INTO "FederationTombstoneFeedIndex" ("peerDomain", "threadId", "feedId", "tombstoneEndSeq")
SELECT DISTINCT ON (allocation."peerDomain", allocation."threadId")
       allocation."peerDomain", allocation."threadId", allocation."feedId", allocation."deletionId"
FROM "FederationTombstoneFeedAllocation" allocation
ORDER BY allocation."peerDomain", allocation."threadId", allocation."deletionId" DESC, allocation."feedId" DESC;

DROP TABLE "FederationMessageFeedAllocation";
DROP TABLE "FederationTombstoneFeedAllocation";

ALTER TABLE "ThreadAudience"
  DROP CONSTRAINT IF EXISTS "ThreadAudience_deliverThroughChangeId_check",
  DROP COLUMN "deliverThroughChangeId";

ALTER TABLE "PeerStateFeedTarget"
  DROP CONSTRAINT IF EXISTS "PeerStateFeedTarget_cursor_check",
  DROP COLUMN "retainedAfter",
  DROP COLUMN "acknowledgedThrough",
  DROP COLUMN "lastServedThrough",
  DROP COLUMN "lastServedScanEnd";

ALTER TABLE "FederationServeCursor"
  DROP CONSTRAINT IF EXISTS "FederationServeCursor_allocatedThrough_check",
  DROP CONSTRAINT IF EXISTS "FederationServeCursor_retainedAfter_check",
  DROP CONSTRAINT IF EXISTS "FederationServeCursor_acknowledgedThrough_check",
  DROP CONSTRAINT IF EXISTS "FederationServeCursor_lastServedThrough_check",
  DROP CONSTRAINT IF EXISTS "FederationServeCursor_degradation_check",
  DROP COLUMN "retainedAfter",
  DROP COLUMN "acknowledgedThrough",
  DROP COLUMN "lastServedThrough",
  DROP COLUMN "degradedAt",
  DROP COLUMN "degradedThrough",
  DROP COLUMN "degradationReason",
  ADD CONSTRAINT "FederationServeCursor_allocatedThrough_check" CHECK ("allocatedThrough" >= 0);

ALTER TABLE "FederationTombstoneServeCursor"
  DROP CONSTRAINT IF EXISTS "FederationTombstoneServeCursor_order_check",
  DROP COLUMN "retainedAfter",
  DROP COLUMN "acknowledgedThrough",
  DROP COLUMN "lastServedThrough",
  ADD CONSTRAINT "FederationTombstoneServeCursor_order_check"
    CHECK ("sourceScannedThrough" >= 0 AND "allocatedThrough" >= 0);
