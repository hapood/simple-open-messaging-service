-- Denormalized "last message" read-cache on MessageThread for the conversation list (the hottest read
-- path): avoids an N-thread join on Message just to render a preview + unread badge. The fields are kept
-- in sync transactionally by writeMsgToThread on every message send (see message.service.ts).
--
-- Additive only: four NULLable columns, so threads with no messages yet stay NULL. Backfilled below
-- from each thread's newest message (max id) so existing conversations get a preview immediately.

-- 1. Columns (DDL generated via `prisma migrate diff --from-config-datasource --to-schema`).
ALTER TABLE "MessageThread" ADD COLUMN "lastMessageAt" TIMESTAMP(3),
ADD COLUMN "lastMessageId" BIGINT,
ADD COLUMN "lastMessagePreview" VARCHAR(255),
ADD COLUMN "lastMessageSenderId" INTEGER;

-- 2. Backfill from the newest Message of each thread. Preview derivation mirrors the TS derivePreview()
--    in message.service.ts (kept in sync manually — this is a one-shot backfill). DISTINCT ON picks the
--    single newest row per thread (id DESC); the WHERE leaves empty threads at NULL.
WITH "latest" AS (
  SELECT DISTINCT ON ("threadId")
         "threadId", "id", "content", "contentType", "creator", "createdAt"
  FROM "Message"
  ORDER BY "threadId" ASC, "id" DESC
)
UPDATE "MessageThread"
SET "lastMessageId"      = "latest"."id",
    "lastMessagePreview" =
      CASE "latest"."contentType"
        WHEN 'PURE_TEXT' THEN LEFT(REPLACE("latest"."content", chr(10), ' '), 200)
        WHEN 'IMAGE'     THEN '[Photo]'
        WHEN 'INVITE'    THEN '[Group invite]'
        WHEN 'VIDEO'     THEN '[Video]'
        WHEN 'FILE'      THEN '[File]'
        WHEN 'AUDIO'     THEN '[Voice message]'
      END,
    "lastMessageSenderId" = "latest"."creator",
    "lastMessageAt"       = "latest"."createdAt"
FROM "latest"
WHERE "latest"."threadId" = "MessageThread"."id";
