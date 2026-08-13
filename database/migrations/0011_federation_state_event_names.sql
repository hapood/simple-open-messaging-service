-- Align the persisted state-event vocabulary with the Federation v1 wire protocol.
-- P2P_META is renamed in place so existing compacted keys retain their revisions.

ALTER TYPE "PeerStateEventType" RENAME VALUE 'P2P_META' TO 'P2P_INTENT';
ALTER TYPE "PeerStateEventType" ADD VALUE IF NOT EXISTS 'MEMBER_PROFILE' AFTER 'PROFILE';

ALTER TABLE "PeerStateFeed" DROP CONSTRAINT IF EXISTS "PeerStateFeed_subject_check";
ALTER TABLE "PeerStateFeed" ADD CONSTRAINT "PeerStateFeed_subject_check" CHECK (
  (
    "eventType" IN ('P2P_INTENT', 'GROUP_INVITE_INTENT', 'GROUP_JOIN_INTENT')
    AND "subjectAccount" <> ''
  ) OR (
    "eventType" NOT IN ('P2P_INTENT', 'GROUP_INVITE_INTENT', 'GROUP_JOIN_INTENT')
    AND "subjectAccount" = ''
  )
);

CREATE TABLE "FederationP2PHistoryGrant" (
  "sourcePeerDomain" VARCHAR(63) NOT NULL,
  "threadId" INTEGER NOT NULL,
  "throughFeedId" BIGINT NOT NULL,
  "stateRevision" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationP2PHistoryGrant_pkey" PRIMARY KEY ("sourcePeerDomain", "threadId"),
  CONSTRAINT "FederationP2PHistoryGrant_sourcePeerDomain_fkey"
    FOREIGN KEY ("sourcePeerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederationP2PHistoryGrant_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE,
  CONSTRAINT "FederationP2PHistoryGrant_throughFeedId_check" CHECK ("throughFeedId" >= 0),
  CONSTRAINT "FederationP2PHistoryGrant_stateRevision_check" CHECK ("stateRevision" >= 0)
);

ALTER TABLE "PeerStateFeedTarget"
  ADD COLUMN "lastServedScanEnd" BIGINT NOT NULL DEFAULT 0;

UPDATE "PeerStateFeedTarget"
SET "lastServedScanEnd" = "lastServedThrough";

ALTER TABLE "PeerStateFeedTarget" DROP CONSTRAINT IF EXISTS "PeerStateFeedTarget_cursor_check";
ALTER TABLE "PeerStateFeedTarget" ADD CONSTRAINT "PeerStateFeedTarget_cursor_check" CHECK (
  "startRev" >= 0
  AND "acknowledgedThrough" >= "startRev"
  AND "lastServedThrough" >= "acknowledgedThrough"
  AND "lastServedScanEnd" >= "lastServedThrough"
  AND "allocatedThrough" >= "lastServedScanEnd"
);

CREATE TABLE "PeerStateFeedVersion" (
  "peerDomain" VARCHAR(63) NOT NULL,
  "feedId" BIGINT NOT NULL,
  "account" VARCHAR(31) NOT NULL,
  "eventType" "PeerStateEventType" NOT NULL,
  "subjectAccount" VARCHAR(31) NOT NULL DEFAULT '',
  "revision" INTEGER NOT NULL,
  "body" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PeerStateFeedVersion_pkey" PRIMARY KEY ("peerDomain", "feedId"),
  CONSTRAINT "PeerStateFeedVersion_peerDomain_fkey"
    FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "PeerStateFeedVersion_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "PeerStateFeedVersion_revision_check" CHECK ("revision" >= 0)
);

CREATE INDEX "PeerStateFeedVersion_peer_key_idx"
  ON "PeerStateFeedVersion" ("peerDomain", "account", "eventType", "subjectAccount", "feedId");

INSERT INTO "PeerStateFeedVersion" (
  "peerDomain", "feedId", account, "eventType", "subjectAccount", revision, body, "createdAt"
)
SELECT "peerDomain", rev, account, "eventType", "subjectAccount", revision, body, "createdAt"
FROM "PeerStateFeed"
ON CONFLICT DO NOTHING;
