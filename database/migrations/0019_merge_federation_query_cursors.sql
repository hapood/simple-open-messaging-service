ALTER TABLE "FederationThreadSyncState"
  ADD COLUMN "messageProcessedThroughSeq" integer NOT NULL DEFAULT 0,
  ADD COLUMN "deletionProcessedThroughSeq" integer NOT NULL DEFAULT 0;

ALTER TABLE "FederationThreadSyncState"
  DROP CONSTRAINT "FederationThreadSyncState_messageSeqs_check",
  ADD CONSTRAINT "FederationThreadSyncState_messageSeqs_check"
    CHECK (
      "messageTargetSeq" >= 0
      AND "deletionTargetSeq" >= 0
      AND "messageProcessedThroughSeq" >= 0
      AND "deletionProcessedThroughSeq" >= 0
      AND "messageProcessedThroughSeq" <= "messageTargetSeq"
      AND "deletionProcessedThroughSeq" <= "deletionTargetSeq"
      AND "reverseFetchThroughSeq" >= 0
      AND "reverseFetchThroughSeq" <= "messageTargetSeq"
    );

DROP TABLE "FederationMessageQueryCursor";
DROP TABLE "FederationTombstoneQueryCursor";
