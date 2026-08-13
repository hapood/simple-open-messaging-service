ALTER TABLE "FederatedMessageTombstone"
  ADD COLUMN "authorityDeletedAt" TIMESTAMP(3);

UPDATE "FederatedMessageTombstone"
SET "authorityDeletedAt" = "createdAt"
WHERE "authorityDeletedAt" IS NULL;

ALTER TABLE "FederatedMessageTombstone"
  ALTER COLUMN "authorityDeletedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "authorityDeletedAt" SET NOT NULL;

CREATE TABLE "FederationTombstoneServeCursor" (
  "peerDomain" VARCHAR(63) PRIMARY KEY REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  "startChangeId" BIGINT NOT NULL DEFAULT 0,
  "acknowledgedThrough" BIGINT NOT NULL DEFAULT 0,
  "lastServedThrough" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationTombstoneServeCursor_order_check"
    CHECK ("startChangeId" >= 0 AND "acknowledgedThrough" >= "startChangeId" AND "lastServedThrough" >= "acknowledgedThrough")
);

CREATE TABLE "FederationTombstonePullCursor" (
  "peerDomain" VARCHAR(63) PRIMARY KEY REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  "remoteHwm" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationTombstonePullCursor_remoteHwm_check" CHECK ("remoteHwm" >= 0)
);

CREATE TABLE "FederationTombstoneCheckpoint" (
  "epochId" BIGINT PRIMARY KEY REFERENCES "FederationAudienceEpoch"("id") ON DELETE CASCADE,
  "acknowledgedDeletedId" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationTombstoneCheckpoint_acknowledgedDeletedId_check"
    CHECK ("acknowledgedDeletedId" >= 0)
);

INSERT INTO "FederationTombstoneServeCursor" ("peerDomain")
SELECT domain FROM "FederatedPeer"
ON CONFLICT DO NOTHING;

INSERT INTO "FederationTombstonePullCursor" ("peerDomain")
SELECT domain FROM "FederatedPeer"
ON CONFLICT DO NOTHING;

INSERT INTO "FederationTombstoneCheckpoint" ("epochId")
SELECT id FROM "FederationAudienceEpoch"
ON CONFLICT DO NOTHING;

CREATE FUNCTION soms_sync_federation_tombstone_checkpoint()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO "FederationTombstoneCheckpoint" ("epochId") VALUES (NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FederationAudienceEpoch_tombstone_checkpoint"
AFTER INSERT ON "FederationAudienceEpoch"
FOR EACH ROW
EXECUTE FUNCTION soms_sync_federation_tombstone_checkpoint();
