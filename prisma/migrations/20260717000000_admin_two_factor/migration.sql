-- Admin TOTP two-factor authentication (RFC 6238). Opt-in per admin. The secret is stored
-- AES-256-GCM encrypted (twoFactorSecretCipher), never plaintext. twoFactorLastUsedCounter is the
-- highest accepted TOTP step (replay guard, RFC 6238 §5.2). All default to 2FA-off so existing admins
-- keep logging in with password only until they enroll.
ALTER TABLE "Admin" ADD COLUMN "twoFactorEnabled"         BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE "Admin" ADD COLUMN "twoFactorSecretCipher"    VARCHAR(255);
ALTER TABLE "Admin" ADD COLUMN "twoFactorEnabledAt"       TIMESTAMP(3);
ALTER TABLE "Admin" ADD COLUMN "twoFactorLastUsedCounter" INTEGER;

-- Single-use argon2-hashed backup (recovery) codes — the lockout escape hatch when an admin loses their
-- authenticator. Single-use is enforced at consume time via an updateMany(consumedAt IS NULL) guard.
CREATE TABLE "TwoFactorBackupCode" (
    "id"         BIGSERIAL NOT NULL,
    "adminId"    INTEGER   NOT NULL,
    "codeHash"   VARCHAR(127) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TwoFactorBackupCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TwoFactorBackupCode_adminId_idx" ON "TwoFactorBackupCode"("adminId");

ALTER TABLE "TwoFactorBackupCode" ADD CONSTRAINT "TwoFactorBackupCode_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
