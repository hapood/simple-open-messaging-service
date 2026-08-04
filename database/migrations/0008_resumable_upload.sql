CREATE TYPE "UploadSessionStatus" AS ENUM (
  'UPLOADING',
  'COMPLETING',
  'COMPLETED',
  'ABORTED'
);

CREATE TABLE "UploadSession" (
  "id" BIGSERIAL PRIMARY KEY,
  "uploadId" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clientMessageId" VARCHAR(36) NOT NULL,
  "creatorId" INTEGER NOT NULL,
  "contentType" "ContentType" NOT NULL,
  "originalName" VARCHAR(100) NOT NULL,
  "mimeType" VARCHAR(255) NOT NULL,
  "totalBytes" BIGINT NOT NULL,
  "receivedBytes" BIGINT NOT NULL DEFAULT 0,
  "status" "UploadSessionStatus" NOT NULL DEFAULT 'UPLOADING',
  "tmpKey" UUID NOT NULL DEFAULT gen_random_uuid(),
  "digest" VARCHAR(64),
  "result" JSONB,
  "errorReason" VARCHAR(255),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "abortedAt" TIMESTAMP(3),
  CONSTRAINT "UploadSession_creatorId_fkey" FOREIGN KEY ("creatorId")
    REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "UploadSession_totalBytes_check" CHECK ("totalBytes" > 0),
  CONSTRAINT "UploadSession_receivedBytes_check"
    CHECK ("receivedBytes" >= 0 AND "receivedBytes" <= "totalBytes")
);

CREATE UNIQUE INDEX "UploadSession_uploadId_key" ON "UploadSession"("uploadId");
CREATE UNIQUE INDEX "UploadSession_clientMessageId_key" ON "UploadSession"("clientMessageId");
CREATE INDEX "UploadSession_creatorId_status_idx" ON "UploadSession"("creatorId", "status");
CREATE INDEX "UploadSession_status_updatedAt_idx" ON "UploadSession"("status", "updatedAt");
CREATE INDEX "UploadSession_digest_idx" ON "UploadSession"("digest") WHERE "digest" IS NOT NULL;
