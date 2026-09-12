-- Group number streams get one uniform naming scheme. GroupMetaFeed is the
-- group's meta coordinate space, not a feed of events, so the table drops the
-- feed suffix and its three streams share the <stream>EndId shape: "end" is
-- truthful for both an origin allocation end and a mirror's applied cursor.
ALTER TABLE public."GroupMetaFeed" RENAME TO "GroupMeta";
ALTER TABLE public."GroupMeta"
  RENAME COLUMN "feedEndId" TO "metaEndId";
ALTER TABLE public."GroupMeta"
  RENAME COLUMN "applicationFeedAllocatedThrough" TO "applicationEndId";
ALTER TABLE public."GroupMeta"
  RENAME COLUMN "invitationFeedAllocatedThrough" TO "invitationEndId";
ALTER TABLE public."GroupMeta"
  RENAME CONSTRAINT "GroupMetaFeed_feedEndId_check" TO "GroupMeta_metaEndId_check";
ALTER TABLE public."GroupMeta"
  RENAME CONSTRAINT "GroupMetaFeed_applicationFeedAllocatedThrough_check"
    TO "GroupMeta_applicationEndId_check";
ALTER TABLE public."GroupMeta"
  RENAME CONSTRAINT "GroupMetaFeed_invitationFeedAllocatedThrough_check"
    TO "GroupMeta_invitationEndId_check";
ALTER TABLE public."GroupMeta"
  RENAME CONSTRAINT "GroupMetaFeed_threadId_fkey" TO "GroupMeta_threadId_fkey";

-- Managers carry one fan-out watermark per direction: join requests on the
-- existing joinRequestEndFeedId, invitations on the new groupInviteEndFeedId.
-- The request projection fan-out advances both from the group's direction
-- counters, and any movement rides the thread feed like read/head updates, so
-- the trigger's change detection learns the new column.
ALTER TABLE public."AccountThreadState"
  ADD COLUMN "groupInviteEndFeedId" integer NOT NULL DEFAULT 0;

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
    OR NEW."joinRequestReadFeedId" IS DISTINCT FROM OLD."joinRequestReadFeedId" THEN
    UPDATE "Account" SET "threadFeedEndId" = "threadFeedEndId" + 1
      WHERE id = NEW."accountId" RETURNING "threadFeedEndId" INTO NEW."threadFeedId";
  END IF;
  RETURN NEW;
END;
$$;
