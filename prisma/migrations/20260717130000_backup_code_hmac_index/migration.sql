-- Backup codes switched from argon2-hashed (slow KDF + 10× verify loop) to HMAC-SHA256 keyed by the 2FA
-- at-rest key: a deterministic blind that enables an O(1) indexed consume lookup and means a DB leak
-- alone cannot recover any code. codeHash now holds a 43-char base64url HMAC, so the column is tightened
-- to VARCHAR(64); the adminId-only index is replaced by a composite (adminId, codeHash) index so the
-- consume query (WHERE adminId AND codeHash AND consumedAt IS NULL) is a single indexed point lookup.
--
-- No data migration: the table holds only unreleased-feature enrollments and is treated as greenfield
-- (stale argon2 hashes, if any, are dropped rather than converted — they cannot be converted without the
-- plaintext, which is never stored).

DROP INDEX IF EXISTS "TwoFactorBackupCode_adminId_idx";

CREATE INDEX "TwoFactorBackupCode_adminId_codeHash_idx"
  ON "TwoFactorBackupCode"("adminId", "codeHash");

ALTER TABLE "TwoFactorBackupCode" ALTER COLUMN "codeHash" TYPE VARCHAR(64);
