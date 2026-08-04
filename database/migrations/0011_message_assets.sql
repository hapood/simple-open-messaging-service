ALTER TABLE "MediaMessage" RENAME TO "MessageAsset";

ALTER TABLE "MessageAsset" RENAME CONSTRAINT "MediaMessage_messageId_fkey" TO "MessageAsset_messageId_fkey";
ALTER TABLE "MessageAsset" RENAME CONSTRAINT "MediaMessage_threadId_fkey" TO "MessageAsset_threadId_fkey";
ALTER TABLE "MessageAsset" RENAME CONSTRAINT "MediaMessage_pkey" TO "MessageAsset_old_pkey";
ALTER INDEX "MediaMessage_digest_idx" RENAME TO "MessageAsset_digest_idx";
ALTER INDEX "MediaMessage_threadId_idx" RENAME TO "MessageAsset_threadId_idx";

ALTER TABLE "MessageAsset" DROP CONSTRAINT "MessageAsset_old_pkey";
ALTER TABLE "MessageAsset" ADD CONSTRAINT "MessageAsset_pkey" PRIMARY KEY ("messageId", "digest");
ALTER TABLE "MessageAsset" ADD COLUMN "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
