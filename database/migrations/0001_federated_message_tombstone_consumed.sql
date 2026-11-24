ALTER TABLE public."FederatedMessageTombstone"
  ADD COLUMN consumed boolean DEFAULT false NOT NULL;

UPDATE public."FederatedMessageTombstone" f
SET consumed = true
WHERE EXISTS (
  SELECT 1
  FROM public."Message" m
  WHERE m."threadId" = f."threadId"
    AND m."publisherNamespaceId" = f."publisherNamespaceId"
    AND m."originSeq" = f."messageSeq"
    AND m."isDeleted" = true
);

-- Reverse work is selected from remaining gaps, never from a stored scheduler pointer.
ALTER TABLE public."FederationThreadSyncState"
  DROP CONSTRAINT "FederationThreadSyncState_activeGap_fkey";
ALTER TABLE public."FederationThreadSyncState" DROP COLUMN "activeGapId";

-- Remove obsolete reauthorization deletion-recovery columns.
ALTER TABLE public."FederationThreadSyncState"
  DROP CONSTRAINT "FederationThreadSyncState_deletionRecovery_check";
ALTER TABLE public."FederationThreadSyncState"
  DROP COLUMN "deletionRecoveryThroughSeq",
  DROP COLUMN "deletionRecoveryMaxMessageSeq";

-- Reverse timelines keep messageProcessedThroughSeq at 0; forward member submissions advance it.
UPDATE public."FederationThreadSyncState" s
SET "messageProcessedThroughSeq" = 0
FROM public."MessageThread" t
WHERE t.id = s."threadId"
  AND (t.type = 'P2P' OR t."authorityNamespaceId" > 0);

ALTER TABLE public."FederationThreadSyncState"
  DROP CONSTRAINT "FederationThreadSyncState_messageSeqs_check";
ALTER TABLE public."FederationThreadSyncState"
  ADD CONSTRAINT "FederationThreadSyncState_messageSeqs_check" CHECK (
    "messageTargetSeq" >= 0
    AND "deletionTargetSeq" >= 0
    AND "messageProcessedThroughSeq" >= 0
    AND "deletionProcessedThroughSeq" >= 0
    AND "deletionProcessedThroughSeq" <= "deletionTargetSeq"
    AND "authorizationEpoch" >= 0
  );

-- Database guarantee: local-authority groups consume member submissions forward-only
-- and must never open reverse history gaps.
CREATE FUNCTION public.federation_history_gap_before_write() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public."MessageThread" t
    WHERE t.id = NEW."threadId"
      AND t.type = 'GROUP'
      AND t."authorityNamespaceId" = 0
  ) THEN
    RAISE EXCEPTION 'local-authority group threads cannot open reverse history gaps';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "FederationThreadHistoryGap_direction_check"
  BEFORE INSERT OR UPDATE ON public."FederationThreadHistoryGap"
  FOR EACH ROW EXECUTE FUNCTION public.federation_history_gap_before_write();

-- Separate client tombstone and group-meta heads into ClientStateFeed and track
-- departure truncation bounds on AccountThreadState.
CREATE TYPE public."ClientStateFeedType" AS ENUM (
  'REQUEST_HEAD',
  'THREAD_TOMB_HEAD',
  'THREAD_META_HEAD'
);

ALTER TABLE public."ClientStateFeed"
  ADD COLUMN type public."ClientStateFeedType" DEFAULT 'REQUEST_HEAD'::public."ClientStateFeedType" NOT NULL,
  ADD COLUMN "threadId" integer DEFAULT 0 NOT NULL;

DELETE FROM public."ClientStateFeed" older
USING public."ClientStateFeed" newer
WHERE older."userId" = newer."userId"
  AND older.type = newer.type
  AND older."threadId" = newer."threadId"
  AND older."feedId" < newer."feedId";

ALTER TABLE public."ClientStateFeed"
  DROP CONSTRAINT "ClientStateFeed_pkey",
  ADD CONSTRAINT "ClientStateFeed_pkey" PRIMARY KEY ("userId", type, "threadId"),
  ADD CONSTRAINT "ClientStateFeed_type_thread_check" CHECK (
    (type = 'REQUEST_HEAD'::public."ClientStateFeedType" AND "threadId" = 0)
    OR (type IN ('THREAD_TOMB_HEAD'::public."ClientStateFeedType", 'THREAD_META_HEAD'::public."ClientStateFeedType") AND "threadId" > 0)
  );

CREATE UNIQUE INDEX "ClientStateFeed_userId_feedId_key"
  ON public."ClientStateFeed" USING btree ("userId", "feedId");

