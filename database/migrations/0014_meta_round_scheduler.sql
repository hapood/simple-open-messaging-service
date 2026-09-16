-- Group Meta sync becomes a scheduler round. The durable SYNC_GROUP_META task,
-- the async handoff machinery behind it, and the standalone profile feed
-- projection are retired. The compacted GROUP_PROFILE item merges onto GroupMeta
-- (its coordinate is always the current metaEndId), meta sync progress becomes a
-- target/processed pair on the same row, and the meta feed id narrows to the
-- protocol's integer coordinate space.

-- 1. The compacted GROUP_PROFILE item folds into GroupMeta.
ALTER TABLE "GroupMeta" ADD COLUMN "profileRev" integer DEFAULT 0 NOT NULL;

UPDATE "GroupMeta" f
SET "profileRev" = p."profileRev"
FROM "GroupMetaProfileFeed" p
WHERE p."threadId" = f."threadId";

ALTER TABLE "GroupMeta"
  ADD CONSTRAINT "GroupMeta_profileRev_check" CHECK ("profileRev" >= 0);

DROP TABLE "GroupMetaProfileFeed";

-- 2. Full snapshot swaps replace fullSyncRunId row marking; the feed id
-- narrows to integer.
ALTER TABLE "GroupMetaMemberFeed"
  DROP CONSTRAINT "GroupMetaMemberFeed_fullSyncRunId_fkey";

DROP INDEX "GroupMetaMemberFeed_full_sync_idx";

ALTER TABLE "GroupMetaMemberFeed" DROP COLUMN "fullSyncRunId";

ALTER TABLE "GroupMetaMemberFeed"
  ALTER COLUMN "feedId" TYPE integer;

-- 3. Meta round progress pair on GroupMeta; the applied cursor narrows to
-- integer as well. In-flight sync state is discarded with the retiring
-- durable task rows; the next peer push re-derives the target.
ALTER TABLE "GroupMeta"
  ALTER COLUMN "metaEndId" TYPE integer,
  ADD COLUMN "metaTargetId" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "metaProcessedThroughId" integer DEFAULT 0 NOT NULL;

ALTER TABLE "GroupMeta"
  ADD CONSTRAINT "GroupMeta_metaTargetId_check" CHECK ("metaTargetId" >= 0),
  ADD CONSTRAINT "GroupMeta_metaProcessedThroughId_check" CHECK (
    "metaProcessedThroughId" >= 0
    AND "metaProcessedThroughId" <= "metaTargetId");

DELETE FROM "DurableTask";

-- 4. Per-member published coordinates: the meta feed id narrows to integer and
-- the thread feed gains the published counterpart profile revision.
ALTER TABLE "AccountThreadState"
  ALTER COLUMN "groupMetaFeedEndId" TYPE integer;

ALTER TABLE "AccountThreadState"
  ADD COLUMN "threadProfileRev" integer DEFAULT 0 NOT NULL;

ALTER TABLE "AccountThreadState"
  ADD CONSTRAINT "AccountThreadState_threadProfileRev_check"
  CHECK ("threadProfileRev" >= 0);

-- 5. Retire the async handoff status. Every trigger, check, and partial index
-- predicate that mentions "status" binds the enum type by OID, so all of them
-- are dropped here and rebuilt against the swapped type below.
DROP INDEX "DurableTask_blocking_scope_id_idx";
DROP INDEX "DurableTask_one_processing_per_scope";
DROP INDEX "DurableTask_pending_coalescing_key_idx";
DROP INDEX "DurableTask_pending_id_idx";
ALTER TABLE "DurableTask"
  DROP CONSTRAINT "DurableTask_status_timestamps_check",
  DROP CONSTRAINT "DurableTask_error_check",
  DROP CONSTRAINT "DurableTask_result_check",
  DROP CONSTRAINT "DurableTask_supersession_check";
DROP TRIGGER "DurableTask_insert_wake" ON "DurableTask";
DROP TRIGGER "DurableTask_update_wake" ON "DurableTask";

