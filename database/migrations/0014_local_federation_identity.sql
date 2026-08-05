CREATE TABLE "LocalFederationIdentity" (
    "domain" VARCHAR(63) PRIMARY KEY,
    "identityEpoch" INTEGER NOT NULL DEFAULT 1,
    "rootKeyFingerprint" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LocalFederationIdentity_identityEpoch_check" CHECK ("identityEpoch" > 0)
);
