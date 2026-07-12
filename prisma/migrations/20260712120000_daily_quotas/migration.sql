-- Unified daily-quota counters (local SOMS_DOMAIN node + each federated peer domain).
-- `date` is a UTC calendar day → the budget resets automatically at 00:00 UTC (no cron).
-- The atomic increment is an INSERT … ON CONFLICT DO UPDATE … RETURNING count in QuotaService.tick.
-- See docs/federation-quotas.md + src/quota/quota.service.ts.

CREATE TABLE "QuotaDailyUsage" (
    "domain" VARCHAR(63) NOT NULL,
    "date" DATE NOT NULL,
    "category" VARCHAR(15) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuotaDailyUsage_pkey" PRIMARY KEY ("domain", "date", "category")
);

CREATE INDEX "QuotaDailyUsage_date_idx" ON "QuotaDailyUsage"("date");

-- Per-peer daily-quota overrides (NULL = use the global default from loadQuotaConfig).
ALTER TABLE "FederatedPeer" ADD COLUMN "dailyMsgLimit" INTEGER,
    ADD COLUMN "dailyImageLimit" INTEGER,
    ADD COLUMN "dailyLargeFileLimit" INTEGER,
    ADD COLUMN "dailyRequestLimit" INTEGER,
    ADD COLUMN "maxImageBytes" INTEGER,
    ADD COLUMN "maxLargeFileBytes" INTEGER;
