-- Single-use admin login challenge tracker. Closes the WebAuthn assertion-replay window for counter=0
-- authenticators (platform passkeys): a row keyed by the challenge JWT's jti is minted at login and
-- flipped to consumed on the first successful second-factor verify; a second/cross-factor consume is
-- rejected. Greenfield: no data migration.
CREATE TABLE "AdminLoginChallenge" (
    "jti"        VARCHAR(36) NOT NULL,
    "adminId"    INTEGER     NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminLoginChallenge_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX "AdminLoginChallenge_createdAt_idx" ON "AdminLoginChallenge"("createdAt");

ALTER TABLE "AdminLoginChallenge" ADD CONSTRAINT "AdminLoginChallenge_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
