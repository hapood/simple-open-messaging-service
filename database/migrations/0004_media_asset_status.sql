DELETE FROM "ForwardBundleAsset";
DELETE FROM "MediaMessage";
DELETE FROM "PendingMedia" WHERE digest IS NOT NULL;
DELETE FROM "MediaAsset";

CREATE TYPE "MediaAssetStatus" AS ENUM ('PENDING', 'READY', 'DELETING', 'DELETED');

ALTER TABLE "MediaAsset"
  ADD COLUMN "status" "MediaAssetStatus" NOT NULL DEFAULT 'READY',
  ADD COLUMN "stateChangedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DROP INDEX "MediaAsset_refs_idx";
ALTER TABLE "MediaAsset" DROP COLUMN "refs";

CREATE INDEX "MediaAsset_status_createdAt_idx"
  ON "MediaAsset" USING btree ("status", "stateChangedAt");
