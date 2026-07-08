-- Message.originSeq: per-(threadId, creator) monotonic sequence — the cross-server federation pull
-- cursor (Step 2). The SENDER allocates MAX(originSeq)+1 on insert; the RECEIVER copies the sender's
-- value verbatim when it pulls, so the SAME value lives on both servers and serves as the stable
-- cross-server cursor (the per-server Message.id cannot, since each server assigns its own).
--
-- Nullable: legacy rows (pre-Step-2) and messages in threads that never federate stay NULL. Postgres
-- treats NULLs as distinct under a unique index, so they coexist with no backfill — new inserts always
-- assign a seq, old rows keep NULL harmlessly.

ALTER TABLE "Message" ADD COLUMN "originSeq" INTEGER;

-- The compound unique index does TWO jobs:
--   (a) sender allocation correctness — a concurrent same-user send race (two devices at once) reads
--       the same MAX and is caught here as a unique violation → the caller retries the tx;
--   (b) receiver-side idempotent dedup — pulling the same message twice (push/pull race) inserts the
--       same (threadId, creator, originSeq) and is absorbed as a no-op.
CREATE UNIQUE INDEX "Message_threadId_creator_originSeq_key"
  ON "Message" ("threadId", "creator", "originSeq");

-- Backs both the federation pull query (WHERE originSeq > $after ORDER BY originSeq) and the
-- receiver's derived cursor MAX(originSeq) WHERE threadId = T AND creator = stub.
CREATE INDEX "Message_threadId_creator_originSeq_idx"
  ON "Message" ("threadId", "creator", "originSeq");
