-- Additive preparation: runtime readers remain on the existing feed until cutover.
-- Member facts and the S2S operation enum are deliberately unchanged.
ALTER TABLE public."GroupMeta"
  ADD COLUMN "clientMetaEndId" integer DEFAULT 0 NOT NULL,
  ADD CONSTRAINT "GroupMeta_clientMetaEndId_check" CHECK ("clientMetaEndId" >= 0);

UPDATE public."GroupMeta" SET "metaRecoveryThroughId" = 0
WHERE "metaRecoveryThroughId" IS NULL;
ALTER TABLE public."GroupMeta"
  ALTER COLUMN "metaRecoveryThroughId" SET DEFAULT 0,
  ALTER COLUMN "metaRecoveryThroughId" SET NOT NULL;
ALTER TABLE public."GroupMeta"
  DROP CONSTRAINT "GroupMeta_metaRecovery_check",
  ADD CONSTRAINT "GroupMeta_metaRecovery_check" CHECK (
    "metaRecoveryThroughId" >= 0 AND (
      "metaRecoveryThroughId" = 0 OR (
        "metaProcessedThroughId" < "metaRecoveryThroughId"
        AND "metaRecoveryThroughId" <= "metaTargetId")));

CREATE TABLE public."ClientGroupMetaFeed" (
  "threadId" integer NOT NULL,
  "feedId" integer NOT NULL,
  operation varchar(31) NOT NULL,
  body jsonb NOT NULL,
  "createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "sourceFeedId" integer,
  "originCreatedAt" timestamp(3) with time zone,
  PRIMARY KEY ("threadId", operation),
  CONSTRAINT "ClientGroupMetaFeed_threadId_fkey" FOREIGN KEY ("threadId")
    REFERENCES public."GroupMeta" ("threadId") ON DELETE CASCADE,
  CONSTRAINT "ClientGroupMetaFeed_feedId_check" CHECK ("feedId" > 0),
  CONSTRAINT "ClientGroupMetaFeed_sourceFeedId_check" CHECK ("sourceFeedId" IS NULL OR "sourceFeedId" > 0),
  CONSTRAINT "ClientGroupMetaFeed_operation_check" CHECK (
    operation IN ('GROUP_MEMBER_COUNT', 'GROUP_PROFILE', 'GROUP_ANNOUNCEMENT')),
  CONSTRAINT "ClientGroupMetaFeed_body_check" CHECK (
    jsonb_typeof(body) = 'object' AND body <> '{}'::jsonb),
  CONSTRAINT "ClientGroupMetaFeed_count_check" CHECK (
    operation <> 'GROUP_MEMBER_COUNT' OR COALESCE(
      jsonb_typeof(body -> 'memberCount') = 'number'
      AND (body - 'memberCount') = '{}'::jsonb
      AND (body ->> 'memberCount')::numeric BETWEEN 0 AND 2147483647
      AND trunc((body ->> 'memberCount')::numeric) = (body ->> 'memberCount')::numeric
      AND "sourceFeedId" IS NULL AND "originCreatedAt" IS NULL, false)),
  CONSTRAINT "ClientGroupMetaFeed_time_check" CHECK (
    "createdAt" >= '1970-01-01'::timestamptz AND
    ("originCreatedAt" IS NULL OR "originCreatedAt" >= '1970-01-01'::timestamptz))
);
CREATE UNIQUE INDEX "ClientGroupMetaFeed_thread_feed_key"
  ON public."ClientGroupMetaFeed" ("threadId", "feedId");
