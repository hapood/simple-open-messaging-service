-- Replace legacy domain-scoped federation quota with identity-namespace-scoped quota.
-- Historical federation quota counters, allowances and domain overrides are intentionally discarded.
DROP TABLE public."QuotaDailyUsage";
DROP TABLE public."QuotaFileByteUsage";
DROP TABLE public."QuotaDailyAllowance";

ALTER TABLE public."FederatedPeer"
  DROP COLUMN "dailyMsgLimit",
  DROP COLUMN "dailyRequestLimit",
  DROP COLUMN "dailyFileLimit",
  DROP COLUMN "dailyFileBytesLimit";

ALTER TABLE public."IdentityNamespace"
  ADD COLUMN "dailyMsgLimit" integer,
  ADD COLUMN "dailyRequestLimit" integer,
  ADD COLUMN "dailyFileLimit" integer,
  ADD COLUMN "dailyFileBytesLimit" bigint;

CREATE TABLE public."QuotaDailyUsage" (
  "namespaceId" integer NOT NULL REFERENCES public."IdentityNamespace"(id) ON DELETE CASCADE,
  date date NOT NULL,
  category varchar(15) NOT NULL,
  count integer NOT NULL DEFAULT 0,
  CONSTRAINT "QuotaDailyUsage_pkey" PRIMARY KEY ("namespaceId", date, category)
);
CREATE INDEX "QuotaDailyUsage_date_idx" ON public."QuotaDailyUsage" USING btree (date);

CREATE TABLE public."QuotaFileByteUsage" (
  "namespaceId" integer NOT NULL REFERENCES public."IdentityNamespace"(id) ON DELETE CASCADE,
  date date NOT NULL,
  bytes bigint NOT NULL DEFAULT 0,
  CONSTRAINT "QuotaFileByteUsage_pkey" PRIMARY KEY ("namespaceId", date)
);
CREATE INDEX "QuotaFileByteUsage_date_idx" ON public."QuotaFileByteUsage" USING btree (date);

CREATE TABLE public."QuotaDailyAllowance" (
  "namespaceId" integer NOT NULL REFERENCES public."IdentityNamespace"(id) ON DELETE CASCADE,
  date date NOT NULL,
  "extraMsg" integer NOT NULL DEFAULT 0,
  "extraFile" integer NOT NULL DEFAULT 0,
  "extraFileBytes" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "QuotaDailyAllowance_pkey" PRIMARY KEY ("namespaceId", date)
);
