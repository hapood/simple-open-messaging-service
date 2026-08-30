ALTER TABLE "ClientStateFeed" ADD COLUMN "compactionKey" text;

UPDATE "ClientStateFeed"
SET "compactionKey" = jsonb_build_array(
  "eventType", "namespaceId", account, domain, "subjectAccount", "subjectDomain"
)::text;

DELETE FROM "ClientStateFeed" older
USING "ClientStateFeed" newer
WHERE older."userId" = newer."userId"
  AND older."compactionKey" = newer."compactionKey"
  AND older."feedId" < newer."feedId";

ALTER TABLE "ClientStateFeed" ALTER COLUMN "compactionKey" SET NOT NULL;
ALTER TABLE "ClientStateFeed" DROP CONSTRAINT "ClientStateFeed_compaction_key";
ALTER TABLE "ClientStateFeed"
  ADD CONSTRAINT "ClientStateFeed_compaction_key"
  UNIQUE ("userId", "compactionKey");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "FederationThreadSyncState"
    GROUP BY "threadId" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'multiple federation sync states exist for one thread';
  END IF;
END $$;

ALTER TABLE "FederationThreadSyncState"
  DROP CONSTRAINT "FederationThreadSyncState_activeGap_fkey";
ALTER TABLE "FederationThreadSyncState"
  DROP CONSTRAINT "FederationThreadSyncState_namespace_fkey";
ALTER TABLE "FederationThreadSyncState"
  DROP CONSTRAINT "FederationThreadSyncState_pkey";

ALTER TABLE "FederationThreadHistoryGap"
  DROP CONSTRAINT "FederationThreadHistoryGap_namespaceId_fkey";
ALTER TABLE "FederationThreadHistoryGap"
  DROP CONSTRAINT "FederationThreadHistoryGap_threadId_namespaceId_id_key";
DROP INDEX "FederationThreadHistoryGap_interval_key";
DROP INDEX "FederationThreadHistoryGap_recoverable_idx";

ALTER TABLE "FederationThreadSyncState"
  DROP COLUMN "peerDomain",
  DROP COLUMN "namespaceId";
ALTER TABLE "FederationThreadHistoryGap" DROP COLUMN "namespaceId";

ALTER TABLE "FederationThreadSyncState"
  ADD CONSTRAINT "FederationThreadSyncState_pkey" PRIMARY KEY ("threadId");
ALTER TABLE "FederationThreadHistoryGap"
  ADD CONSTRAINT "FederationThreadHistoryGap_threadId_id_key"
  UNIQUE ("threadId", id);
CREATE UNIQUE INDEX "FederationThreadHistoryGap_interval_key"
  ON "FederationThreadHistoryGap" ("threadId", "startSeq", "endSeq");
CREATE INDEX "FederationThreadHistoryGap_recoverable_idx"
  ON "FederationThreadHistoryGap" ("threadId", "endSeq")
  WHERE recoverable = true;
ALTER TABLE "FederationThreadSyncState"
  ADD CONSTRAINT "FederationThreadSyncState_activeGap_fkey"
  FOREIGN KEY ("threadId", "activeGapId")
  REFERENCES "FederationThreadHistoryGap" ("threadId", id)
  ON DELETE RESTRICT;
