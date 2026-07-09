-- Federation Step 3: cross-server groups. Add the federated thread id + origin domain to MessageThread.
--   federatedThreadId — "thr_<rand>@<origin-domain>", minted at the origin on group create. NULL for
--     purely-local threads (all P2P, local-only groups). Unique (multiple NULLs allowed — Postgres
--     treats NULLs as distinct in a unique index, so local threads coexist).
--   originDomain — the origin server's domain, denormalized from the id's @suffix. NULL iff
--     federatedThreadId is NULL. Used for the roster-op / serving-leg signer check.
-- No backfill: all existing rows stay NULL. See docs/federation-step3-design.md §3.
ALTER TABLE "MessageThread" ADD COLUMN "federatedThreadId" TEXT;
ALTER TABLE "MessageThread" ADD COLUMN "originDomain" VARCHAR(255);
CREATE UNIQUE INDEX "MessageThread_federatedThreadId_key" ON "MessageThread"("federatedThreadId");
