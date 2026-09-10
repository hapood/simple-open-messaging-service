-- Mention projection now commits with fanout/read heads, not a separate task.
-- Existing count arithmetic remains until the unread/preview projection cutover.
CREATE OR REPLACE FUNCTION thread_feed_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integer;
DECLARE delta integer;
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
  ELSE
    IF NEW."messageVisibleThroughSeq" IS DISTINCT FROM OLD."messageVisibleThroughSeq"
      OR NEW.blocked IS DISTINCT FROM OLD.blocked THEN
      SELECT count(*)::integer INTO NEW."unreadCount" FROM "Message" m
        WHERE m."threadId" = NEW."threadId" AND m.seq > NEW."lastReadSeq"
          AND attention_message_eligible(m, NEW, c);
    ELSIF NEW."lastReadSeq" <> OLD."lastReadSeq" THEN
      SELECT count(*)::integer INTO delta FROM "Message" m
        WHERE m."threadId" = NEW."threadId"
          AND m.seq > LEAST(OLD."lastReadSeq", NEW."lastReadSeq")
          AND m.seq <= GREATEST(OLD."lastReadSeq", NEW."lastReadSeq")
          AND attention_message_eligible(m, NEW, c);
      NEW."unreadCount" := OLD."unreadCount" + CASE WHEN NEW."lastReadSeq" > OLD."lastReadSeq" THEN -delta ELSE delta END;
    END IF;
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
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION attention_message_after_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "AccountThreadState";
DECLARE tid integer := CASE WHEN TG_OP = 'DELETE' THEN OLD."threadId" ELSE NEW."threadId" END;
DECLARE c integer;
DECLARE was_eligible boolean;
DECLARE now_eligible boolean;
DECLARE d integer;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.seq = OLD.seq AND NEW."threadId" = OLD."threadId"
    AND NEW."localState" = OLD."localState" AND NEW."isDeleted" = OLD."isDeleted"
    AND NEW."creatorAccount" IS NOT DISTINCT FROM OLD."creatorAccount"
    AND NEW."creatorDomain" IS NOT DISTINCT FROM OLD."creatorDomain"
    AND NEW."creatorNamespaceId" = OLD."creatorNamespaceId"
    AND NEW."contentType" = OLD."contentType"
    AND (NEW."contentType" <> 'PURE_TEXT' OR NEW.content IS NOT DISTINCT FROM OLD.content)
    THEN RETURN NULL; END IF;
  SELECT COALESCE("clearedSeq", 0) INTO c FROM "MessageThread" WHERE id = tid;
  FOR s IN SELECT * FROM "AccountThreadState" WHERE "threadId" = tid ORDER BY "accountId" FOR UPDATE LOOP
    was_eligible := TG_OP <> 'INSERT' AND attention_message_eligible(OLD, s, c);
    now_eligible := TG_OP <> 'DELETE' AND attention_message_eligible(NEW, s, c);
    d := CASE WHEN now_eligible AND NEW.seq > s."lastReadSeq" THEN 1 ELSE 0 END
       - CASE WHEN was_eligible AND OLD.seq > s."lastReadSeq" THEN 1 ELSE 0 END;
    IF d <> 0 THEN
      UPDATE "AccountThreadState" SET "unreadCount" = "unreadCount" + d
        WHERE id = s.id;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION attention_history_after_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "AccountThreadState";
DECLARE n integer;
BEGIN
  IF NEW."clearedSeq" IS NOT DISTINCT FROM OLD."clearedSeq" THEN RETURN NULL; END IF;
  FOR s IN SELECT * FROM "AccountThreadState" WHERE "threadId" = NEW.id ORDER BY "accountId" FOR UPDATE LOOP
    SELECT count(*)::integer INTO n FROM "Message" m WHERE m."threadId" = NEW.id
      AND m.seq > s."lastReadSeq" AND attention_message_eligible(m, s, NEW."clearedSeq");
    UPDATE "AccountThreadState" SET "unreadCount" = n WHERE id = s.id;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP FUNCTION attention_enqueue_mention(integer, integer, integer);
DELETE FROM "DurableTask" WHERE "taskType" = 'REFRESH_THREAD_MENTION';
-- Discard obsolete mention snapshots; normal content fanout will publish new ones.
UPDATE "AccountThreadState" SET "lastMentionSeq" = NULL;
