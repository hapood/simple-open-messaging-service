ALTER TABLE "PeerStateFeed"
  DROP CONSTRAINT "PeerStateFeed_subject_check";

ALTER TYPE "PeerStateEventType" RENAME TO "PeerStateEventType_old";

CREATE TYPE "PeerStateEventType" AS ENUM (
  'PROFILE',
  'RELATIONSHIP_INTENT',
  'GROUP_META_FEED_HEAD',
  'THREAD_CONTENT_HEAD'
);

ALTER TABLE "PeerStateFeed"
  ALTER COLUMN "eventType" TYPE "PeerStateEventType"
  USING "eventType"::text::"PeerStateEventType";

DROP TYPE "PeerStateEventType_old";

ALTER TABLE "PeerStateFeed"
  ADD CONSTRAINT "PeerStateFeed_subject_check"
  CHECK (
    ("eventType" = 'RELATIONSHIP_INTENT'
      AND "subjectAccount" <> ''
      AND "subjectDomain" <> '')
    OR
    ("eventType" = 'THREAD_CONTENT_HEAD'
      AND (
        ("account" LIKE '!%' AND "subjectAccount" = '' AND "subjectDomain" = 'local')
        OR
        ("account" NOT LIKE '!%' AND "subjectAccount" <> '' AND "subjectDomain" = "peerDomain")
      ))
    OR
    ("eventType" NOT IN ('RELATIONSHIP_INTENT', 'THREAD_CONTENT_HEAD')
      AND "subjectAccount" = ''
      AND "subjectDomain" = 'local')
  );

DROP TABLE "FederationMessageFeedIndex";
DROP TABLE "FederationPullCursor";
DROP TABLE "FederationTombstonePullCursor";
DROP TABLE "FederationTombstoneFeedIndex";
DROP TABLE "FederationServeCursor";
DROP TABLE "FederationTombstoneServeCursor";

DROP TABLE "FederationThreadSyncState";

CREATE TABLE "FederationThreadSyncState" (
  "threadId" integer NOT NULL,
  "peerDomain" varchar(63) NOT NULL,
  "messageTargetSeq" integer NOT NULL DEFAULT 0,
  "deletionTargetSeq" integer NOT NULL DEFAULT 0,
  "messageProcessedThroughSeq" integer NOT NULL DEFAULT 0,
  "deletionProcessedThroughSeq" integer NOT NULL DEFAULT 0,
  "reverseNextBeforeSeq" integer NOT NULL DEFAULT 0,
  "reverseClosureOriginSeq" integer,
  "historyBoundaryReached" boolean NOT NULL DEFAULT false,
  "updatedAt" timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationThreadSyncState_pkey"
    PRIMARY KEY ("threadId", "peerDomain"),
  CONSTRAINT "FederationThreadSyncState_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"(id) ON DELETE CASCADE,
  CONSTRAINT "FederationThreadSyncState_peerDomain_fkey"
    FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"(domain) ON DELETE CASCADE,
  CONSTRAINT "FederationThreadSyncState_messageSeqs_check"
    CHECK (
      "messageTargetSeq" >= 0
      AND "deletionTargetSeq" >= 0
      AND "messageProcessedThroughSeq" >= 0
      AND "deletionProcessedThroughSeq" >= 0
      AND "messageProcessedThroughSeq" <= "messageTargetSeq"
      AND "deletionProcessedThroughSeq" <= "deletionTargetSeq"
      AND "reverseNextBeforeSeq" >= 0
      AND (
        "reverseNextBeforeSeq" <= "messageTargetSeq"
        OR "reverseNextBeforeSeq" - 1 = "messageTargetSeq"
      )
    ),
  CONSTRAINT "FederationThreadSyncState_reverseClosureOriginSeq_check"
    CHECK (
      "reverseClosureOriginSeq" IS NULL
      OR (
        "reverseClosureOriginSeq" > 0
        AND "reverseClosureOriginSeq" < "reverseNextBeforeSeq"
      )
    )
);
