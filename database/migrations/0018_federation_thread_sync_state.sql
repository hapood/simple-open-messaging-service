CREATE TABLE "FederationThreadSyncState" (
  "threadId" integer PRIMARY KEY NOT NULL,
  "messageTargetSeq" integer NOT NULL DEFAULT 0,
  "deletionTargetSeq" integer NOT NULL DEFAULT 0,
  "reverseFetchThroughSeq" integer NOT NULL DEFAULT 0,
  "historyBoundaryReached" boolean NOT NULL DEFAULT false,
  "updatedAt" timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationThreadSyncState_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"(id) ON DELETE CASCADE,
  CONSTRAINT "FederationThreadSyncState_messageSeqs_check"
    CHECK (
      "messageTargetSeq" >= 0
      AND "deletionTargetSeq" >= 0
      AND "reverseFetchThroughSeq" >= 0
      AND "reverseFetchThroughSeq" <= "messageTargetSeq"
    )
);
