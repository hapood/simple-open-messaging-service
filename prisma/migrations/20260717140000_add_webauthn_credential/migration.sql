-- Admin WebAuthn (passkey) second factor. Adds Admin.webauthnEnabled (a denormalized "≥1 credential
-- exists" hint for the login branch + status card; the credential rows are the source of truth) and the
-- WebAuthnCredential table. credentialId + publicKey are PUBLIC authenticator values, so no at-rest
-- encryption (contrast TwoFactorBackupCode's HMAC and Admin.twoFactorSecretCipher's AES-GCM).
-- Greenfield: no data migration (no credentials exist yet).

ALTER TABLE "Admin" ADD COLUMN "webauthnEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "WebAuthnCredential" (
    "id"            BIGSERIAL    NOT NULL,
    "adminId"       INTEGER      NOT NULL,
    "credentialId"  VARCHAR(510) NOT NULL,
    "publicKey"     BYTEA        NOT NULL,
    "counter"       INTEGER      NOT NULL DEFAULT 0,
    "transports"    TEXT,
    "deviceType"    VARCHAR(32),
    "backed"        BOOLEAN      NOT NULL DEFAULT false,
    "nickname"      VARCHAR(64),
    "lastUsedAt"    TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");
CREATE INDEX "WebAuthnCredential_adminId_idx" ON "WebAuthnCredential"("adminId");

ALTER TABLE "WebAuthnCredential" ADD CONSTRAINT "WebAuthnCredential_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