ALTER TABLE public."AccountThreadState"
  ADD COLUMN "previewDeletedSeqs" integer[] DEFAULT '{}'::integer[] NOT NULL,
  ADD COLUMN "tombstoneVisibleThroughSeq" integer,
  ADD COLUMN "groupMetaVisibleThroughId" integer,
  ADD CONSTRAINT "AccountThreadState_tombstoneVisibleThroughSeq_check" CHECK (
    "tombstoneVisibleThroughSeq" IS NULL OR "tombstoneVisibleThroughSeq" >= 0
  ),
  ADD CONSTRAINT "AccountThreadState_groupMetaVisibleThroughId_check" CHECK (
    "groupMetaVisibleThroughId" IS NULL OR "groupMetaVisibleThroughId" >= 0
  );

UPDATE public."AccountThreadState" s
SET "previewDeletedSeqs" = ARRAY(
  SELECT m.seq
  FROM public."Message" m
  WHERE m."threadId" = s."threadId"
    AND m.seq = ANY(s."previewSeqs")
    AND m."isDeleted" = true
  ORDER BY m.seq
),
"tombstoneVisibleThroughSeq" = CASE
  WHEN s."messageVisibleThroughSeq" IS NOT NULL THEN s."tombstoneEndSeq"
  ELSE NULL
END,
"groupMetaVisibleThroughId" = CASE
  WHEN s."messageVisibleThroughSeq" IS NOT NULL AND t.type = 'GROUP' THEN 0
  ELSE NULL
END
FROM public."MessageThread" t
WHERE t.id = s."threadId";

CREATE OR REPLACE FUNCTION public.thread_feed_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE c integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."accountId" <> OLD."accountId" OR NEW."threadId" <> OLD."threadId") THEN
    RAISE EXCEPTION 'attention owner and thread are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.blocked IS DISTINCT FROM OLD.blocked THEN
    SELECT "clearedSeq" INTO c FROM "MessageThread" WHERE id = NEW."threadId" FOR NO KEY UPDATE;
    NEW."unreadCount" := thread_unread_count(NEW, c, NEW."lastReadSeq", NEW."messageEndSeq");
    NEW."previewSeqs" := ARRAY(SELECT seq FROM unnest(NEW."previewSeqs") seq
      WHERE seq >= NEW."lastReadSeq" AND seq > COALESCE(c, 0)
        AND seq <= COALESCE(NEW."messageVisibleThroughSeq", NEW."messageEndSeq") ORDER BY seq DESC);
    NEW."previewDeletedSeqs" := ARRAY(SELECT seq FROM unnest(NEW."previewDeletedSeqs") seq
      WHERE seq = ANY(NEW."previewSeqs") ORDER BY seq);
  END IF;
  IF TG_OP = 'INSERT' OR NEW."threadFeedId" = 0
    OR NEW.alias IS DISTINCT FROM OLD.alias
    OR NEW."previewSeqs" IS DISTINCT FROM OLD."previewSeqs"
    OR NEW."previewDeletedSeqs" IS DISTINCT FROM OLD."previewDeletedSeqs"
    OR NEW."unreadCount" IS DISTINCT FROM OLD."unreadCount"
    OR NEW."lastReadSeq" IS DISTINCT FROM OLD."lastReadSeq"
    OR NEW."announcementReadFeedId" IS DISTINCT FROM OLD."announcementReadFeedId"
    OR NEW."lastMentionSeq" IS DISTINCT FROM OLD."lastMentionSeq"
    OR NEW."messageEndSeq" IS DISTINCT FROM OLD."messageEndSeq"
    OR NEW."joinRequestEndFeedId" IS DISTINCT FROM OLD."joinRequestEndFeedId"
    OR NEW."groupInviteEndFeedId" IS DISTINCT FROM OLD."groupInviteEndFeedId"
    OR NEW."joinRequestReadFeedId" IS DISTINCT FROM OLD."joinRequestReadFeedId"
    OR NEW."threadProfileRev" IS DISTINCT FROM OLD."threadProfileRev"
    OR NEW.blocked IS DISTINCT FROM OLD.blocked
    OR NEW.role IS DISTINCT FROM OLD.role THEN
    UPDATE "Account" SET "updatedAt" = CURRENT_TIMESTAMP, "threadFeedEndId" = "threadFeedEndId" + 1
      WHERE id = NEW."accountId" RETURNING "threadFeedEndId" INTO NEW."threadFeedId";
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public."AccountThreadState"
  DROP CONSTRAINT "AccountThreadState_tombstoneEndSeq_check",
  DROP CONSTRAINT "AccountThreadState_groupMetaFeedEndId_check",
  DROP COLUMN "tombstoneEndSeq",
  DROP COLUMN "groupMetaFeedEndId";
