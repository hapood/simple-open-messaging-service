ALTER TABLE "FederationThreadHistoryGap"
  ADD COLUMN "messageSeqOffset" integer DEFAULT 0 NOT NULL;

ALTER TABLE "FederationThreadHistoryGap"
  DROP CONSTRAINT "FederationThreadHistoryGap_interval_check";

ALTER TABLE "FederationThreadHistoryGap"
  ADD CONSTRAINT "FederationThreadHistoryGap_interval_check"
  CHECK (
    "startSeq" > 0
    AND "endSeq" >= "startSeq"
    AND "messageSeqOffset" >= 0
  );
