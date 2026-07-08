-- Step 1 simplification: synchronous inline S2S delivery (no outbox/worker), and each server owns
-- its own 1:1 thread (no shared federated thread id). Drop the now-unused federation machinery; it
-- is revived only when Step 2/3 (messages / federated groups) needs durable retry or a shared thread
-- identity. See docs/federation-protocol.md (Step 1 scope notes).
DROP TABLE "S2SOutbox";
DROP INDEX "MessageThread_federatedId_key";
ALTER TABLE "MessageThread" DROP COLUMN "origin";
ALTER TABLE "MessageThread" DROP COLUMN "federatedId";
