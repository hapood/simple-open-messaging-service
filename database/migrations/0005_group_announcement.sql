-- The announcement is a compacted group-wide Group Meta projection. A null
-- coordinate is unknown (distinct from a known clear with null text).
ALTER TABLE "GroupMeta" ADD COLUMN "announcementFeedId" integer;
ALTER TABLE "GroupMeta" ADD COLUMN "announcementText" text;
ALTER TABLE "GroupMeta" ADD CONSTRAINT "GroupMeta_announcementFeedId_check"
  CHECK ("announcementFeedId" IS NULL OR "announcementFeedId" > 0);
ALTER TABLE "GroupMeta" ADD CONSTRAINT "GroupMeta_announcementText_check"
  CHECK ("announcementText" IS NULL OR
    ("announcementFeedId" IS NOT NULL AND char_length("announcementText") BETWEEN 1 AND 4096));

ALTER TABLE "AccountThreadState" ADD COLUMN "announcementReadFeedId" integer NOT NULL DEFAULT 0;
ALTER TABLE "AccountThreadState" ADD CONSTRAINT "AccountThreadState_announcementReadFeedId_check"
  CHECK ("announcementReadFeedId" >= 0);

-- Existing origin groups establish an explicit clear at a fresh coordinate;
-- mirror groups stay unknown until their next complete full/delta application.
INSERT INTO "GroupMeta" ("threadId")
SELECT id FROM "MessageThread"
WHERE type = 'GROUP' AND "groupDomain" = 'local'
ON CONFLICT ("threadId") DO NOTHING;

UPDATE "GroupMeta" meta SET "metaEndId" = meta."metaEndId" + 1,
  "announcementFeedId" = meta."metaEndId" + 1,
  "announcementText" = NULL, "updatedAt" = CURRENT_TIMESTAMP
FROM "MessageThread" thread
WHERE thread.id = meta."threadId" AND thread.type = 'GROUP'
  AND thread."groupDomain" = 'local';

-- Republish both existing head paths for upgraded origin groups. A pending
-- projection may already exist; an additional scoped task is safe and its
-- payload is the current head (not an announcement-specific event).
INSERT INTO "DurableTask" (id, kind, "scopeType", "scopeKey", "taskType", payload, "coalescingKey")
SELECT nextval('"DurableTask_id_seq"'), 'PROJECTION', 'THREAD',
  format('["%s",%s]', kind.scope, thread.id),
  kind.task_type,
  jsonb_build_object('threadId', thread.id,
    'messageEndSeq', COALESCE((SELECT max(msg.seq) FROM "Message" msg
      WHERE msg."threadId" = thread.id), 0),
    'tombstoneEndSeq', thread."tombstoneEndSeq"),
  format('["%s",%s]', kind.scope, thread.id)
FROM "GroupMeta" meta
JOIN "MessageThread" thread ON thread.id = meta."threadId"
CROSS JOIN (VALUES ('THREAD_FANOUT', 'FAN_OUT_THREAD_CONTENT'),
                   ('FEDERATION_THREAD_FANOUT', 'FAN_OUT_FEDERATION_THREAD_CONTENT'))
  AS kind(scope, task_type)
WHERE thread.type = 'GROUP' AND thread."groupDomain" = 'local';

-- An acknowledgement must advance the account's existing thread feed, not
-- allocate a separate SSE channel or alter the message read position.
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
  END IF;
  IF TG_OP = 'INSERT' OR NEW."threadFeedId" = 0
    OR NEW.alias IS DISTINCT FROM OLD.alias
    OR NEW."previewSeqs" IS DISTINCT FROM OLD."previewSeqs"
    OR NEW."unreadCount" IS DISTINCT FROM OLD."unreadCount"
    OR NEW."lastReadSeq" IS DISTINCT FROM OLD."lastReadSeq"
    OR NEW."announcementReadFeedId" IS DISTINCT FROM OLD."announcementReadFeedId"
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
