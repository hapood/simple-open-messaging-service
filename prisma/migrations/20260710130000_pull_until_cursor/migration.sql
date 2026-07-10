-- Federation pull cursor (Step 3 Phase B): the REMOTE server's thread seq this server has pulled up to.
-- Seeded by the `sinceSeq` carried in invite/invite-accept; advanced to the response latestSeq after each
-- pull. Used by 1:1 (peer's thread seq) and a GROUP mirror (origin's thread seq) — the unified catch-up
-- cursor. -1 = nothing pulled yet (the head). See schema.prisma `MessageThread.pullUntil`.
ALTER TABLE "MessageThread" ADD COLUMN "pullUntil" INTEGER NOT NULL DEFAULT -1;
