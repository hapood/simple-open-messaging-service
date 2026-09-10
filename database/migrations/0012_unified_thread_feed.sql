-- Replace the split client content/attention projection. Peer state feeds are unchanged.
DROP TRIGGER attention_state_before_write ON "AccountThreadState";
DROP FUNCTION attention_state_before_write();
ALTER TABLE "Account" RENAME COLUMN "attentionFeedEndId" TO "threadFeedEndId";
ALTER TABLE "Account" RENAME CONSTRAINT "Account_attentionFeedEndId_check" TO "Account_threadFeedEndId_check";
ALTER TABLE "AccountThreadState" RENAME COLUMN "attentionFeedId" TO "threadFeedId";
ALTER TABLE "AccountThreadState" RENAME CONSTRAINT "AccountThreadState_attentionFeedId_check" TO "AccountThreadState_threadFeedId_check";
ALTER INDEX "AccountThreadState_accountId_attentionFeedId_key" RENAME TO "AccountThreadState_accountId_threadFeedId_key";
ALTER TABLE "AccountThreadState"
  ADD COLUMN "messageEndSeq" integer NOT NULL DEFAULT 0,
  ADD COLUMN "tombstoneEndSeq" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "AccountThreadState_messageEndSeq_check" CHECK ("messageEndSeq" >= 0),
  ADD CONSTRAINT "AccountThreadState_tombstoneEndSeq_check" CHECK ("tombstoneEndSeq" >= 0);
CREATE FUNCTION thread_feed_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integer;
DECLARE delta integer;
DECLARE refresh boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."accountId" <> OLD."accountId" OR NEW."threadId" <> OLD."threadId") THEN
    RAISE EXCEPTION 'attention owner and thread are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."threadFeedId" <> 0
    AND NEW."lastReadSeq" = OLD."lastReadSeq"
    AND NEW."unreadCount" = OLD."unreadCount"
    AND NEW."lastMentionSeq" IS NOT DISTINCT FROM OLD."lastMentionSeq"
    AND NEW."messageVisibleThroughSeq" IS NOT DISTINCT FROM OLD."messageVisibleThroughSeq"
    AND NEW.blocked = OLD.blocked
    AND NEW."messageEndSeq" = OLD."messageEndSeq"
    AND NEW."tombstoneEndSeq" = OLD."tombstoneEndSeq" THEN RETURN NEW; END IF;
  SELECT COALESCE("clearedSeq", 0) INTO c FROM "MessageThread" WHERE id = NEW."threadId" FOR UPDATE;
  IF TG_OP = 'INSERT' OR NEW."threadFeedId" = 0 THEN
    SELECT count(*)::integer INTO NEW."unreadCount" FROM "Message" m
      WHERE m."threadId" = NEW."threadId" AND m.seq > NEW."lastReadSeq"
        AND attention_message_eligible(m, NEW, c);
    refresh := true;
  ELSE
    IF NEW."messageVisibleThroughSeq" IS DISTINCT FROM OLD."messageVisibleThroughSeq"
      OR NEW.blocked IS DISTINCT FROM OLD.blocked THEN
      SELECT count(*)::integer INTO NEW."unreadCount" FROM "Message" m
        WHERE m."threadId" = NEW."threadId" AND m.seq > NEW."lastReadSeq"
          AND attention_message_eligible(m, NEW, c);
      refresh := true;
    ELSIF NEW."lastReadSeq" <> OLD."lastReadSeq" THEN
      SELECT count(*)::integer INTO delta FROM "Message" m
        WHERE m."threadId" = NEW."threadId"
          AND m.seq > LEAST(OLD."lastReadSeq", NEW."lastReadSeq")
          AND m.seq <= GREATEST(OLD."lastReadSeq", NEW."lastReadSeq")
          AND attention_message_eligible(m, NEW, c);
      NEW."unreadCount" := OLD."unreadCount" + CASE WHEN NEW."lastReadSeq" > OLD."lastReadSeq" THEN -delta ELSE delta END;
    END IF;
    IF NEW."lastReadSeq" < OLD."lastReadSeq" THEN refresh := true; END IF;
  END IF;
  IF TG_OP = 'INSERT' OR NEW."threadFeedId" = 0
    OR NEW."unreadCount" IS DISTINCT FROM OLD."unreadCount"
    OR NEW."lastReadSeq" IS DISTINCT FROM OLD."lastReadSeq"
    OR NEW."lastMentionSeq" IS DISTINCT FROM OLD."lastMentionSeq"
    OR NEW."messageEndSeq" IS DISTINCT FROM OLD."messageEndSeq"
    OR NEW."tombstoneEndSeq" IS DISTINCT FROM OLD."tombstoneEndSeq" THEN
    UPDATE "Account" SET "threadFeedEndId" = "threadFeedEndId" + 1
      WHERE id = NEW."accountId" RETURNING "threadFeedEndId" INTO NEW."threadFeedId";
  END IF;
  IF refresh THEN PERFORM attention_enqueue_mention(NEW."accountId", NEW."threadId"); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER thread_feed_before_write BEFORE INSERT OR UPDATE ON "AccountThreadState"
  FOR EACH ROW EXECUTE FUNCTION thread_feed_before_write();

-- Rebuild published heads from committed facts during offline cutover, never from legacy JSON.
UPDATE "AccountThreadState" s SET
  "messageEndSeq" = LEAST(t."curSeq", COALESCE(s."messageVisibleThroughSeq", t."curSeq"))::integer,
  "tombstoneEndSeq" = COALESCE((SELECT max(d."deletionSeq") FROM "DeletedMessage" d WHERE d."threadId" = t.id), 0),
  "threadFeedId" = 0
FROM "MessageThread" t WHERE t.id = s."threadId";
DELETE FROM "ClientStateFeed" WHERE "eventType" = 'THREAD_CONTENT_HEAD';
