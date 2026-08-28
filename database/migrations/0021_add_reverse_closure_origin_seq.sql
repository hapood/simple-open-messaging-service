ALTER TABLE "FederationThreadSyncState"
  ADD COLUMN "reverseClosureOriginSeq" integer;

ALTER TABLE "FederationThreadSyncState"
  ADD CONSTRAINT "FederationThreadSyncState_reverseClosureOriginSeq_check"
  CHECK (
    "reverseClosureOriginSeq" IS NULL
    OR (
      "reverseClosureOriginSeq" > 0
      AND "reverseClosureOriginSeq" < "reverseNextBeforeSeq"
    )
  );
