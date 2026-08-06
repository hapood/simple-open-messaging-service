-- Extend PendingMedia into the download-inbox staging table (federation design doc §12.2).
-- Existing rows are outbound single-file staged sends: direction defaults to OUTBOUND, fileCnt to 1,
-- batchId to a fresh UUID (one per legacy row — effectively 1:1). The inbound localization path
-- (Phase 3c) sets direction=INBOUND with a shared batchId and fileCnt=N, tracking per-file state in
-- FileSyncProgress. originDomain/expectedFederationVersion are inbound-only.

ALTER TABLE "PendingMedia"
  ADD COLUMN "direction" "FileSyncDirection" NOT NULL DEFAULT 'OUTBOUND',
  ADD COLUMN "batchId" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN "fileCnt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "anyFailed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "originDomain" VARCHAR(63),
  ADD COLUMN "expectedFederationVersion" INTEGER;

CREATE INDEX "PendingMedia_batchId_idx" ON "PendingMedia" ("batchId");
