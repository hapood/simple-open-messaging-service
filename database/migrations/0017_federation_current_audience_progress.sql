-- Message delivery follows the current ThreadAudience row. Reauthorization resets one scan
-- position; there is no historical access generation. Tombstones use independent per-peer source
-- progress and never depend on message audience epochs.

ALTER TABLE "ThreadAudience"
  ADD COLUMN "messageScannedThroughSeq" INTEGER,
  ADD CONSTRAINT "ThreadAudience_messageScannedThroughSeq_check"
    CHECK ("messageScannedThroughSeq" IS NULL OR "messageScannedThroughSeq" >= -1);

UPDATE "ThreadAudience" audience
SET "messageScannedThroughSeq" = COALESCE(
  (
    SELECT GREATEST(
      epoch."fromSeq" - 1,
      checkpoint."acknowledgedSeq",
      COALESCE(MAX(allocation."messageSeq"), -1)
    )
    FROM "FederationAudienceEpoch" epoch
    JOIN "FederationThreadCheckpoint" checkpoint ON checkpoint."epochId" = epoch.id
    LEFT JOIN "FederationMessageFeedAllocation" allocation ON allocation."epochId" = epoch.id
    WHERE epoch."peerDomain" = audience."targetDomain"
      AND epoch."threadId" = audience."threadId"
      AND epoch."throughSeq" IS NULL
    GROUP BY epoch.id, checkpoint."acknowledgedSeq"
    LIMIT 1
  ),
  (SELECT thread."curSeq" FROM "MessageThread" thread WHERE thread.id = audience."threadId")
)
WHERE audience."targetDomain" <> 'local';

ALTER TABLE "DeletedMessage" ADD COLUMN "federationSourceDomain" VARCHAR(63);

UPDATE "DeletedMessage" deleted
SET "federationSourceDomain" = CASE
  WHEN thread.type = 'GROUP' AND group_user.domain = 'local' THEN NULL
  ELSE pending."sourceDomain"
END
FROM "Message" target
JOIN "FederatedMessageTombstone" pending
  ON pending."threadId" = target."threadId"
 AND pending."creatorId" = target.creator
 AND pending."originSeq" = COALESCE(target."originSeq", target.seq)
JOIN "MessageThread" thread ON thread.id = target."threadId"
LEFT JOIN "User" group_user ON group_user.id = thread."groupUserId"
WHERE deleted."threadId" = target."threadId"
  AND deleted.seq = target.seq;

-- Matched rows were retained by the old implementation. DeletedMessage is now the durable fact;
-- this table contains only unmatched inbound deletions.
DELETE FROM "FederatedMessageTombstone" pending
USING "Message" target
WHERE pending."threadId" = target."threadId"
  AND pending."creatorId" = target.creator
  AND pending."originSeq" = COALESCE(target."originSeq", target.seq);

ALTER TABLE "FederationMessageFeedAllocation" ADD COLUMN "threadId" INTEGER;
UPDATE "FederationMessageFeedAllocation" allocation
SET "threadId" = target."threadId"
FROM "Message" target
WHERE target.id = allocation."messageId";

-- A closed legacy generation can still contain committed work beyond its checkpoint. Materialize
-- that tail before removing the generation tables. Already-acknowledged history is not replayed.
WITH candidates AS (
  SELECT DISTINCT ON (epoch."peerDomain", target.id)
    epoch."peerDomain",
    epoch.id AS "epochId",
    target.id AS "messageId",
    target."threadId",
    target.seq AS "messageSeq"
  FROM "FederationAudienceEpoch" epoch
  JOIN "FederationThreadCheckpoint" checkpoint ON checkpoint."epochId" = epoch.id
  JOIN "Message" target
    ON target."threadId" = epoch."threadId"
   AND target.seq > checkpoint."acknowledgedSeq"
   AND target.seq <= epoch."throughSeq"
  JOIN "MessageThread" thread ON thread.id = target."threadId"
  JOIN "User" creator ON creator.id = target.creator
  LEFT JOIN "User" group_user ON group_user.id = thread."groupUserId"
  LEFT JOIN "FederationMessageFeedAllocation" existing
    ON existing."peerDomain" = epoch."peerDomain" AND existing."messageId" = target.id
  WHERE epoch."throughSeq" IS NOT NULL
    AND existing."messageId" IS NULL
    AND target."contentType" <> 'SYSTEM'
    AND NOT (
      thread.type = 'GROUP'
      AND group_user.domain <> 'local'
      AND (creator."isForeigner" OR target."originSeq" IS NOT NULL)
    )
  ORDER BY epoch."peerDomain", target.id, epoch.id
), numbered AS (
  SELECT candidates.*,
         cursor."allocatedThrough"
           + ROW_NUMBER() OVER (
               PARTITION BY candidates."peerDomain"
               ORDER BY candidates."epochId", candidates."messageSeq", candidates."messageId"
             ) AS "feedId"
  FROM candidates
  JOIN "FederationServeCursor" cursor ON cursor."peerDomain" = candidates."peerDomain"
), inserted AS (
  INSERT INTO "FederationMessageFeedAllocation" (
    "peerDomain", "feedId", "epochId", "messageId", "threadId", "messageSeq"
  )
  SELECT "peerDomain", "feedId", "epochId", "messageId", "threadId", "messageSeq"
  FROM numbered
  RETURNING "peerDomain", "feedId"
), new_heads AS (
  SELECT "peerDomain", MAX("feedId") AS "feedId"
  FROM inserted
  GROUP BY "peerDomain"
)
UPDATE "FederationServeCursor" cursor
SET "allocatedThrough" = new_heads."feedId", "updatedAt" = CURRENT_TIMESTAMP
FROM new_heads
WHERE cursor."peerDomain" = new_heads."peerDomain";

