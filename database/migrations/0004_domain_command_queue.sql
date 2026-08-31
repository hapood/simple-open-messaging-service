CREATE TYPE "DomainCommandAggregateType" AS ENUM ('USER_PAIR', 'GROUP');
CREATE TYPE "DomainCommandStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'REJECTED',
  'FAILED'
);

CREATE TABLE "DomainCommand" (
  id bigserial PRIMARY KEY,
  "parentCommandId" bigint,
  "aggregateType" "DomainCommandAggregateType" NOT NULL,
  "aggregateKey" varchar(512) NOT NULL,
  "commandType" varchar(64) NOT NULL,
  "actorUserId" integer,
  payload jsonb NOT NULL,
  "progressCursor" integer,
  status "DomainCommandStatus" DEFAULT 'PENDING' NOT NULL,
  "resultCode" integer,
  "lastError" varchar(1000),
  "createdAt" timestamptz(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "startedAt" timestamptz(3),
  "completedAt" timestamptz(3),
  CONSTRAINT "DomainCommand_parentCommandId_fkey"
    FOREIGN KEY ("parentCommandId") REFERENCES "DomainCommand"(id)
    ON DELETE RESTRICT,
  CONSTRAINT "DomainCommand_parent_order_check"
    CHECK ("parentCommandId" IS NULL OR "parentCommandId" < id),
  CONSTRAINT "DomainCommand_aggregate_key_check"
    CHECK (length("aggregateKey") > 0),
  CONSTRAINT "DomainCommand_command_type_check"
    CHECK ("commandType" ~ '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT "DomainCommand_actor_user_id_check"
    CHECK ("actorUserId" IS NULL OR "actorUserId" > 0),
  CONSTRAINT "DomainCommand_payload_check"
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT "DomainCommand_progress_cursor_check"
    CHECK ("progressCursor" IS NULL OR "progressCursor" >= 0),
  CONSTRAINT "DomainCommand_status_timestamps_check"
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
      )
    ),
  CONSTRAINT "DomainCommand_timestamp_order_check"
    CHECK (
      ("startedAt" IS NULL OR "startedAt" >= "createdAt")
      AND ("completedAt" IS NULL OR "completedAt" >= "startedAt")
    ),
  CONSTRAINT "DomainCommand_result_check"
    CHECK ("resultCode" IS NULL OR status IN ('SUCCEEDED', 'REJECTED')),
  CONSTRAINT "DomainCommand_error_check"
    CHECK ("lastError" IS NULL OR status = 'FAILED')
);

CREATE INDEX "DomainCommand_pending_id_idx"
  ON "DomainCommand" (id)
  WHERE status = 'PENDING';
CREATE INDEX "DomainCommand_blocking_aggregate_id_idx"
  ON "DomainCommand" ("aggregateKey", id)
  WHERE status IN ('PENDING', 'PROCESSING', 'FAILED');
CREATE UNIQUE INDEX "DomainCommand_one_processing_per_aggregate_key"
  ON "DomainCommand" ("aggregateKey")
  WHERE status = 'PROCESSING';
CREATE INDEX "DomainCommand_parentCommandId_idx"
  ON "DomainCommand" ("parentCommandId");
