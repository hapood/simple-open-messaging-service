-- Federation (S2S) tables + MessageThread federation columns.
-- See docs/federation-protocol.md. Trust model: FederatedPeer is a domain allow-list only
-- (no key pinning); signing keys are fetched from each peer's /.well-known/soms over HTTPS.

-- MessageThread: who owns this thread's identity + sequence. "local" = this server.
ALTER TABLE "MessageThread" ADD COLUMN "origin" VARCHAR(63) NOT NULL DEFAULT 'local';
ALTER TABLE "MessageThread" ADD COLUMN "federatedId" VARCHAR(127);
CREATE UNIQUE INDEX "MessageThread_federatedId_key" ON "MessageThread"("federatedId") WHERE "federatedId" IS NOT NULL;

-- FederatedPeer: domain allow-list (trust data only — NOT keys, NOT inbox URL).
CREATE TABLE "FederatedPeer" (
    "domain" VARCHAR(63) NOT NULL,
    "trustLevel" VARCHAR(15) NOT NULL DEFAULT 'pending',
    "addedBy" VARCHAR(31),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "FederatedPeer_pkey" PRIMARY KEY ("domain")
);
CREATE INDEX "FederatedPeer_trustLevel_idx" ON "FederatedPeer"("trustLevel");

-- S2SKeyCache: cached peer signing keys (fetched from <domain>/.well-known/soms, TTL'd by fetchedAt).
CREATE TABLE "S2SKeyCache" (
    "domain" VARCHAR(63) NOT NULL,
    "keyId" VARCHAR(127) NOT NULL,
    "publicKey" VARCHAR(127) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "S2SKeyCache_pkey" PRIMARY KEY ("domain", "keyId")
);
CREATE INDEX "S2SKeyCache_domain_idx" ON "S2SKeyCache"("domain");

-- S2SOutbox: outbound delivery queue (durable; drained by S2SOutboxWorker with backoff).
CREATE TABLE "S2SOutbox" (
    "id" TEXT NOT NULL,
    "envelopeId" VARCHAR(127) NOT NULL,
    "envelopeType" VARCHAR(31) NOT NULL,
    "origin" VARCHAR(63) NOT NULL,
    "threadFederatedId" VARCHAR(127),
    "recipientDomain" VARCHAR(63) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(15) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lastError" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "S2SOutbox_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "S2SOutbox_status_nextRetryAt_idx" ON "S2SOutbox"("status", "nextRetryAt");
CREATE INDEX "S2SOutbox_recipientDomain_status_idx" ON "S2SOutbox"("recipientDomain", "status");
CREATE INDEX "S2SOutbox_threadFederatedId_recipientDomain_idx" ON "S2SOutbox"("threadFederatedId", "recipientDomain");

-- S2SInboxSeen: inbound dedup (at-least-once delivery → idempotent dedup by (origin, envelopeId)).
CREATE TABLE "S2SInboxSeen" (
    "origin" VARCHAR(63) NOT NULL,
    "envelopeId" VARCHAR(127) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "S2SInboxSeen_pkey" PRIMARY KEY ("origin", "envelopeId")
);
