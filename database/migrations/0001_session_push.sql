ALTER TABLE "SessionToken"
  ADD COLUMN "pushSubscriptionRev" integer NOT NULL DEFAULT 1,
  ADD COLUMN "pushToken" varchar(512),
  ADD COLUMN "pushPlatform" "PushPlatform",
  ADD COLUMN "pushDeviceId" varchar(127),
  ADD COLUMN "pushP256dh" varchar(255),
  ADD COLUMN "pushAuth" varchar(255),
  ADD COLUMN "pushRegisteredAt" timestamptz(3),
  ADD CONSTRAINT "SessionToken_pushSubscriptionRev_check" CHECK ("pushSubscriptionRev" > 0),
  ADD CONSTRAINT "SessionToken_push_shape_check" CHECK (
    ("pushToken" IS NULL AND "pushPlatform" IS NULL AND "pushP256dh" IS NULL AND "pushAuth" IS NULL AND "pushRegisteredAt" IS NULL)
    OR ("pushToken" IS NOT NULL AND "pushPlatform" IS NOT NULL AND "pushRegisteredAt" IS NOT NULL AND (
      ("pushPlatform" = 'WEB' AND "pushP256dh" IS NOT NULL AND "pushAuth" IS NOT NULL)
      OR ("pushPlatform" <> 'WEB' AND "pushP256dh" IS NULL AND "pushAuth" IS NULL)
    ))
  );
-- A partial unique index enforces installation ownership without making the
-- mutable token a referenced-key candidate for PostgreSQL row locking.
CREATE UNIQUE INDEX "SessionToken_pushToken_key" ON "SessionToken" ("pushToken") WHERE "pushToken" IS NOT NULL;

-- Old registrations are deliberately discarded. HELLO revision 1 establishes
-- a fresh registration for each authenticated session with the new protocol.
DROP TABLE "PushToken";
