-- ThreadAudience can be staged before the corresponding FederatedPeer row during bootstrap/tests.
-- Defer epoch creation in that ordering and backfill it when the peer anchor appears.

CREATE OR REPLACE FUNCTION soms_sync_federation_audience_epoch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_seq INTEGER;
  target_domain VARCHAR(63);
  new_epoch_id BIGINT;
BEGIN
  target_domain := CASE WHEN TG_OP = 'DELETE' THEN OLD."targetDomain" ELSE NEW."targetDomain" END;
  IF target_domain = 'local' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "FederatedPeer" WHERE domain = target_domain) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT thread."curSeq" INTO current_seq
  FROM "MessageThread" thread
  WHERE thread.id = CASE WHEN TG_OP = 'DELETE' THEN OLD."threadId" ELSE NEW."threadId" END;

  IF TG_OP = 'INSERT' AND NEW."deliverThroughChangeId" IS NULL THEN
    INSERT INTO "FederationAudienceEpoch" ("peerDomain", "threadId", "fromSeq")
    VALUES (NEW."targetDomain", NEW."threadId", current_seq + 1)
    ON CONFLICT DO NOTHING
    RETURNING id INTO new_epoch_id;
  ELSIF TG_OP = 'UPDATE'
    AND OLD."deliverThroughChangeId" IS NULL
    AND NEW."deliverThroughChangeId" IS NOT NULL THEN
    UPDATE "FederationAudienceEpoch"
    SET "throughSeq" = current_seq,
        "closedAt" = CURRENT_TIMESTAMP
    WHERE "peerDomain" = NEW."targetDomain"
      AND "threadId" = NEW."threadId"
      AND "throughSeq" IS NULL;
  ELSIF TG_OP = 'UPDATE'
    AND OLD."deliverThroughChangeId" IS NOT NULL
    AND NEW."deliverThroughChangeId" IS NULL THEN
    INSERT INTO "FederationAudienceEpoch" ("peerDomain", "threadId", "fromSeq")
    VALUES (NEW."targetDomain", NEW."threadId", current_seq + 1)
    RETURNING id INTO new_epoch_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "FederationAudienceEpoch"
    SET "throughSeq" = current_seq,
        "closedAt" = CURRENT_TIMESTAMP
    WHERE "peerDomain" = OLD."targetDomain"
      AND "threadId" = OLD."threadId"
      AND "throughSeq" IS NULL;
  END IF;

  IF new_epoch_id IS NOT NULL THEN
    INSERT INTO "FederationThreadCheckpoint" ("epochId", "acknowledgedSeq")
    SELECT id, "fromSeq" - 1
    FROM "FederationAudienceEpoch"
    WHERE id = new_epoch_id;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION soms_seed_federation_audience_epochs_for_peer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  WITH inserted AS (
    INSERT INTO "FederationAudienceEpoch" ("peerDomain", "threadId", "fromSeq")
    SELECT NEW.domain, audience."threadId", thread."curSeq" + 1
    FROM "ThreadAudience" audience
    JOIN "MessageThread" thread ON thread.id = audience."threadId"
    WHERE audience."targetDomain" = NEW.domain
      AND audience."deliverThroughChangeId" IS NULL
    ON CONFLICT DO NOTHING
    RETURNING id, "fromSeq"
  )
  INSERT INTO "FederationThreadCheckpoint" ("epochId", "acknowledgedSeq")
  SELECT id, "fromSeq" - 1 FROM inserted
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "FederatedPeer_audience_epoch_seed"
AFTER INSERT ON "FederatedPeer"
FOR EACH ROW
EXECUTE FUNCTION soms_seed_federation_audience_epochs_for_peer();
