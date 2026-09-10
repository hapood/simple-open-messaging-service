-- Merge existing reports by message. Any outstanding report keeps the message
-- active unless it has already been removed. Resolved reports remain dismissals.
ALTER TABLE "MessageReport" ADD COLUMN "isDeleted" boolean NOT NULL DEFAULT false;
WITH merged AS (
  SELECT r."threadId", r."messageSeq", min(r.id) AS keeper,
         min(r."createdAt") AS created_at, max(r."updatedAt") AS updated_at,
         bool_and(r.status <> 'PENDING') OR bool_or(m."isDeleted") AS is_deleted
  FROM "MessageReport" r
  JOIN "Message" m ON m.id = r."messageId"
  GROUP BY r."threadId", r."messageSeq"
)
UPDATE "MessageReport" r
SET "isDeleted" = merged.is_deleted, "createdAt" = merged.created_at,
    "updatedAt" = merged.updated_at
FROM merged WHERE r.id = merged.keeper;
DELETE FROM "MessageReport" r USING "MessageReport" keeper
WHERE r."threadId" = keeper."threadId" AND r."messageSeq" = keeper."messageSeq"
  AND r.id > keeper.id;
ALTER TABLE "MessageReport"
  DROP COLUMN id,
  DROP COLUMN "messageId",
  DROP COLUMN "reporterId",
  DROP COLUMN status,
  DROP COLUMN "reviewedByAdminId",
  DROP COLUMN "reviewedAt",
  DROP CONSTRAINT "MessageReport_threadId_fkey";
ALTER TABLE "MessageReport" RENAME COLUMN "messageSeq" TO seq;
ALTER TABLE "MessageReport"
  ADD CONSTRAINT "MessageReport_pkey" PRIMARY KEY ("threadId", seq),
  ADD CONSTRAINT "MessageReport_threadId_seq_fkey"
    FOREIGN KEY ("threadId", seq) REFERENCES "Message" ("threadId", seq)
    ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE INDEX "MessageReport_isDeleted_updatedAt_idx"
  ON "MessageReport" ("isDeleted", "updatedAt" DESC);
DROP TYPE "MessageReportStatus";