ALTER TABLE "FederationMessageFeedAllocation"
  ALTER COLUMN "threadId" SET NOT NULL,
  DROP CONSTRAINT "FederationMessageFeedAllocation_epochId_fkey",
  ADD CONSTRAINT "FederationMessageFeedAllocation_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"(id) ON DELETE CASCADE;
DROP INDEX "FederationMessageFeedAllocation_message_key";
CREATE INDEX "FederationMessageFeedAllocation_message_key"
  ON "FederationMessageFeedAllocation" ("peerDomain", "messageId");
ALTER TABLE "FederationMessageFeedAllocation" DROP COLUMN "epochId";

CREATE TABLE "FederationMessageDelivery" (
  "peerDomain" VARCHAR(63) NOT NULL,
  "messageId" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationMessageDelivery_pkey" PRIMARY KEY ("peerDomain", "messageId"),
  CONSTRAINT "FederationMessageDelivery_peerDomain_fkey"
    FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"(domain) ON DELETE CASCADE,
  CONSTRAINT "FederationMessageDelivery_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"(id) ON DELETE CASCADE
);

-- Unacknowledged/recovered allocations are exact proofs.
INSERT INTO "FederationMessageDelivery" ("peerDomain", "messageId", "createdAt")
SELECT allocation."peerDomain", allocation."messageId", MIN(allocation."createdAt")
FROM "FederationMessageFeedAllocation" allocation
GROUP BY allocation."peerDomain", allocation."messageId"
ON CONFLICT DO NOTHING;

-- Legacy checkpoints prove that every eligible message through the checkpoint was scanned and
-- allocated to that peer, even when its retry allocation row was later removed by ACK.
INSERT INTO "FederationMessageDelivery" ("peerDomain", "messageId")
SELECT DISTINCT epoch."peerDomain", target.id
FROM "FederationAudienceEpoch" epoch
JOIN "FederationThreadCheckpoint" checkpoint ON checkpoint."epochId" = epoch.id
JOIN "Message" target
  ON target."threadId" = epoch."threadId"
 AND target.seq >= epoch."fromSeq"
 AND target.seq <= checkpoint."acknowledgedSeq"
JOIN "MessageThread" thread ON thread.id = target."threadId"
JOIN "User" creator ON creator.id = target.creator
LEFT JOIN "User" group_user ON group_user.id = thread."groupUserId"
WHERE target."contentType" <> 'SYSTEM'
  AND NOT (
    thread.type = 'GROUP'
    AND group_user.domain <> 'local'
    AND (creator."isForeigner" OR target."originSeq" IS NOT NULL)
  )
ON CONFLICT DO NOTHING;

ALTER TABLE "FederationTombstoneServeCursor"
  ADD COLUMN "sourceScannedThrough" BIGINT NOT NULL DEFAULT 0;
UPDATE "FederationTombstoneServeCursor"
SET "sourceScannedThrough" = COALESCE((SELECT MAX(id) FROM "DeletedMessage"), 0);
ALTER TABLE "FederationTombstoneServeCursor"
  DROP CONSTRAINT "FederationTombstoneServeCursor_order_check",
  ADD CONSTRAINT "FederationTombstoneServeCursor_order_check" CHECK (
    "sourceScannedThrough" >= 0
    AND "retainedAfter" >= 0
    AND "acknowledgedThrough" >= "retainedAfter"
    AND "lastServedThrough" >= "acknowledgedThrough"
    AND "allocatedThrough" >= "lastServedThrough"
  );

