ALTER TABLE "PendingMedia"
  ADD COLUMN "useOriginSeqAsMessageSeq" boolean NOT NULL DEFAULT false;

ALTER TABLE "PendingMedia"
  ADD CONSTRAINT "PendingMedia_origin_seq_policy_check"
  CHECK (
    "useOriginSeqAsMessageSeq" = false
    OR (
      direction = 'INBOUND'
      AND "originSeq" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX "PendingMedia_threadId_preserved_originSeq_key"
  ON "PendingMedia" ("threadId", "originSeq")
  WHERE "useOriginSeqAsMessageSeq" = true;
