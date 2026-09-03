ALTER TABLE "MessageThread" ADD COLUMN "clearedSeq" integer;

UPDATE "MessageThread" thread
SET "clearedSeq" = LEAST(thread."curSeq", legacy."clearedSeq")
FROM (
  SELECT "threadId", MAX("clearedSeq") AS "clearedSeq"
  FROM "AccountThreadState"
  WHERE "clearedSeq" IS NOT NULL
  GROUP BY "threadId"
) legacy
WHERE thread.id = legacy."threadId";

ALTER TABLE "MessageThread"
  ADD CONSTRAINT "MessageThread_clearedSeq_check"
  CHECK (
    "clearedSeq" IS NULL
    OR ("clearedSeq" >= 0 AND "clearedSeq" <= "curSeq")
  );

ALTER TABLE "AccountThreadState"
  DROP CONSTRAINT "AccountThreadState_cleared_seq_check",
  DROP COLUMN "clearedSeq";