-- Preserve deletion work that a legacy audience checkpoint had not yet covered. Existing durable
-- allocations are retained; only the remaining authorized tail receives new IDs.
WITH candidates AS (
  SELECT DISTINCT ON (epoch."peerDomain", deleted.id)
    epoch."peerDomain",
    epoch.id AS "epochId",
    deleted.id AS "deletionId",
    deleted."threadId",
    deleted.seq AS "messageSeq"
  FROM "FederationAudienceEpoch" epoch
  JOIN "FederationTombstoneCheckpoint" checkpoint ON checkpoint."epochId" = epoch.id
  JOIN "DeletedMessage" deleted ON deleted.id > checkpoint."acknowledgedDeletedId"
  JOIN "Message" target
    ON target."threadId" = deleted."threadId" AND target.seq = deleted.seq
  JOIN "MessageThread" thread
    ON thread.id = deleted."threadId" AND thread.id = epoch."threadId"
  JOIN "User" creator ON creator.id = target.creator
  LEFT JOIN "User" group_user ON group_user.id = thread."groupUserId"
  LEFT JOIN "FederationTombstoneFeedAllocation" existing
    ON existing."peerDomain" = epoch."peerDomain" AND existing."deletionId" = deleted.id
  WHERE deleted."federationSourceDomain" IS NULL
    AND target.seq >= epoch."fromSeq"
    AND target.seq <= COALESCE(epoch."throughSeq", thread."curSeq")
    AND existing."deletionId" IS NULL
    AND (
      (thread.type = 'P2P' AND creator."isForeigner" = false)
      OR (
        thread.type = 'GROUP'
        AND (
          group_user.domain = 'local'
          OR (creator."isForeigner" = false AND target."originSeq" IS NULL)
        )
      )
    )
  ORDER BY epoch."peerDomain", deleted.id, epoch.id
), numbered AS (
  SELECT candidates.*,
         cursor."allocatedThrough"
           + ROW_NUMBER() OVER (
               PARTITION BY candidates."peerDomain"
               ORDER BY candidates."epochId", candidates."deletionId"
             ) AS "feedId"
  FROM candidates
  JOIN "FederationTombstoneServeCursor" cursor
    ON cursor."peerDomain" = candidates."peerDomain"
), inserted AS (
  INSERT INTO "FederationTombstoneFeedAllocation" (
    "peerDomain", "feedId", "epochId", "deletionId", "threadId", "messageSeq"
  )
  SELECT "peerDomain", "feedId", "epochId", "deletionId", "threadId", "messageSeq"
  FROM numbered
  RETURNING "peerDomain", "feedId"
), new_heads AS (
  SELECT "peerDomain", MAX("feedId") AS "feedId"
  FROM inserted
  GROUP BY "peerDomain"
)
UPDATE "FederationTombstoneServeCursor" cursor
SET "allocatedThrough" = new_heads."feedId", "updatedAt" = CURRENT_TIMESTAMP
FROM new_heads
WHERE cursor."peerDomain" = new_heads."peerDomain";

ALTER TABLE "FederationTombstoneFeedAllocation"
  DROP CONSTRAINT "FederationTombstoneFeedAllocation_epochId_fkey";
DROP INDEX "FederationTombstoneFeedAllocation_deletion_key";
CREATE UNIQUE INDEX "FederationTombstoneFeedAllocation_deletion_key"
  ON "FederationTombstoneFeedAllocation" ("peerDomain", "deletionId");
ALTER TABLE "FederationTombstoneFeedAllocation" DROP COLUMN "epochId";

DROP TRIGGER IF EXISTS "ThreadAudience_federation_epoch_sync" ON "ThreadAudience";
DROP TRIGGER IF EXISTS "FederatedPeer_audience_epoch_seed" ON "FederatedPeer";
DROP TRIGGER IF EXISTS "FederationAudienceEpoch_tombstone_checkpoint" ON "FederationAudienceEpoch";
DROP FUNCTION IF EXISTS soms_sync_federation_audience_epoch();
DROP FUNCTION IF EXISTS soms_seed_federation_audience_epochs_for_peer();
DROP FUNCTION IF EXISTS soms_seed_federation_tombstone_checkpoint();
DROP TABLE "FederationTombstoneCheckpoint";
DROP TABLE "FederationThreadCheckpoint";
DROP TABLE "FederationAudienceEpoch";
