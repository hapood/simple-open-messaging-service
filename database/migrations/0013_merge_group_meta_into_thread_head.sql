-- Group Meta progress is part of the complete thread head. Remove the retired
-- standalone state projections and any durable work that could recreate them.
DELETE FROM "DurableTask"
WHERE "taskType" = 'FAN_OUT_GROUP_META_HEAD';

DELETE FROM "PeerStateFeed"
WHERE "eventType" = 'GROUP_META_FEED_HEAD';

DELETE FROM "ClientStateFeed"
WHERE "eventType" = 'GROUP_META_FEED_HEAD';

ALTER TABLE "PeerStateFeed"
  DROP CONSTRAINT "PeerStateFeed_subject_check";

ALTER TYPE "PeerStateEventType" RENAME TO "PeerStateEventType_legacy";

CREATE TYPE "PeerStateEventType" AS ENUM (
  'RELATIONSHIP_INTENT',
  'THREAD_CONTENT_HEAD'
);

ALTER TABLE "PeerStateFeed"
  ALTER COLUMN "eventType" TYPE "PeerStateEventType"
  USING "eventType"::text::"PeerStateEventType";

DROP TYPE "PeerStateEventType_legacy";

ALTER TABLE "PeerStateFeed"
  ADD CONSTRAINT "PeerStateFeed_subject_check" CHECK (
    ("eventType" = 'RELATIONSHIP_INTENT'
      AND "subjectAccount" <> ''
      AND "subjectDomain" <> '')
    OR
    ("eventType" = 'THREAD_CONTENT_HEAD' AND (
      ("account" LIKE '!%'
        AND "subjectAccount" = ''
        AND "subjectDomain" = 'local')
      OR
      ("account" NOT LIKE '!%'
        AND "subjectAccount" <> ''
        AND "subjectDomain" = "peerDomain")
    ))
  );
