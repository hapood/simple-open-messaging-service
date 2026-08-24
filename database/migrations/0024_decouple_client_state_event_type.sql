-- Client-only compacted heads evolve independently from the peer federation protocol.
-- Keeping this column on PeerStateEventType made a valid INCOMING_INVITE_HEAD key fail during
-- parameter coercion before it could even be queried or inserted.
ALTER TABLE "ClientStateFeed"
  ALTER COLUMN "eventType" TYPE varchar(31)
  USING "eventType"::text;
