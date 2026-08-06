-- Per-file localization task shared by outbound upload and inbound download (federation design doc §12).
-- Holds the in-flight state (PENDING/DOWNLOADING/SUCCEEDED/FAILED) that previously lived on MediaAsset;
-- MediaAsset will be simplified to only verified blobs in a later migration.

CREATE TYPE "FileSyncDirection" AS ENUM ('OUTBOUND', 'INBOUND');
CREATE TYPE "FileSyncStatus" AS ENUM ('PENDING', 'DOWNLOADING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "FileSyncKind" AS ENUM ('FILE', 'IMAGE', 'VIDEO', 'AUDIO', 'BUNDLE');

CREATE TABLE "FileSyncProgress" (
  "id" BIGSERIAL PRIMARY KEY,
  "batchId" UUID NOT NULL,
  "digest" VARCHAR(64) NOT NULL,
  "direction" "FileSyncDirection" NOT NULL,
  "kind" "FileSyncKind" NOT NULL,
  "status" "FileSyncStatus" NOT NULL DEFAULT 'PENDING',
  "bytesTotal" BIGINT NOT NULL DEFAULT 0,
  "bytesReceived" BIGINT NOT NULL DEFAULT 0,
  "originDomain" VARCHAR(63),
  "errorKind" VARCHAR(255),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "FileSyncProgress_batchId_digest_key"
  ON "FileSyncProgress" ("batchId", "digest");

CREATE INDEX "FileSyncProgress_digest_idx"
  ON "FileSyncProgress" ("digest");

CREATE INDEX "FileSyncProgress_status_updatedAt_idx"
  ON "FileSyncProgress" ("status", "updatedAt");
