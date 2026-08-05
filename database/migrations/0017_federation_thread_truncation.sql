ALTER TABLE "MessageThread"
  ADD COLUMN "federationTruncated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "federationVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "MessageThread_federationVersion_check"
    CHECK ("federationVersion" >= 0);

COMMENT ON COLUMN "MessageThread"."federationTruncated" IS
  'True after federation reset has removed the thread contents while retaining its identity shell.';

COMMENT ON COLUMN "MessageThread"."federationVersion" IS
  'Incremented when federation truncation completes; stale asynchronous responses must not write across versions.';

CREATE UNIQUE INDEX "FederatedPeer_single_reset_in_progress_key"
  ON "FederatedPeer" ((true))
  WHERE "trustLevel" = 'reset_in_progress';
