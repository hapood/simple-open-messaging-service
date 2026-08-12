ALTER TABLE "FederatedPeer"
  RENAME COLUMN "demotedAt" TO "degradedAt";

ALTER TABLE "FederatedPeer"
  RENAME COLUMN "demoteReason" TO "degradationReason";

ALTER TABLE "FederatedPeer"
  RENAME COLUMN "demotionCount" TO "degradationCount";

UPDATE "FederatedPeerEvent"
SET type = 'degraded'
WHERE type = 'demoted';
