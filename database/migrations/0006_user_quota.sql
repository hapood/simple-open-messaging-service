CREATE TABLE "UserQuotaPolicy" (
  "userId" integer PRIMARY KEY NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "dailyMsgLimit" integer,
  "dailyImageLimit" integer,
  "dailyLargeFileLimit" integer,
  "dailyRequestLimit" integer,
  "maxImageBytes" integer,
  "maxLargeFileBytes" integer,
  "updatedAt" timestamp(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "UserQuotaPolicy_nonnegative_check" CHECK (
    ("dailyMsgLimit" IS NULL OR "dailyMsgLimit" >= 0) AND
    ("dailyImageLimit" IS NULL OR "dailyImageLimit" >= 0) AND
    ("dailyLargeFileLimit" IS NULL OR "dailyLargeFileLimit" >= 0) AND
    ("dailyRequestLimit" IS NULL OR "dailyRequestLimit" >= 0) AND
    ("maxImageBytes" IS NULL OR "maxImageBytes" >= 0) AND
    ("maxLargeFileBytes" IS NULL OR "maxLargeFileBytes" >= 0)
  )
);

CREATE TABLE "UserQuotaDailyUsage" (
  "userId" integer NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "date" date NOT NULL,
  "category" varchar(15) NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "UserQuotaDailyUsage_pkey" PRIMARY KEY("userId", "date", "category"),
  CONSTRAINT "UserQuotaDailyUsage_count_check" CHECK ("count" >= 0),
  CONSTRAINT "UserQuotaDailyUsage_category_check" CHECK (
    "category" IN ('messages', 'images', 'largeFiles', 'requests')
  )
);

CREATE INDEX "UserQuotaDailyUsage_date_idx" ON "UserQuotaDailyUsage" USING btree ("date");
