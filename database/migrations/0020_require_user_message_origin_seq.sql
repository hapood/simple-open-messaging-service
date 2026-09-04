UPDATE "Message"
SET "originSeq" = "seq"
WHERE "contentType" <> 'SYSTEM'
  AND "originSeq" IS NULL;

ALTER TABLE "Message"
  DROP CONSTRAINT "Message_origin_seq_check",
  ADD CONSTRAINT "Message_origin_seq_check"
    CHECK ("contentType" = 'SYSTEM' OR "originSeq" > 0);
