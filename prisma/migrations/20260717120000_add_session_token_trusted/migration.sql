-- Trusted-device flag: a device that stores its session token in OS secure storage may hold a
-- permanent (revocation-only) token. Lifetime is now driven by `trusted` instead of `client`:
-- trusted → expiresAt NULL; untrusted → sliding 14-day deadline (unchanged for web/desktop).
ALTER TABLE "SessionToken" ADD COLUMN "trusted" BOOLEAN NOT NULL DEFAULT false;

-- Existing `app` (native) rows already have expiresAt IS NULL (permanent); mark them trusted so the
-- new lifetime rule describes them correctly. No lifetime change for any row.
UPDATE "SessionToken" SET "trusted" = true WHERE "client" = 'app';
