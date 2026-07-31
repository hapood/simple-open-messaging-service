ALTER TYPE "ContentType" ADD VALUE 'FORWARD';

CREATE TABLE "ForwardBundle" (
    "id" VARCHAR(26) NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "depth" INTEGER NOT NULL,
    "manifest" JSONB NOT NULL,
    "manifestDigest" VARCHAR(64) NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "assetCount" INTEGER NOT NULL,
    "totalBytes" BIGINT NOT NULL,
    "sourceDomain" VARCHAR(63),
    "sourceBundleId" VARCHAR(26),
    "createdBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForwardBundle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ForwardMessage" (
    "messageId" BIGINT NOT NULL,
    "bundleId" VARCHAR(26) NOT NULL,
    CONSTRAINT "ForwardMessage_pkey" PRIMARY KEY ("messageId")
);

CREATE TABLE "ForwardBundleDependency" (
    "parentBundleId" VARCHAR(26) NOT NULL,
    "childBundleId" VARCHAR(26) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    CONSTRAINT "ForwardBundleDependency_pkey" PRIMARY KEY ("parentBundleId","childBundleId")
);

CREATE TABLE "ForwardBundleAsset" (
    "bundleId" VARCHAR(26) NOT NULL,
    "digest" VARCHAR(64) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "extension" VARCHAR(16) NOT NULL,
    "filename" TEXT,
    "mime" TEXT,
    "bytes" BIGINT NOT NULL,
    CONSTRAINT "ForwardBundleAsset_pkey" PRIMARY KEY ("bundleId","ordinal")
);

CREATE UNIQUE INDEX "ForwardBundle_sourceDomain_sourceBundleId_key" ON "ForwardBundle"("sourceDomain","sourceBundleId");
CREATE INDEX "ForwardBundle_createdBy_idx" ON "ForwardBundle"("createdBy");
CREATE INDEX "ForwardMessage_bundleId_idx" ON "ForwardMessage"("bundleId");
CREATE UNIQUE INDEX "ForwardBundleDependency_parentBundleId_ordinal_key" ON "ForwardBundleDependency"("parentBundleId","ordinal");
CREATE INDEX "ForwardBundleDependency_childBundleId_idx" ON "ForwardBundleDependency"("childBundleId");
CREATE UNIQUE INDEX "ForwardBundleAsset_bundleId_digest_kind_key" ON "ForwardBundleAsset"("bundleId","digest","kind");
CREATE INDEX "ForwardBundleAsset_digest_idx" ON "ForwardBundleAsset"("digest");

ALTER TABLE "ForwardMessage" ADD CONSTRAINT "ForwardMessage_messageId_fkey"
FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ForwardMessage" ADD CONSTRAINT "ForwardMessage_bundleId_fkey"
FOREIGN KEY ("bundleId") REFERENCES "ForwardBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ForwardBundleDependency" ADD CONSTRAINT "ForwardBundleDependency_parentBundleId_fkey"
FOREIGN KEY ("parentBundleId") REFERENCES "ForwardBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ForwardBundleDependency" ADD CONSTRAINT "ForwardBundleDependency_childBundleId_fkey"
FOREIGN KEY ("childBundleId") REFERENCES "ForwardBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ForwardBundleAsset" ADD CONSTRAINT "ForwardBundleAsset_bundleId_fkey"
FOREIGN KEY ("bundleId") REFERENCES "ForwardBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
