ALTER TABLE "FederationPullCursor"
  ADD COLUMN "startChangeId" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "FederationPullCursor"
  DROP CONSTRAINT "FederationPullCursor_remoteHwm_check",
  DROP CONSTRAINT "FederationPullCursor_lastAdvertisedHwm_check",
  ADD CONSTRAINT "FederationPullCursor_startChangeId_check" CHECK ("startChangeId" >= 0),
  ADD CONSTRAINT "FederationPullCursor_remoteHwm_check" CHECK ("remoteHwm" >= "startChangeId"),
  ADD CONSTRAINT "FederationPullCursor_lastAdvertisedHwm_check"
    CHECK ("lastAdvertisedHwm" >= "startChangeId");

CREATE TABLE "FederationServeCursor" (
  "peerDomain" VARCHAR(63) PRIMARY KEY,
  "targetId" BIGINT NOT NULL,
  "startChangeId" BIGINT NOT NULL,
  "acknowledgedThrough" BIGINT NOT NULL,
  "lastServedThrough" BIGINT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FederationServeCursor_startChangeId_check" CHECK ("startChangeId" >= 0),
  CONSTRAINT "FederationServeCursor_acknowledgedThrough_check"
    CHECK ("acknowledgedThrough" >= "startChangeId"),
  CONSTRAINT "FederationServeCursor_lastServedThrough_check"
    CHECK ("lastServedThrough" >= "acknowledgedThrough"),
  CONSTRAINT "FederationServeCursor_peerDomain_fkey"
    FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederationServeCursor_targetId_fkey"
    FOREIGN KEY ("targetId") REFERENCES "DiscoveryTarget"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "FederationServeCursor_targetId_key"
  ON "FederationServeCursor" ("targetId");
