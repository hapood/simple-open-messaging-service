-- Federated peer trust-lifecycle: extend FederatedPeer with audit columns and add an append-only
-- event log (FederatedPeerEvent) that records every state transition, so the admin can see the full
-- trust → connection-loss process as a timeline. See docs/federation-protocol.md (trust lifecycle).
--
-- trustLevel state machine: pending → trusted → demoted (failed signed op; re-handshakes on next
-- contact, self-healing) → trusted…, plus `blocked` (admin intent; federation refused).

-- Drop the old "last trust establishment" column; trustedAt (trust epoch) + lastSuccessAt (per-op
-- liveness) strictly supersede it.
ALTER TABLE "FederatedPeer" DROP COLUMN "lastSeenAt";

ALTER TABLE "FederatedPeer" ADD COLUMN "trustedAt"     TIMESTAMP(3);
ALTER TABLE "FederatedPeer" ADD COLUMN "lastSuccessAt" TIMESTAMP(3);
ALTER TABLE "FederatedPeer" ADD COLUMN "demotedAt"     TIMESTAMP(3);
ALTER TABLE "FederatedPeer" ADD COLUMN "demoteReason"  VARCHAR(255);
ALTER TABLE "FederatedPeer" ADD COLUMN "demotionCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FederatedPeer" ADD COLUMN "blockedAt"     TIMESTAMP(3);

CREATE INDEX "FederatedPeer_lastSuccessAt_idx" ON "FederatedPeer"("lastSuccessAt");

-- Append-only transition log. Decoupled from FederatedPeer (no FK) so history survives peer-row
-- state changes; `domain` is a plain indexed string.
CREATE TABLE "FederatedPeerEvent" (
    "id"        BIGSERIAL    NOT NULL,
    "domain"    VARCHAR(63)  NOT NULL,
    "type"      VARCHAR(15)  NOT NULL,
    "reason"    VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederatedPeerEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FederatedPeerEvent_domain_createdAt_idx" ON "FederatedPeerEvent"("domain", "createdAt");
CREATE INDEX "FederatedPeerEvent_createdAt_idx"        ON "FederatedPeerEvent"("createdAt");

-- Backfill the lifecycle for peers that were already trusted before this migration: treat the current
-- trust as a trust epoch starting at createdAt, so the admin timeline isn't empty for pre-existing peers.
UPDATE "FederatedPeer"
   SET "trustedAt" = "createdAt", "lastSuccessAt" = "createdAt"
 WHERE "trustLevel" = 'trusted' AND "trustedAt" IS NULL;

INSERT INTO "FederatedPeerEvent" ("domain", "type", "createdAt")
SELECT "domain", 'discovered', "createdAt" FROM "FederatedPeer";

INSERT INTO "FederatedPeerEvent" ("domain", "type", "createdAt")
SELECT "domain", 'trusted', "createdAt" FROM "FederatedPeer" WHERE "trustLevel" = 'trusted';
