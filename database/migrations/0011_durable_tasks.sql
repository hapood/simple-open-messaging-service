DROP TABLE "DomainCommand";
DROP TYPE "DomainCommandStatus";
DROP TYPE "DomainCommandAggregateType";

CREATE TYPE "DurableTaskKind" AS ENUM ('MUTATION', 'PROJECTION');
CREATE TYPE "DurableTaskScopeType" AS ENUM ('USER_PAIR', 'GROUP');
CREATE TYPE "DurableTaskStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'REJECTED',
  'FAILED',
  'SUPERSEDED'
);

CREATE TABLE "DurableTask" (
  id bigserial PRIMARY KEY NOT NULL,
  "parentTaskId" bigint,
  kind "DurableTaskKind" NOT NULL,
  "scopeType" "DurableTaskScopeType" NOT NULL,
  "scopeKey" varchar(512) NOT NULL,
  "taskType" varchar(64) NOT NULL,
  "actorUserId" integer,
  payload jsonb NOT NULL,
  checkpoint jsonb DEFAULT '{}'::jsonb NOT NULL,
  "coalescingKey" varchar(512),
  "supersededByTaskId" bigint,
  status "DurableTaskStatus" DEFAULT 'PENDING' NOT NULL,
  "resultCode" integer,
  "lastError" varchar(1000),
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "startedAt" timestamp(3) with time zone,
  "completedAt" timestamp(3) with time zone,
  CONSTRAINT "DurableTask_parentTaskId_fkey"
    FOREIGN KEY ("parentTaskId") REFERENCES "DurableTask"(id)
    ON DELETE RESTRICT,
  CONSTRAINT "DurableTask_supersededByTaskId_fkey"
    FOREIGN KEY ("supersededByTaskId") REFERENCES "DurableTask"(id)
    ON DELETE RESTRICT,
  CONSTRAINT "DurableTask_parent_order_check"
    CHECK ("parentTaskId" IS NULL OR "parentTaskId" < id),
  CONSTRAINT "DurableTask_scope_key_check"
    CHECK (length("scopeKey") > 0),
  CONSTRAINT "DurableTask_task_type_check"
    CHECK ("taskType" ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT "DurableTask_actor_user_id_check"
    CHECK ("actorUserId" IS NULL OR "actorUserId" > 0),
  CONSTRAINT "DurableTask_payload_check"
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT "DurableTask_checkpoint_check"
    CHECK (jsonb_typeof(checkpoint) = 'object'),
  CONSTRAINT "DurableTask_coalescing_key_check"
    CHECK ("coalescingKey" IS NULL OR length("coalescingKey") > 0),
  CONSTRAINT "DurableTask_supersession_check"
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
  CONSTRAINT "DurableTask_status_timestamps_check"
    CHECK (
      (
        status = 'PENDING'
        AND "startedAt" IS NULL
        AND "completedAt" IS NULL
      ) OR (
        status = 'PROCESSING'
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
  CONSTRAINT "DurableTask_timestamp_order_check"
    CHECK (
      ("startedAt" IS NULL OR "startedAt" >= "createdAt")
      AND ("completedAt" IS NULL OR "completedAt" >= "createdAt")
      AND (
        "completedAt" IS NULL
        OR "startedAt" IS NULL
        OR "completedAt" >= "startedAt"
      )
    ),
  CONSTRAINT "DurableTask_result_check"
    CHECK ("resultCode" IS NULL OR status IN ('SUCCEEDED', 'REJECTED')),
  CONSTRAINT "DurableTask_error_check"
    CHECK ("lastError" IS NULL OR status = 'FAILED')
);

CREATE INDEX "DurableTask_pending_id_idx"
  ON "DurableTask" (id)
  WHERE status = 'PENDING';
CREATE INDEX "DurableTask_blocking_scope_id_idx"
  ON "DurableTask" (kind, "scopeKey", id)
  WHERE status IN ('PENDING', 'PROCESSING', 'FAILED');
CREATE UNIQUE INDEX "DurableTask_one_processing_per_scope"
  ON "DurableTask" (kind, "scopeKey")
  WHERE status = 'PROCESSING';
CREATE INDEX "DurableTask_parentTaskId_idx"
  ON "DurableTask" ("parentTaskId");
CREATE INDEX "DurableTask_pending_coalescing_key_idx"
  ON "DurableTask" ("coalescingKey", id)
  WHERE status = 'PENDING' AND "coalescingKey" IS NOT NULL;
CREATE INDEX "DurableTask_supersededByTaskId_idx"
  ON "DurableTask" ("supersededByTaskId");
