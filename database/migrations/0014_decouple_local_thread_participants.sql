-- Local conversation state is independent from the source-scoped roster projection.
-- This release intentionally does not preserve rows from the shared-primary-key model.
DROP TABLE "ThreadParticipant";
ALTER TABLE "ThreadMember" DROP COLUMN "messageVisibleBeforeSeq";

CREATE TABLE "ThreadParticipant" (
  id serial PRIMARY KEY,
  "accountId" integer NOT NULL,
  "threadId" integer NOT NULL,
  role "GroupRole",
  "lastReadSeq" integer,
  "readRevision" integer DEFAULT 0 NOT NULL,
  muted boolean DEFAULT false NOT NULL,
  blocked boolean DEFAULT false NOT NULL,
  pinned boolean DEFAULT false NOT NULL,
  "pinnedAt" timestamp(3) with time zone,
  "clearedSeq" integer,
  "messageVisibleBeforeSeq" bigint,
  alias varchar(64),
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "ThreadParticipant_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"(id) ON DELETE RESTRICT,
  CONSTRAINT "ThreadParticipant_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"(id) ON DELETE RESTRICT,
  CONSTRAINT "ThreadParticipant_cleared_seq_check"
    CHECK ("clearedSeq" IS NULL OR "clearedSeq" >= 0),
  CONSTRAINT "ThreadParticipant_messageVisibleBeforeSeq_check"
    CHECK ("messageVisibleBeforeSeq" IS NULL OR "messageVisibleBeforeSeq" > 1)
);

CREATE UNIQUE INDEX "ThreadParticipant_accountId_threadId_key"
  ON "ThreadParticipant" ("accountId", "threadId");
CREATE INDEX "ThreadParticipant_threadId_idx"
  ON "ThreadParticipant" ("threadId");
CREATE INDEX "ThreadParticipant_accountId_pinned_idx"
  ON "ThreadParticipant" ("accountId", pinned);
CREATE INDEX "ThreadParticipant_accountId_readRevision_idx"
  ON "ThreadParticipant" ("accountId", "readRevision");
