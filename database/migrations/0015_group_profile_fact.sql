-- The stored GROUP_PROFILE fact widens the body shape check; the enum value
-- itself was added in 0014 (a same-transaction CHECK referencing a fresh
-- ALTER TYPE ADD VALUE value is unsafe in PostgreSQL).
ALTER TABLE "GroupMetaMemberFeed"
  DROP CONSTRAINT "GroupMetaMemberFeed_body_check";

ALTER TABLE "GroupMetaMemberFeed"
  ADD CONSTRAINT "GroupMetaMemberFeed_body_check" CHECK (
    jsonb_typeof("body") = 'object'
    AND (("operation" = 'UPSERT' AND "body" <> '{}'::jsonb)
      OR ("operation" = 'DEPART' AND "body" = '{}'::jsonb)
      OR ("operation" = 'GROUP_PROFILE' AND "body" <> '{}'::jsonb)));
