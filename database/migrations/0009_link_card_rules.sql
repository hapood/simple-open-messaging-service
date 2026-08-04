CREATE TABLE "LinkCardRule" (
  "id" SERIAL PRIMARY KEY,
  "matchUrl" VARCHAR(2048) NOT NULL,
  "hostname" VARCHAR(255) NOT NULL,
  "displayName" VARCHAR(100) NOT NULL,
  "includeSubdomains" BOOLEAN NOT NULL DEFAULT TRUE,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "LinkCardRule_hostname_key" ON "LinkCardRule"("hostname");
CREATE INDEX "LinkCardRule_enabled_priority_idx" ON "LinkCardRule"("enabled", "priority" DESC);

CREATE TABLE "LinkFavicon" (
  "ruleId" INTEGER PRIMARY KEY,
  "sourceUrl" VARCHAR(2048) NOT NULL,
  "digest" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LinkFavicon_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "LinkCardRule"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LinkFavicon_digest_fkey" FOREIGN KEY ("digest") REFERENCES "MediaAsset"("digest") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "LinkFavicon_digest_idx" ON "LinkFavicon"("digest");
