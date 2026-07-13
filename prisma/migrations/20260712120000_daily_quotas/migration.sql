-- Unified daily-quota counters: one row per (node, UTC day, category). A node is a domain — the
-- local SOMS_DOMAIN (all local users share one bucket) or a federated peer domain. `date` is a UTC
-- calendar day, so the budget resets at 00:00 UTC with no cron. QuotaService.tick increments via
-- INSERT … ON CONFLICT DO UPDATE … RETURNING count (exact, not ±1).

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
