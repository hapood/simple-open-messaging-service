ALTER TABLE "FederatedPeer"
  ADD COLUMN "rootPublicKey" varchar(44),
  ADD COLUMN "recognizesPeer" boolean DEFAULT false NOT NULL,
  ADD COLUMN "outboundRecognitionConfirmed" boolean DEFAULT false NOT NULL,
  ADD COLUMN "inboundRecognitionConfirmed" boolean DEFAULT false NOT NULL,
  ADD COLUMN "lightweightInboundReady" boolean DEFAULT false NOT NULL,
  ADD COLUMN "localServiceAvailable" boolean DEFAULT false NOT NULL,
  ADD COLUMN "remoteServiceReachable" boolean DEFAULT false NOT NULL,
  ADD COLUMN "reverseRecognitionPending" boolean DEFAULT false NOT NULL,
  ADD COLUMN "outboundRecognizedAt" timestamp(3),
  ADD COLUMN "inboundRecognizedAt" timestamp(3),
  ADD COLUMN "haltedAt" timestamp(3),
  ADD COLUMN "haltCode" integer,
  ADD COLUMN "haltReason" varchar(255),
  ADD COLUMN "resetInProgress" boolean DEFAULT false NOT NULL;

ALTER TABLE "FederatedPeer" DROP CONSTRAINT "FederatedPeer_trustLevel_check";

UPDATE "FederatedPeer"
SET "haltedAt" = COALESCE("blockedAt", "identityLostAt", CURRENT_TIMESTAMP),
    "haltCode" = CASE
      WHEN "trustLevel" = 'blocked' THEN 50009
      WHEN "trustLevel" = 'identity_lost' THEN 50015
      ELSE "haltCode"
    END,
    "haltReason" = CASE
      WHEN "trustLevel" = 'blocked' THEN COALESCE("demoteReason", 'blocked by local policy')
      WHEN "trustLevel" = 'identity_lost' THEN COALESCE("identityLostReason", 'pinned root identity mismatch')
      ELSE "haltReason"
    END
WHERE "trustLevel" IN ('blocked', 'identity_lost');

UPDATE "FederatedPeer"
SET "resetInProgress" = true,
    "haltedAt" = COALESCE("resetAt", CURRENT_TIMESTAMP),
    "haltReason" = COALESCE("haltReason", 'destructive reset in progress')
WHERE "trustLevel" = 'reset_in_progress';

UPDATE "FederatedPeer" peer
SET "rootPublicKey" = cache."publicKey",
    "recognizesPeer" = (peer."identityPinnedAt" IS NOT NULL),
    "trustLevel" = CASE
      WHEN peer."trustLevel" = 'pending' THEN 'unrecognized'
      WHEN peer."trustLevel" = 'trusted' THEN 'available'
      WHEN peer."trustLevel" = 'demoted' THEN 'degraded'
      WHEN peer."trustLevel" IN ('blocked', 'identity_lost') THEN 'halted'
      WHEN peer."trustLevel" = 'reset_in_progress' THEN 'halted'
      ELSE peer."trustLevel"
    END
FROM (
  SELECT domain, min("publicKey") AS "publicKey"
  FROM "S2SKeyCache"
  GROUP BY domain
  HAVING count(*) = 1
) cache
WHERE cache.domain = peer.domain;

UPDATE "FederatedPeer"
SET "trustLevel" = CASE
  WHEN "trustLevel" = 'pending' THEN 'unrecognized'
  WHEN "trustLevel" = 'trusted' THEN 'available'
  WHEN "trustLevel" = 'demoted' THEN 'degraded'
  WHEN "trustLevel" IN ('blocked', 'identity_lost') THEN 'halted'
  WHEN "trustLevel" = 'reset_in_progress' THEN 'halted'
  ELSE "trustLevel"
END
WHERE "trustLevel" IN ('pending', 'trusted', 'demoted', 'blocked', 'identity_lost', 'reset_in_progress');

ALTER TABLE "FederatedPeer" ADD CONSTRAINT "FederatedPeer_trustLevel_check" CHECK (
  "trustLevel" IN (
    'unrecognized', 'establishing', 'available', 'degraded', 'halted'
  )
);
ALTER TABLE "FederatedPeer" ALTER COLUMN "trustLevel" SET DEFAULT 'unrecognized';
DROP INDEX "FederatedPeer_single_reset_in_progress_key";
CREATE UNIQUE INDEX "FederatedPeer_single_reset_in_progress_key"
  ON "FederatedPeer" ((true))
  WHERE "resetInProgress" = true;
ALTER TABLE "FederatedPeer"
  DROP COLUMN "pairwiseServerId",
  DROP COLUMN "blockedAt",
  DROP COLUMN "identityLostAt",
  DROP COLUMN "identityLostReason";

DROP TABLE "S2SIdentityNonce";
TRUNCATE TABLE "S2SKeyCache";
ALTER TABLE "S2SKeyCache"
  ADD COLUMN "notBefore" timestamp(3) NOT NULL,
  ADD COLUMN "notAfter" timestamp(3) NOT NULL,
  ADD COLUMN "authorizationSignature" varchar(127) NOT NULL;
