ALTER TABLE "ThreadParticipant" ADD COLUMN "clearedSeq" INTEGER;

UPDATE "ThreadParticipant" AS participant
SET "clearedSeq" = COALESCE(
  (
    SELECT MAX(message.seq)
    FROM "Message" AS message
    WHERE message."threadId" = participant."threadId"
      AND message."createdAt" <= participant."clearedAt"
  ),
  -1
)
WHERE participant."clearedAt" IS NOT NULL;

ALTER TABLE "ThreadParticipant" DROP COLUMN "clearedAt";

ALTER TABLE "ThreadParticipant"
  ADD CONSTRAINT "ThreadParticipant_cleared_seq_check"
  CHECK ("clearedSeq" IS NULL OR "clearedSeq" >= -1);
