DROP INDEX "DurableTask_pending_id_idx";
DROP INDEX "DurableTask_blocking_scope_id_idx";
DROP INDEX "DurableTask_one_processing_per_scope";
DROP INDEX "DurableTask_pending_coalescing_key_idx";

ALTER TABLE "DurableTask"
  DROP CONSTRAINT "DurableTask_supersession_check",
  DROP CONSTRAINT "DurableTask_status_timestamps_check",
  DROP CONSTRAINT "DurableTask_result_check",
  DROP CONSTRAINT "DurableTask_error_check";

ALTER TYPE "DurableTaskStatus" RENAME TO "DurableTaskStatus_old";
CREATE TYPE "DurableTaskStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'ASYNC_PROCESSING',
  'SUCCEEDED',
  'REJECTED',
  'FAILED',
  'SUPERSEDED'
);

ALTER TABLE "DurableTask"
  ALTER COLUMN status DROP DEFAULT,
  ALTER COLUMN status TYPE "DurableTaskStatus"
    USING status::text::"DurableTaskStatus",
  ALTER COLUMN status SET DEFAULT 'PENDING';

DROP TYPE "DurableTaskStatus_old";

ALTER TABLE "DurableTask"
  ADD CONSTRAINT "DurableTask_supersession_check"
    CHECK (
      (
        status = 'SUPERSEDED'
        AND "supersededByTaskId" IS NOT NULL
        AND "supersededByTaskId" > id
        AND "coalescingKey" IS NOT NULL
      ) OR (
        status <> 'SUPERSEDED'
        AND "supersededByTaskId" IS NULL
      )
    ),
  ADD CONSTRAINT "DurableTask_status_timestamps_check"
    CHECK (
      (
        status = 'PENDING'
        AND "startedAt" IS NULL
        AND "completedAt" IS NULL
      ) OR (
        status IN ('PROCESSING', 'ASYNC_PROCESSING')
        AND "startedAt" IS NOT NULL
        AND "completedAt" IS NULL
      ) OR (
        status IN ('SUCCEEDED', 'REJECTED', 'FAILED')
        AND "startedAt" IS NOT NULL
        AND "completedAt" IS NOT NULL
      ) OR (
        status = 'SUPERSEDED'
        AND "startedAt" IS NULL
        AND "completedAt" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "DurableTask_result_check"
    CHECK ("resultCode" IS NULL OR status IN ('SUCCEEDED', 'REJECTED')),
  ADD CONSTRAINT "DurableTask_error_check"
    CHECK ("lastError" IS NULL OR status = 'FAILED');

CREATE INDEX "DurableTask_pending_id_idx"
  ON "DurableTask" (id)
  WHERE status = 'PENDING';
CREATE INDEX "DurableTask_blocking_scope_id_idx"
  ON "DurableTask" (kind, "scopeKey", id)
  WHERE status IN ('PENDING', 'PROCESSING', 'ASYNC_PROCESSING', 'FAILED');
CREATE UNIQUE INDEX "DurableTask_one_processing_per_scope"
  ON "DurableTask" (kind, "scopeKey")
  WHERE status IN ('PROCESSING', 'ASYNC_PROCESSING');
CREATE INDEX "DurableTask_pending_coalescing_key_idx"
  ON "DurableTask" ("coalescingKey", id)
  WHERE status = 'PENDING' AND "coalescingKey" IS NOT NULL;
