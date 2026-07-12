-- Admin-managed runtime settings KV store (typed facade: src/settings/settings.service.ts).
-- Holds operator-configured values that are optional, runtime-toggleable, and UI-managed (e.g. the Web
-- Push VAPID keypair, key='vapid'). NOT for bootstrap/identity config (DATABASE_URL, SOMS_DOMAIN) —
-- those stay in env. The VAPID private key lives here in plaintext: the DB is already the trust root
-- (password hashes, refresh-token hashes, per-device push keys), and a VAPID-key compromise only lets an
-- attacker SEND pushes to existing subscribers, not decrypt payloads (RFC 8291 ECDH uses each
-- subscriber's p256dh/auth, not the VAPID key). Rotation breaks subscriptions → clients re-subscribe.
CREATE TABLE "SystemSetting" (
    "key"       VARCHAR(63) PRIMARY KEY,
    "value"     TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
