ALTER TABLE "FederatedPeer"
    ADD COLUMN "pairwiseServerId" VARCHAR(64),
    ADD COLUMN "rootKeyFingerprint" VARCHAR(80),
    ADD COLUMN "identityEpoch" INTEGER,
    ADD COLUMN "identityPinnedAt" TIMESTAMP(3),
    ADD COLUMN "identityLostAt" TIMESTAMP(3),
    ADD COLUMN "identityLostReason" VARCHAR(255),
    ADD COLUMN "resetGeneration" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "resetAt" TIMESTAMP(3),
    ADD CONSTRAINT "FederatedPeer_identityEpoch_check"
      CHECK ("identityEpoch" IS NULL OR "identityEpoch" > 0);

CREATE TABLE "S2SIdentityNonce" (
    "originDomain" VARCHAR(63) NOT NULL,
    "nonceHash" VARCHAR(64) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "S2SIdentityNonce_pkey" PRIMARY KEY ("originDomain", "nonceHash")
);

CREATE INDEX "S2SIdentityNonce_expiresAt_idx"
    ON "S2SIdentityNonce" USING BTREE ("expiresAt");
