-- Stable logical file identity for single-file and GALLERY uploads. A digest identifies physical
-- bytes and may repeat; partId + position identify each user-selected item in the staged message.
ALTER TABLE "UploadSession"
  ADD COLUMN "partId" uuid,
  ADD COLUMN "position" integer,
  ADD COLUMN "partIntent" "ContentType";

-- The project has not shipped yet, but keep the migration safe for local development databases that
-- already contain single-file sessions.
UPDATE "UploadSession"
SET "partId" = "uploadId", "position" = 0, "partIntent" = "contentType"
WHERE "partId" IS NULL;

ALTER TABLE "UploadSession"
  ALTER COLUMN "partId" SET NOT NULL,
  ALTER COLUMN "position" SET NOT NULL,
  ALTER COLUMN "partIntent" SET NOT NULL,
  ADD CONSTRAINT "UploadSession_position_check" CHECK ("position" BETWEEN 0 AND 9),
  ADD CONSTRAINT "UploadSession_partIntent_check" CHECK ("partIntent" <> 'GALLERY');

DROP INDEX "UploadSession_clientMessageId_key";
CREATE UNIQUE INDEX "UploadSession_clientMessageId_partId_key"
  ON "UploadSession"("clientMessageId", "partId");
CREATE UNIQUE INDEX "UploadSession_clientMessageId_position_key"
  ON "UploadSession"("clientMessageId", "position");

ALTER TABLE "FileSyncProgress"
  ADD COLUMN "partId" uuid,
  ADD COLUMN "position" integer;

-- Existing outbound rows predate logical parts and are all single-file staging rows.
UPDATE "FileSyncProgress"
SET "partId" = gen_random_uuid(), "position" = 0
WHERE "direction" = 'OUTBOUND' AND "partId" IS NULL;

ALTER TABLE "FileSyncProgress"
  ADD CONSTRAINT "FileSyncProgress_position_check"
    CHECK ("position" IS NULL OR "position" BETWEEN 0 AND 9),
  ADD CONSTRAINT "FileSyncProgress_outbound_part_check"
    CHECK ("direction" <> 'OUTBOUND' OR ("partId" IS NOT NULL AND "position" IS NOT NULL));

DROP INDEX "FileSyncProgress_batchId_digest_key";
CREATE UNIQUE INDEX "FileSyncProgress_batchId_partId_key"
  ON "FileSyncProgress"("batchId", "partId") WHERE "partId" IS NOT NULL;
CREATE UNIQUE INDEX "FileSyncProgress_batchId_position_key"
  ON "FileSyncProgress"("batchId", "position") WHERE "position" IS NOT NULL;
CREATE INDEX "FileSyncProgress_batchId_digest_idx"
  ON "FileSyncProgress"("batchId", "digest");
