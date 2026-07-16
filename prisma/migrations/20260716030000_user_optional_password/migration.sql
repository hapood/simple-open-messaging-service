-- hashPwd is now optional. An admin-provisioned OTP/QR-only account (loginMode APP_OTP_AND_QR) is created
-- with NO password — it bootstraps via the one-time login code the admin issues instead. Existing rows keep
-- their hash; only the NOT NULL constraint is dropped (additive, backward-compatible).
ALTER TABLE "User" ALTER COLUMN "hashPwd" DROP NOT NULL;
