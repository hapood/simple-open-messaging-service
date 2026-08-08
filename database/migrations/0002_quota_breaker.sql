-- Quota circuit breaker: two independent 3-dimension breakers (per-peer federation, per-user local).
-- Dimensions: msg cnt (reuses QuotaDailyUsage category 'messages'), file cnt (new category 'files' on the
-- existing count tables — no DDL needed, category is varchar), file total size (new bigint accumulators below,
-- because byte totals exceed INTEGER range). In-memory tripped flags are derived from these persisted counters.
-- See docs plan + src/quota/{quota,user-quota}.service.ts.

-- Daily file-total-size accumulator for a federated peer (bigint). One row per (domain, UTC day).
CREATE TABLE "QuotaFileByteUsage" (
    "domain" VARCHAR(63) NOT NULL,
    "date" DATE NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "QuotaFileByteUsage_pkey" PRIMARY KEY ("domain", "date")
);

CREATE INDEX "QuotaFileByteUsage_date_idx" ON "QuotaFileByteUsage" ("date");

-- Daily file-total-size accumulator for a local user (bigint). One row per (userId, UTC day).
CREATE TABLE "UserQuotaFileByteUsage" (
    "userId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "UserQuotaFileByteUsage_pkey" PRIMARY KEY ("userId", "date")
);

CREATE INDEX "UserQuotaFileByteUsage_date_idx" ON "UserQuotaFileByteUsage" ("date");

ALTER TABLE "UserQuotaFileByteUsage"
    ADD CONSTRAINT "UserQuotaFileByteUsage_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;

-- Tick-once guard: once a file's file-cnt/file-bytes quota is charged, admin retry or crash-resume must not
-- re-charge it. Default false; set true after the first successful claim.
ALTER TABLE "FileSyncProgress"
    ADD COLUMN "quotaCounted" BOOLEAN NOT NULL DEFAULT false;

-- Per-entity breaker override columns (NULL = use the global default).
ALTER TABLE "FederatedPeer"
    ADD COLUMN "dailyFileLimit" INTEGER,
    ADD COLUMN "dailyFileBytesLimit" BIGINT;

ALTER TABLE "UserQuotaPolicy"
    ADD COLUMN "dailyFileLimit" INTEGER,
    ADD COLUMN "dailyFileBytesLimit" BIGINT;

-- The old per-category file limits (images/largeFiles daily counts) + per-item byte caps (maxImageBytes/
-- maxLargeFileBytes) are replaced by the unified file-cnt + file-total-size breaker dimensions. Drop the legacy
-- columns from both override tables. msg + request limits remain.
ALTER TABLE "FederatedPeer"
    DROP COLUMN "dailyImageLimit",
    DROP COLUMN "dailyLargeFileLimit",
    DROP COLUMN "maxImageBytes",
    DROP COLUMN "maxLargeFileBytes";

ALTER TABLE "UserQuotaPolicy"
    DROP COLUMN "dailyImageLimit",
    DROP COLUMN "dailyLargeFileLimit",
    DROP COLUMN "maxImageBytes",
    DROP COLUMN "maxLargeFileBytes";

-- Admin "continue / add quota": a per-(entity, UTC-day) ADDITIVE allowance on top of the base limit. The
-- effective breaker limit for today = base (override ?? default) + these extras. Persisted so a restart does
-- not lose an admin-granted bonus; auto-resets via the date key. See QuotaService.addQuota.
CREATE TABLE "QuotaDailyAllowance" (
    "domain" VARCHAR(63) NOT NULL,
    "date" DATE NOT NULL,
    "extraMsg" INTEGER NOT NULL DEFAULT 0,
    "extraFile" INTEGER NOT NULL DEFAULT 0,
    "extraFileBytes" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "QuotaDailyAllowance_pkey" PRIMARY KEY ("domain", "date")
);

CREATE TABLE "UserQuotaDailyAllowance" (
    "userId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "extraMsg" INTEGER NOT NULL DEFAULT 0,
    "extraFile" INTEGER NOT NULL DEFAULT 0,
    "extraFileBytes" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "UserQuotaDailyAllowance_pkey" PRIMARY KEY ("userId", "date")
);

ALTER TABLE "UserQuotaDailyAllowance"
    ADD CONSTRAINT "UserQuotaDailyAllowance_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;

