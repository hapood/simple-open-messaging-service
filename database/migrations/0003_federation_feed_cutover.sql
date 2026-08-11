-- Complete the S2S cut-over: old per-peer DiscoveryChange history is intentionally truncated once.
-- The durable degradation marker is returned by every later feed page so the subscriber can surface
-- that continuity was reduced. Local-client DiscoveryChange rows are untouched.

ALTER TABLE "FederationServeCursor"
  ADD COLUMN "degradedAt" TIMESTAMP(3),
  ADD COLUMN "degradedThrough" BIGINT,
  ADD COLUMN "degradationReason" VARCHAR(64);

ALTER TABLE "FederationServeCursor"
  ADD CONSTRAINT "FederationServeCursor_degradation_check" CHECK (
    ("degradedAt" IS NULL AND "degradedThrough" IS NULL AND "degradationReason" IS NULL)
    OR
    ("degradedAt" IS NOT NULL AND "degradedThrough" IS NOT NULL
      AND "degradedThrough" >= 0 AND "degradationReason" = 'HISTORY_TRUNCATED')
  );

UPDATE "FederationServeCursor" cursor
SET "startChangeId" = target."allocatedThrough",
    "acknowledgedThrough" = target."allocatedThrough",
    "lastServedThrough" = target."allocatedThrough",
    "degradedAt" = CURRENT_TIMESTAMP,
    "degradedThrough" = target."allocatedThrough",
    "degradationReason" = 'HISTORY_TRUNCATED',
    "updatedAt" = CURRENT_TIMESTAMP
FROM "DiscoveryTarget" target
WHERE target.id = cursor."targetId";

DELETE FROM "DiscoveryChange" change
USING "DiscoveryTarget" target
WHERE target.id = change."targetId"
  AND target."targetDomain" <> 'local';

CREATE FUNCTION soms_notify_federation_message_committed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."contentType" <> 'SYSTEM' THEN
    PERFORM pg_notify(
      'soms_federation_message_committed',
      json_build_object('threadId', NEW."threadId", 'seq', NEW.seq)::text
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Message_federation_feed_notify"
AFTER INSERT ON "Message"
FOR EACH ROW
EXECUTE FUNCTION soms_notify_federation_message_committed();
