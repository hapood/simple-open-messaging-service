CREATE TABLE "FederatedPeerReset" (
  "domain" VARCHAR(63) PRIMARY KEY NOT NULL,
  "resetGeneration" INTEGER NOT NULL,
  "reinitPending" BOOLEAN NOT NULL DEFAULT false,
  "resetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederatedPeerReset_resetGeneration_check"
    CHECK ("resetGeneration" > 0)
);

COMMENT ON TABLE "FederatedPeerReset" IS
  'Persistent tombstone preventing a reset federation domain from inheriting its former identity or authorization.';
