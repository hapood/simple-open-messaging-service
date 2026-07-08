-- MediaMessage: per-object media authorization index.
-- The /uploads/shards/* gate answers "may this user read this digest?" with one indexed EXISTS over
-- this table joined to ThreadParticipant (membership). Written atomically at send time for every
-- IMAGE/FILE/VIDEO/AUDIO message — one row per distinct digest the message content references.
-- threadId is denormalized from Message so the gate avoids a JOIN to Message on the hot path.
--
-- This closes the cross-tenant read gap: previously any authenticated user could read any other
-- user's/group's media if they knew the (sha256-derived, hence predictable) URL. Now a digest is
-- readable only by an active participant (leftAt IS NULL) of a thread that contains it.

CREATE TABLE "MediaMessage" (
    "id" BIGSERIAL NOT NULL,
    "messageId" BIGINT NOT NULL,
    "threadId" INTEGER NOT NULL,
    "digest" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaMessage_pkey" PRIMARY KEY ("id")
);

-- One row per (message, digest): a message referencing the same digest twice (album duplicate)
-- collapses to one authz row; the unique constraint makes createMany idempotent.
CREATE UNIQUE INDEX "MediaMessage_messageId_digest_key" ON "MediaMessage"("messageId", "digest");

CREATE INDEX "MediaMessage_digest_idx" ON "MediaMessage"("digest");
CREATE INDEX "MediaMessage_messageId_idx" ON "MediaMessage"("messageId");
CREATE INDEX "MediaMessage_threadId_idx" ON "MediaMessage"("threadId");

ALTER TABLE "MediaMessage"
    ADD CONSTRAINT "MediaMessage_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MediaMessage"
    ADD CONSTRAINT "MediaMessage_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