ALTER TABLE "DurableTask" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "DurableTaskStatus" RENAME TO "DurableTaskStatus_retired";
CREATE TYPE "DurableTaskStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'REJECTED',
  'FAILED',
  'SUPERSEDED'
);
ALTER TABLE "DurableTask" ALTER COLUMN "status" TYPE "DurableTaskStatus"
  USING "status"::text::"DurableTaskStatus";
ALTER TABLE "DurableTask" ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "DurableTaskStatus_retired";

CREATE INDEX "DurableTask_blocking_scope_id_idx"
  ON "DurableTask" (kind, "scopeKey", id)
  WHERE status IN ('PENDING', 'PROCESSING');
CREATE UNIQUE INDEX "DurableTask_one_processing_per_scope"
  ON "DurableTask" (kind, "scopeKey")
  WHERE status = 'PROCESSING';
CREATE INDEX "DurableTask_pending_coalescing_key_idx"
  ON "DurableTask" ("coalescingKey", id)
  WHERE status = 'PENDING' AND "coalescingKey" IS NOT NULL;
CREATE INDEX "DurableTask_pending_id_idx"
  ON "DurableTask" (id)
  WHERE status = 'PENDING';

ALTER TABLE "DurableTask"
  ADD CONSTRAINT "DurableTask_status_timestamps_check" CHECK ((
    status = 'PENDING' AND "startedAt" IS NULL AND "completedAt" IS NULL
  ) OR (
    status = 'PROCESSING' AND "startedAt" IS NOT NULL AND "completedAt" IS NULL
  ) OR (
    status IN ('SUCCEEDED', 'REJECTED', 'FAILED')
      AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL
  ) OR (
    status = 'SUPERSEDED' AND "startedAt" IS NULL AND "completedAt" IS NOT NULL
  )),
  ADD CONSTRAINT "DurableTask_error_check" CHECK (
    "lastError" IS NULL
    OR status = 'FAILED'
  ),
  ADD CONSTRAINT "DurableTask_result_check" CHECK (
    "resultCode" IS NULL
    OR status IN ('SUCCEEDED', 'REJECTED')
  ),
  ADD CONSTRAINT "DurableTask_supersession_check" CHECK (
    status <> 'SUPERSEDED'
    OR "coalescingKey" IS NOT NULL
  );

CREATE TRIGGER "DurableTask_insert_wake"
AFTER INSERT ON "DurableTask"
FOR EACH ROW WHEN (NEW.status = 'PENDING')
EXECUTE FUNCTION public.notify_durable_task_work();

CREATE TRIGGER "DurableTask_update_wake"
AFTER UPDATE ON "DurableTask"
FOR EACH ROW WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  OR (NEW.status = 'PENDING' AND (
    OLD."taskType" IS DISTINCT FROM NEW."taskType"
    OR OLD.payload IS DISTINCT FROM NEW.payload
    OR OLD.checkpoint IS DISTINCT FROM NEW.checkpoint
  ))
)
EXECUTE FUNCTION public.notify_durable_task_work();

-- 6. The mirror's full-snapshot window becomes a persisted through (NULL
-- selects delta rounds; only writers that also zero the processed cursor
-- reopen it), and the reverse-history reached flag collapses into its
-- activeGapId derivation.
ALTER TABLE "GroupMeta"
  ADD COLUMN "metaRecoveryThroughId" integer;

ALTER TABLE "GroupMeta"
  ADD CONSTRAINT "GroupMeta_metaRecovery_check" CHECK (
    "metaRecoveryThroughId" IS NULL
    OR ("metaProcessedThroughId" < "metaRecoveryThroughId"
        AND "metaRecoveryThroughId" <= "metaTargetId"));

ALTER TABLE "FederationThreadSyncState"
  DROP CONSTRAINT "FederationThreadSyncState_history_check",
  DROP COLUMN "historyBoundaryReached";

-- 7. The compacted GROUP_PROFILE item becomes a stored feed fact: it allocates
-- its own coordinate like any member fact (subject = the group itself), so the
-- serving side no longer synthesizes a marker at metaEndId.
ALTER TYPE "GroupMetaMemberOperation" ADD VALUE 'GROUP_PROFILE' AFTER 'DEPART';
