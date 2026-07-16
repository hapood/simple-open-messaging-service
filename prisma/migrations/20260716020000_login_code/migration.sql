-- LoginCode: admin-issued one-time login codes for the Android long-term (app) session login method.
-- The code is argon2-hashed (codeHash); the plaintext is shown once at issue time and never stored.
-- producedSessionId links a consumed code to the SessionToken row it created (audit). Intentionally NOT a
-- foreign key — an audit row must outlive its session (and sessions are soft-revoked, never deleted).
CREATE TABLE "LoginCode" (
    "id" SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    "codeHash" VARCHAR(127) NOT NULL,
    "issuedBy" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedIp" VARCHAR(64),
    "consumedDevice" VARCHAR(127),
    "producedSessionId" INTEGER,
    "revokedAt" TIMESTAMP(3)
);

CREATE INDEX "LoginCode_userId_idx" ON "LoginCode"("userId");

ALTER TABLE "LoginCode" ADD CONSTRAINT "LoginCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
