DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "DeletedMessage" WHERE id > 2147483647
  ) OR EXISTS (
    SELECT 1 FROM "FederatedMessageTombstone" WHERE "remoteDeletedId" > 2147483647
  ) OR EXISTS (
    SELECT 1 FROM "FederationDeletedCursor" WHERE "deletedHwm" > 2147483647
  ) OR EXISTS (
    SELECT 1 FROM "ClientMessageTombstoneFeed" WHERE "tombstoneEndSeq" > 2147483647
  ) OR EXISTS (
    SELECT 1 FROM "FederationTombstoneFeedIndex" WHERE "tombstoneEndSeq" > 2147483647
  ) OR EXISTS (
    SELECT 1 FROM "FederationTombstoneQueryCursor" WHERE "committedThrough" > 2147483647
  ) THEN
    RAISE EXCEPTION 'thread-local deletion coordinates exceed the supported integer range';
  END IF;
END
$$;

ALTER TABLE "MessageThread"
  ADD COLUMN "deletionSeqAllocatedThrough" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "MessageThread_deletionSeqAllocatedThrough_check"
    CHECK ("deletionSeqAllocatedThrough" >= 0);

ALTER TABLE "DeletedMessage"
  RENAME COLUMN seq TO "messageSeq";

ALTER TABLE "DeletedMessage"
  ADD COLUMN "deletionSeq" integer;

UPDATE "DeletedMessage"
SET "deletionSeq" = id::integer;

UPDATE "MessageThread" thread
SET "deletionSeqAllocatedThrough" = source.maximum
FROM (
  SELECT "threadId", MAX("deletionSeq")::integer AS maximum
  FROM "DeletedMessage"
  GROUP BY "threadId"
) source
WHERE thread.id = source."threadId";

ALTER TABLE "DeletedMessage"
  DROP CONSTRAINT "DeletedMessage_pkey",
  DROP CONSTRAINT "DeletedMessage_seq_check";

DROP INDEX "DeletedMessage_threadId_seq_key";
DROP INDEX "DeletedMessage_threadId_id_idx";

ALTER TABLE "DeletedMessage"
  ALTER COLUMN "deletionSeq" SET NOT NULL,
  ADD CONSTRAINT "DeletedMessage_pkey" PRIMARY KEY ("threadId", "deletionSeq"),
  ADD CONSTRAINT "DeletedMessage_deletionSeq_check" CHECK ("deletionSeq" > 0),
  ADD CONSTRAINT "DeletedMessage_messageSeq_check" CHECK ("messageSeq" > 0);

CREATE UNIQUE INDEX "DeletedMessage_threadId_messageSeq_key"
  ON "DeletedMessage" ("threadId", "messageSeq");

ALTER TABLE "DeletedMessage" DROP COLUMN id;
DROP SEQUENCE IF EXISTS "DeletedMessage_id_seq";

DROP INDEX "FederatedMessageTombstone_source_event_key";

ALTER TABLE "FederatedMessageTombstone"
  RENAME COLUMN "remoteDeletedId" TO "remoteDeletionSeq";

ALTER TABLE "FederatedMessageTombstone"
  ALTER COLUMN "remoteDeletionSeq" TYPE integer USING "remoteDeletionSeq"::integer,
  ADD CONSTRAINT "FederatedMessageTombstone_remoteDeletionSeq_check"
    CHECK ("remoteDeletionSeq" > 0);

CREATE UNIQUE INDEX "FederatedMessageTombstone_source_event_key"
  ON "FederatedMessageTombstone" ("sourceDomain", "threadId", "remoteDeletionSeq");

ALTER TABLE "FederationDeletedCursor"
  RENAME COLUMN "deletedHwm" TO "committedThrough";

ALTER TABLE "FederationDeletedCursor"
  ALTER COLUMN "committedThrough" TYPE integer USING "committedThrough"::integer,
  ALTER COLUMN "committedThrough" SET DEFAULT 0,
  ADD CONSTRAINT "FederationDeletedCursor_committedThrough_check"
    CHECK ("committedThrough" >= 0);

ALTER TABLE "ClientMessageTombstoneFeed"
  ALTER COLUMN "tombstoneEndSeq" TYPE integer USING "tombstoneEndSeq"::integer;

ALTER TABLE "FederationTombstoneFeedIndex"
  ALTER COLUMN "tombstoneEndSeq" TYPE integer USING "tombstoneEndSeq"::integer;

ALTER TABLE "FederationTombstoneQueryCursor"
  ALTER COLUMN "committedThrough" TYPE integer USING "committedThrough"::integer;

ALTER TABLE "FederationTombstoneServeCursor"
  DROP CONSTRAINT "FederationTombstoneServeCursor_order_check",
  DROP COLUMN "sourceScannedThrough",
  ADD CONSTRAINT "FederationTombstoneServeCursor_allocatedThrough_check"
    CHECK ("allocatedThrough" >= 0);
