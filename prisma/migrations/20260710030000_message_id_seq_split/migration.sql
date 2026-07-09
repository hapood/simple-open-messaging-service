-- Split Message's identity into a global internal `id` (BigInt PK, kept) and a per-thread external `seq`
-- (NEW Int). Motivation: a global autoincrement exposed to clients/federation is a cross-conversation
-- throughput side-channel — deltas between two messages in thread T leak server-wide volume (including
-- threads the observer is not in). `id` now stays internal (surrogate PK + MediaMessage FK target,
-- never serialized); `seq` is the per-thread monotonic value returned to the frontend + federation, so
-- its deltas reveal only THIS thread's activity. `seq` is allocated from MessageThread.curSeq; originSeq
-- becomes the origin server's per-thread seq (== seq locally, copied verbatim by a receiver) — the
-- federation dedup key + per-(thread,sender) pull cursor (no cross-server consistency required).
--
-- MediaMessage becomes 1:1 with a media-bearing Message (one message = one image/file/video/audio;
-- albums are a FRONTEND grouping of consecutive single-image messages): its surrogate id is dropped and
-- messageId (the Message.id FK) becomes the sole PK. The FK to Message.id is UNCHANGED (id is kept, so
-- MediaMessage_messageId_fkey stays valid — it is NOT recreated here).
--
-- Backfills preserve data: seq is numbered 0-indexed per thread by (createdAt, id); curSeq = MAX(seq);
-- lastMessageSeq / lastReadSeq are converted from the old BigInt message ids to the matching per-thread seq.

-- ── 1. Message.seq: add (nullable → backfill → NOT NULL) ─────────────────────────────────────────
ALTER TABLE "Message" ADD COLUMN "seq" INTEGER;

-- Per-thread 0-indexed seq in arrival order (createdAt, id). id is the tiebreaker (unique, monotonic
-- with insert) so the order is deterministic and matches the order curSeq would have allocated in.
WITH ranked AS (
  SELECT "id", (ROW_NUMBER() OVER (PARTITION BY "threadId" ORDER BY "createdAt", "id") - 1) AS "newSeq"
  FROM "Message"
)
UPDATE "Message" m SET "seq" = ranked."newSeq"
FROM ranked
WHERE m."id" = ranked."id";

ALTER TABLE "Message" ALTER COLUMN "seq" SET NOT NULL;

-- Post-migration every local-authored row has originSeq == seq (the federation value). Normalize legacy
-- NULLs (per-(thread,creator) or never-federated rows) to the new model. NULLs are still tolerated by
-- the unique index (Postgres treats them as distinct) for any row the WHERE misses.
UPDATE "Message" SET "originSeq" = "seq" WHERE "originSeq" IS NULL;

-- Per-thread seq uniqueness (allocation authority + keyset cursor identity). Also serves the hot
-- history-pagination path, so the old (threadId, id) index is dropped as a now-orphan.
CREATE UNIQUE INDEX "Message_threadId_seq_key" ON "Message"("threadId", "seq");
DROP INDEX "Message_threadId_id_idx";

-- ── 2. MessageThread.curSeq: the per-thread allocation counter (-1 = no messages) ─────────────────
ALTER TABLE "MessageThread" ADD COLUMN "curSeq" INTEGER NOT NULL DEFAULT -1;
UPDATE "MessageThread" t SET "curSeq" = COALESCE(
  (SELECT MAX(m."seq") FROM "Message" m WHERE m."threadId" = t."id"), -1
);

-- ── 3. MessageThread.lastMessageId BigInt → lastMessageSeq Int (per-thread seq watermark) ─────────
ALTER TABLE "MessageThread" RENAME COLUMN "lastMessageId" TO "lastMessageSeq";
-- Convert the denormalized id pointer to the same message's per-thread seq (NULL stays NULL: empty thread).
UPDATE "MessageThread" t SET "lastMessageSeq" = (
  SELECT m."seq" FROM "Message" m WHERE m."id" = t."lastMessageSeq"
) WHERE t."lastMessageSeq" IS NOT NULL;
ALTER TABLE "MessageThread" ALTER COLUMN "lastMessageSeq" TYPE INTEGER USING "lastMessageSeq"::integer;

-- ── 4. ThreadParticipant.lastReadMsgId BigInt → lastReadSeq Int (per-thread read watermark) ────────
ALTER TABLE "ThreadParticipant" RENAME COLUMN "lastReadMsgId" TO "lastReadSeq";
UPDATE "ThreadParticipant" tp SET "lastReadSeq" = (
  SELECT m."seq" FROM "Message" m WHERE m."id" = tp."lastReadSeq"
) WHERE tp."lastReadSeq" IS NOT NULL;
ALTER TABLE "ThreadParticipant" ALTER COLUMN "lastReadSeq" TYPE INTEGER USING "lastReadSeq"::integer;

-- ── 5. MediaMessage: drop surrogate id, make the Message.id FK the sole PK (1:1) ──────────────────
-- The FK MediaMessage_messageId_fkey → Message(id) is UNCHANGED (Message.id is kept above), so it is
-- not touched here. Only the surrogate-id PK, the composite unique, and the now-redundant messageId
-- index go away; messageId itself becomes the primary key.
ALTER TABLE "MediaMessage" DROP CONSTRAINT "MediaMessage_pkey";
ALTER TABLE "MediaMessage" DROP COLUMN "id";
DROP INDEX "MediaMessage_messageId_digest_key";
DROP INDEX "MediaMessage_messageId_idx";
ALTER TABLE "MediaMessage" ADD CONSTRAINT "MediaMessage_pkey" PRIMARY KEY ("messageId");
