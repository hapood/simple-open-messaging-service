-- Durable reconstruction metadata for the bounded in-memory S2S message feed.
-- Existing DiscoveryChange rows remain drainable during the rolling cut-over. New active epochs
-- start after the current thread tail, so pre-cut-over messages are never replayed with new ids.

CREATE TABLE "FederationAudienceEpoch" (
  "id" BIGSERIAL PRIMARY KEY,
  "peerDomain" VARCHAR(63) NOT NULL,
  "threadId" INTEGER NOT NULL,
  "fromSeq" INTEGER NOT NULL,
  "throughSeq" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "FederationAudienceEpoch_peerDomain_fkey"
    FOREIGN KEY ("peerDomain") REFERENCES "FederatedPeer"("domain") ON DELETE CASCADE,
  CONSTRAINT "FederationAudienceEpoch_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE,
  CONSTRAINT "FederationAudienceEpoch_fromSeq_check" CHECK ("fromSeq" >= 0),
  CONSTRAINT "FederationAudienceEpoch_range_check"
    CHECK ("throughSeq" IS NULL OR "throughSeq" >= "fromSeq" - 1)
);

CREATE UNIQUE INDEX "FederationAudienceEpoch_active_key"
  ON "FederationAudienceEpoch" ("peerDomain", "threadId")
  WHERE "throughSeq" IS NULL;

CREATE INDEX "FederationAudienceEpoch_peer_scan_idx"
  ON "FederationAudienceEpoch" ("peerDomain", "id");

CREATE TABLE "FederationThreadCheckpoint" (
  "epochId" BIGINT PRIMARY KEY,
  "acknowledgedSeq" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FederationThreadCheckpoint_epochId_fkey"
    FOREIGN KEY ("epochId") REFERENCES "FederationAudienceEpoch"("id") ON DELETE CASCADE,
  CONSTRAINT "FederationThreadCheckpoint_acknowledgedSeq_check"
    CHECK ("acknowledgedSeq" >= -1)
);

-- The current active audience begins at the first message written after this migration. Its older
-- unacknowledged messages are still represented by the legacy DiscoveryChange rows.
INSERT INTO "FederationAudienceEpoch" ("peerDomain", "threadId", "fromSeq")
SELECT audience."targetDomain", audience."threadId", thread."curSeq" + 1
FROM "ThreadAudience" audience
JOIN "MessageThread" thread ON thread.id = audience."threadId"
JOIN "FederatedPeer" peer ON peer.domain = audience."targetDomain"
WHERE audience."targetDomain" <> 'local'
  AND audience."deliverThroughChangeId" IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO "FederationThreadCheckpoint" ("epochId", "acknowledgedSeq")
SELECT epoch.id, epoch."fromSeq" - 1
FROM "FederationAudienceEpoch" epoch
ON CONFLICT DO NOTHING;

CREATE FUNCTION soms_sync_federation_audience_epoch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_seq INTEGER;
  new_epoch_id BIGINT;
BEGIN
  IF COALESCE(NEW."targetDomain", OLD."targetDomain") = 'local' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT thread."curSeq" INTO current_seq
  FROM "MessageThread" thread
  WHERE thread.id = COALESCE(NEW."threadId", OLD."threadId");

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
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "ThreadAudience_federation_epoch_sync"
AFTER INSERT OR UPDATE OF "deliverThroughChangeId" OR DELETE
ON "ThreadAudience"
FOR EACH ROW
EXECUTE FUNCTION soms_sync_federation_audience_epoch();
