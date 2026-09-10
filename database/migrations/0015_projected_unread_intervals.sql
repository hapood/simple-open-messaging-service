-- Count immutable message slots, including tombs, within the published interval.
CREATE OR REPLACE FUNCTION attention_message_eligible(m "Message", s "AccountThreadState", cleared integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT m."threadId" = s."threadId" AND m.seq > COALESCE(cleared, 0)
    AND (s."messageVisibleThroughSeq" IS NULL OR m.seq <= s."messageVisibleThroughSeq")
    AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a.id = s."accountId"
      AND a.account = m."creatorAccount" AND a.domain = m."creatorDomain"
      AND a."namespaceId" = m."creatorNamespaceId")
    AND NOT s.blocked;
$$;

CREATE FUNCTION thread_unread_count(s "AccountThreadState", cleared integer, after_seq integer, through_seq integer)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::integer FROM "Message" m
  WHERE m."threadId" = s."threadId" AND m.seq > after_seq AND m.seq <= through_seq
    AND attention_message_eligible(m, s, cleared);
$$;

-- Source writes retain their existing thread lock, but no longer touch recipient counts.
DROP TRIGGER attention_message_after_write ON "Message";
DROP FUNCTION attention_message_after_write();

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

CREATE OR REPLACE FUNCTION attention_history_after_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "AccountThreadState";
BEGIN
  IF NEW."clearedSeq" IS NOT DISTINCT FROM OLD."clearedSeq" THEN RETURN NULL; END IF;
  FOR s IN SELECT * FROM "AccountThreadState" WHERE "threadId" = NEW.id ORDER BY "accountId" FOR UPDATE LOOP
    UPDATE "AccountThreadState" SET "unreadCount" =
      thread_unread_count(s, NEW."clearedSeq", s."lastReadSeq", s."messageEndSeq") WHERE id = s.id;
  END LOOP;
  RETURN NULL;
END;
$$;

-- Discard old projection snapshots rather than importing incompatible counts.
UPDATE "AccountThreadState" SET "unreadCount" = 0, "lastMentionSeq" = NULL,
  "messageEndSeq" = 0, "tombstoneEndSeq" = 0, "previewSeqs" = '{}', "threadFeedId" = 0;
