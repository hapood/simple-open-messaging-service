-- Simplify MediaAsset to only verified blobs (federation design doc §12.2): drop the lifecycle status
-- enum and stateChangedAt; add isDeleted. In-flight localization state now lives in FileSyncProgress.
--
-- Backfill: only READY was a verified live blob; every other status is treated as reaped (isDeleted).
-- PENDING/FAILED/DELETING/DELETED rows are not verified-live content and are reclaimed by GC next run.

ALTER TABLE "MediaAsset" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;
UPDATE "MediaAsset" SET "isDeleted" = (status <> 'READY');

DROP INDEX "MediaAsset_status_createdAt_idx";
ALTER TABLE "MediaAsset" DROP COLUMN "status";
ALTER TABLE "MediaAsset" DROP COLUMN "stateChangedAt";

CREATE INDEX "MediaAsset_isDeleted_idx" ON "MediaAsset" ("isDeleted");

DROP TYPE "MediaAssetStatus";
