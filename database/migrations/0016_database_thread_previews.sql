-- Preview references now publish atomically with content/read projections.
CREATE OR REPLACE FUNCTION thread_feed_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."accountId" <> OLD."accountId" OR NEW."threadId" <> OLD."threadId") THEN
    RAISE EXCEPTION 'attention owner and thread are immutable';
  END IF;
  -- Lifecycle boundaries still commit with their source transaction. Ordinary
  -- read/head updates already contain the signed delta computed by the writer.
  IF TG_OP = 'UPDATE' AND (
    NEW."messageVisibleThroughSeq" IS DISTINCT FROM OLD."messageVisibleThroughSeq"
    OR NEW.blocked IS DISTINCT FROM OLD.blocked) THEN
    SELECT "clearedSeq" INTO c FROM "MessageThread" WHERE id = NEW."threadId" FOR UPDATE;
    NEW."unreadCount" := thread_unread_count(NEW, c, NEW."lastReadSeq", NEW."messageEndSeq");
    NEW."previewSeqs" := ARRAY(SELECT seq FROM unnest(NEW."previewSeqs") seq
      WHERE seq > GREATEST(NEW."lastReadSeq", COALESCE(c, 0))
        AND seq <= COALESCE(NEW."messageVisibleThroughSeq", NEW."messageEndSeq") ORDER BY seq DESC);
  END IF;
  IF TG_OP = 'INSERT' OR NEW."threadFeedId" = 0
    OR NEW."previewSeqs" IS DISTINCT FROM OLD."previewSeqs"
    OR NEW."unreadCount" IS DISTINCT FROM OLD."unreadCount"
    OR NEW."lastReadSeq" IS DISTINCT FROM OLD."lastReadSeq"
    OR NEW."lastMentionSeq" IS DISTINCT FROM OLD."lastMentionSeq"
    OR NEW."messageEndSeq" IS DISTINCT FROM OLD."messageEndSeq"
    OR NEW."tombstoneEndSeq" IS DISTINCT FROM OLD."tombstoneEndSeq" THEN
    UPDATE "Account" SET "threadFeedEndId" = "threadFeedEndId" + 1
      WHERE id = NEW."accountId" RETURNING "threadFeedEndId" INTO NEW."threadFeedId";
  END IF;
  RETURN NEW;
END;
$$;

-- Discard obsolete in-memory-cache checkpoints; no compatibility recovery phase.
DELETE FROM "DurableTask" WHERE "taskType" = 'FAN_OUT_THREAD_CONTENT' AND checkpoint->>'phase' = 'CACHE';
