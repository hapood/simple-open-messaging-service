-- The group's meta feed head rides the thread feed: each member's conversation
-- row stores the last meta feed end id published to it, and the thread fan-out
-- keeps it at the canonical GroupMeta head like read/head updates. P2P rows
-- stay NULL, and rows converge on the next fan-out without a backfill.
ALTER TABLE public."AccountThreadState"
  ADD COLUMN "groupMetaFeedEndId" bigint;
ALTER TABLE public."AccountThreadState"
  ADD CONSTRAINT "AccountThreadState_groupMetaFeedEndId_check"
    CHECK ("groupMetaFeedEndId" IS NULL OR "groupMetaFeedEndId" >= 0);

-- thread_feed_before_write is re-emitted from its 0009 definition: the meta
-- feed end id is client-visible on the thread feed, so the trigger's change
-- detection learns the column. It can change alone — meta-only mutations
-- advance no content head — and the thread feed delta scans a threadFeedId
-- range, so a changed row without a fresh allocation is silently invisible.
CREATE OR REPLACE FUNCTION public.thread_feed_before_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE c integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."accountId" <> OLD."accountId" OR NEW."threadId" <> OLD."threadId") THEN
    RAISE EXCEPTION 'attention owner and thread are immutable';
  END IF;
  -- Blocking still reconciles attention in the source transaction. Ordinary
  -- read/head updates already contain the signed delta computed by the writer.
  IF TG_OP = 'UPDATE' AND NEW.blocked IS DISTINCT FROM OLD.blocked THEN
    SELECT "clearedSeq" INTO c FROM "MessageThread" WHERE id = NEW."threadId" FOR NO KEY UPDATE;
    NEW."unreadCount" := thread_unread_count(NEW, c, NEW."lastReadSeq", NEW."messageEndSeq");
    NEW."previewSeqs" := ARRAY(SELECT seq FROM unnest(NEW."previewSeqs") seq
      WHERE seq >= NEW."lastReadSeq" AND seq > COALESCE(c, 0)
        AND seq <= COALESCE(NEW."messageVisibleThroughSeq", NEW."messageEndSeq") ORDER BY seq DESC);
  END IF;
  IF TG_OP = 'INSERT' OR NEW."threadFeedId" = 0
    OR NEW."previewSeqs" IS DISTINCT FROM OLD."previewSeqs"
    OR NEW."unreadCount" IS DISTINCT FROM OLD."unreadCount"
    OR NEW."lastReadSeq" IS DISTINCT FROM OLD."lastReadSeq"
    OR NEW."lastMentionSeq" IS DISTINCT FROM OLD."lastMentionSeq"
    OR NEW."messageEndSeq" IS DISTINCT FROM OLD."messageEndSeq"
    OR NEW."tombstoneEndSeq" IS DISTINCT FROM OLD."tombstoneEndSeq"
    OR NEW."joinRequestEndFeedId" IS DISTINCT FROM OLD."joinRequestEndFeedId"
    OR NEW."groupInviteEndFeedId" IS DISTINCT FROM OLD."groupInviteEndFeedId"
    OR NEW."joinRequestReadFeedId" IS DISTINCT FROM OLD."joinRequestReadFeedId"
    OR NEW."groupMetaFeedEndId" IS DISTINCT FROM OLD."groupMetaFeedEndId" THEN
    UPDATE "Account" SET "threadFeedEndId" = "threadFeedEndId" + 1
      WHERE id = NEW."accountId" RETURNING "threadFeedEndId" INTO NEW."threadFeedId";
  END IF;
  RETURN NEW;
END;
$$;
