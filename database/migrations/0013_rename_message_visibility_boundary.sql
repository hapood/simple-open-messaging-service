ALTER TABLE "ThreadParticipant"
  RENAME COLUMN "messageVisibleBeforeSeq" TO "messageVisibleThroughSeq";

ALTER TABLE "ThreadParticipant"
  DROP CONSTRAINT "ThreadParticipant_messageVisibleBeforeSeq_check",
  ADD CONSTRAINT "ThreadParticipant_messageVisibleThroughSeq_check"
    CHECK ("messageVisibleThroughSeq" IS NULL OR "messageVisibleThroughSeq" >= 0);

UPDATE "ThreadParticipant"
SET "messageVisibleThroughSeq" = "messageVisibleThroughSeq" - 1
WHERE "messageVisibleThroughSeq" IS NOT NULL;
