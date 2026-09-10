ALTER TABLE "Account" RENAME COLUMN "readRevision" TO "attentionFeedEndId";
ALTER TABLE "Account" ADD CONSTRAINT "Account_attentionFeedEndId_check" CHECK ("attentionFeedEndId" >= 0);
DROP INDEX "AccountThreadState_accountId_readRevision_idx";
ALTER TABLE "AccountThreadState" DROP COLUMN "readRevision";
ALTER TABLE "AccountThreadState" ADD COLUMN "attentionFeedId" integer NOT NULL DEFAULT 0,
  ADD COLUMN "unreadCount" integer NOT NULL DEFAULT 0,
  ADD COLUMN "lastMentionSeq" integer;
UPDATE "AccountThreadState" SET "lastReadSeq" = 0 WHERE "lastReadSeq" IS NULL;
ALTER TABLE "AccountThreadState" ALTER COLUMN "lastReadSeq" SET DEFAULT 0,
  ALTER COLUMN "lastReadSeq" SET NOT NULL;

-- One eligibility predicate for transition deltas, read intervals and mention scans.
-- Callers serialize writes by MessageThread before changing these source facts.
CREATE FUNCTION attention_message_eligible(m "Message", s "AccountThreadState", cleared integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT m."threadId" = s."threadId" AND m."localState" = 'READY'
    AND NOT m."isDeleted" AND m.seq > COALESCE(cleared, 0)
    AND (s."messageVisibleThroughSeq" IS NULL OR m.seq <= s."messageVisibleThroughSeq")
    AND NOT EXISTS (SELECT 1 FROM "Account" a WHERE a.id = s."accountId"
      AND a.account = m."creatorAccount" AND a.domain = m."creatorDomain"
      AND a."namespaceId" = m."creatorNamespaceId")
    AND NOT (s.blocked AND EXISTS (SELECT 1 FROM "MessageThread" t
      WHERE t.id = s."threadId" AND t.type = 'P2P'));
$$;

CREATE FUNCTION attention_enqueue_mention(account_id integer, thread_id integer, candidate_seq integer DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE pending_id bigint;
DECLARE merged_id bigint;
DECLARE task_scope text := jsonb_build_array('ATTENTION', account_id, thread_id)::text;
BEGIN
  -- Source transactions already own the thread lock. Never edit PROCESSING work.
  SELECT id INTO pending_id FROM "DurableTask"
    WHERE kind = 'PROJECTION' AND "scopeKey" = task_scope
      AND "taskType" = 'REFRESH_THREAD_MENTION' AND status = 'PENDING'
    ORDER BY id DESC LIMIT 1;
  IF pending_id IS NOT NULL THEN
    UPDATE "DurableTask" SET payload = CASE
      WHEN candidate_seq IS NULL OR NOT (payload ? 'seq') THEN jsonb_build_object('threadId', thread_id)
      ELSE jsonb_build_object('threadId', thread_id, 'seq', GREATEST((payload->>'seq')::integer, candidate_seq)) END
      WHERE id = pending_id AND status = 'PENDING' RETURNING id INTO merged_id;
    IF merged_id IS NOT NULL THEN RETURN; END IF;
  END IF;
  IF merged_id IS NULL THEN
    INSERT INTO "DurableTask" (kind, "scopeType", "scopeKey", "taskType", "actorUserId", payload, "coalescingKey")
      VALUES ('PROJECTION', 'ACCOUNT_THREAD', task_scope, 'REFRESH_THREAD_MENTION', account_id,
        jsonb_strip_nulls(jsonb_build_object('threadId', thread_id, 'seq', candidate_seq)), task_scope);
  END IF;
END;
$$;

CREATE FUNCTION attention_state_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c integer;
DECLARE delta integer;
DECLARE refresh boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."accountId" <> OLD."accountId" OR NEW."threadId" <> OLD."threadId") THEN
    RAISE EXCEPTION 'attention owner and thread are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."attentionFeedId" <> 0
    AND NEW."lastReadSeq" = OLD."lastReadSeq"
    AND NEW."unreadCount" = OLD."unreadCount"
    AND NEW."lastMentionSeq" IS NOT DISTINCT FROM OLD."lastMentionSeq"
    AND NEW."messageVisibleThroughSeq" IS NOT DISTINCT FROM OLD."messageVisibleThroughSeq"
    AND NEW.blocked = OLD.blocked THEN RETURN NEW; END IF;
  SELECT COALESCE("clearedSeq", 0) INTO c FROM "MessageThread" WHERE id = NEW."threadId" FOR UPDATE;
  IF TG_OP = 'INSERT' OR NEW."attentionFeedId" = 0 THEN
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
  IF TG_OP = 'INSERT' OR NEW."attentionFeedId" = 0
    OR NEW."unreadCount" IS DISTINCT FROM OLD."unreadCount"
    OR NEW."lastReadSeq" IS DISTINCT FROM OLD."lastReadSeq"
    OR NEW."lastMentionSeq" IS DISTINCT FROM OLD."lastMentionSeq" THEN
    UPDATE "Account" SET "attentionFeedEndId" = "attentionFeedEndId" + 1
      WHERE id = NEW."accountId" RETURNING "attentionFeedEndId" INTO NEW."attentionFeedId";
  END IF;
  IF refresh THEN PERFORM attention_enqueue_mention(NEW."accountId", NEW."threadId"); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attention_state_before_write BEFORE INSERT OR UPDATE ON "AccountThreadState"
  FOR EACH ROW EXECUTE FUNCTION attention_state_before_write();

CREATE FUNCTION attention_message_before_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.seq = OLD.seq AND NEW."threadId" = OLD."threadId"
    AND NEW."localState" = OLD."localState" AND NEW."isDeleted" = OLD."isDeleted"
    AND NEW."creatorAccount" IS NOT DISTINCT FROM OLD."creatorAccount"
    AND NEW."creatorDomain" IS NOT DISTINCT FROM OLD."creatorDomain"
    AND NEW."creatorNamespaceId" = OLD."creatorNamespaceId"
    AND NEW."contentType" = OLD."contentType"
    AND (NEW."contentType" <> 'PURE_TEXT' OR NEW.content IS NOT DISTINCT FROM OLD.content)
    THEN RETURN NEW; END IF;
  PERFORM 1 FROM "MessageThread" WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD."threadId" ELSE NEW."threadId" END FOR UPDATE;
  IF TG_OP = 'UPDATE' AND (NEW.seq <> OLD.seq OR NEW."threadId" <> OLD."threadId") THEN
    RAISE EXCEPTION 'message sequence and thread are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attention_message_before_write BEFORE INSERT OR UPDATE OR DELETE ON "Message"
  FOR EACH ROW EXECUTE FUNCTION attention_message_before_write();

CREATE FUNCTION attention_message_after_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "AccountThreadState";
DECLARE tid integer := CASE WHEN TG_OP = 'DELETE' THEN OLD."threadId" ELSE NEW."threadId" END;
DECLARE c integer;
DECLARE was_eligible boolean;
DECLARE now_eligible boolean;
DECLARE d integer;
DECLARE refresh boolean;
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
    -- Narrow candidates cheaply. The worker validates semantic entities before applying a seq.
    refresh := (was_eligible AND OLD."contentType" = 'PURE_TEXT' AND strpos(OLD.content::text, 'somfp://') > 0)
      OR (now_eligible AND NEW."contentType" = 'PURE_TEXT' AND strpos(NEW.content::text, 'somfp://') > 0);
    IF TG_OP = 'UPDATE' AND was_eligible = now_eligible AND OLD.content IS NOT DISTINCT FROM NEW.content
      AND OLD."contentType" = NEW."contentType" THEN refresh := false; END IF;
    IF d <> 0 OR refresh THEN
      UPDATE "AccountThreadState" SET "unreadCount" = "unreadCount" + d
        WHERE id = s.id;
      IF refresh THEN
        PERFORM attention_enqueue_mention(s."accountId", tid,
          CASE WHEN now_eligible AND NOT was_eligible THEN NEW.seq ELSE NULL END);
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER attention_message_after_write AFTER INSERT OR UPDATE OR DELETE ON "Message"
  FOR EACH ROW EXECUTE FUNCTION attention_message_after_write();

CREATE FUNCTION attention_history_after_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "AccountThreadState";
DECLARE n integer;
BEGIN
  IF NEW."clearedSeq" IS NOT DISTINCT FROM OLD."clearedSeq" THEN RETURN NULL; END IF;
  FOR s IN SELECT * FROM "AccountThreadState" WHERE "threadId" = NEW.id ORDER BY "accountId" FOR UPDATE LOOP
    SELECT count(*)::integer INTO n FROM "Message" m WHERE m."threadId" = NEW.id
      AND m.seq > s."lastReadSeq" AND attention_message_eligible(m, s, NEW."clearedSeq");
    UPDATE "AccountThreadState" SET "unreadCount" = n WHERE id = s.id;
    PERFORM attention_enqueue_mention(s."accountId", NEW.id);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER attention_history_after_write AFTER UPDATE OF "clearedSeq" ON "MessageThread"
  FOR EACH ROW EXECUTE FUNCTION attention_history_after_write();

-- Initialize projections from source facts; no legacy cursor or capped count is reused.
UPDATE "AccountThreadState" SET "attentionFeedId" = 0;
ALTER TABLE "AccountThreadState"
  ADD CONSTRAINT "AccountThreadState_attentionFeedId_check" CHECK ("attentionFeedId" > 0),
  ADD CONSTRAINT "AccountThreadState_unreadCount_check" CHECK ("unreadCount" >= 0),
  ADD CONSTRAINT "AccountThreadState_lastReadSeq_check" CHECK ("lastReadSeq" >= 0),
  ADD CONSTRAINT "AccountThreadState_lastMentionSeq_check" CHECK ("lastMentionSeq" IS NULL OR "lastMentionSeq" > 0);
CREATE UNIQUE INDEX "AccountThreadState_accountId_attentionFeedId_key" ON "AccountThreadState" ("accountId", "attentionFeedId");
