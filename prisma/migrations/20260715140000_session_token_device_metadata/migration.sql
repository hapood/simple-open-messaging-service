-- SessionToken: persist the client kind (app|web|desktop) for the device list, plus the most-recent
-- IP (updated on the throttled sliding touch). Mirrors industry session views (GitHub/Telegram/Slack).
ALTER TABLE "SessionToken" ADD COLUMN "client" VARCHAR(16) NOT NULL DEFAULT 'web';
ALTER TABLE "SessionToken" ADD COLUMN "lastSeenIp" VARCHAR(64);

-- Backfill `client` from existing rows: a no-expiry row (expiresAt IS NULL) was issued to the native
-- app; an expiring row was issued to web/desktop. Rows created before this migration carry no other
-- signal, so expiresAt nullness is the only discriminator.
UPDATE "SessionToken" SET "client" = 'app' WHERE "expiresAt" IS NULL;
