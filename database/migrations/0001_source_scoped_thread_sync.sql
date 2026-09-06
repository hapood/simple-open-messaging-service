-- A local authority receives independent sequence spaces from multiple peers.
ALTER TABLE "FederationThreadSyncState" DROP CONSTRAINT "FederationThreadSyncState_activeGap_fkey";
ALTER TABLE "FederationThreadSyncState" ADD COLUMN "namespaceId" integer;
ALTER TABLE "FederationThreadHistoryGap" ADD COLUMN "namespaceId" integer;

UPDATE "FederationThreadSyncState" state
SET "namespaceId" = thread."authorityNamespaceId"
FROM "MessageThread" thread
WHERE thread.id = state."threadId" AND thread."authorityNamespaceId" <> 0;
UPDATE "FederationThreadHistoryGap" gap
SET "namespaceId" = thread."authorityNamespaceId"
FROM "MessageThread" thread
WHERE thread.id = gap."threadId" AND thread."authorityNamespaceId" <> 0;

-- An authority's old mixed cursor cannot be assigned to any one publisher.
-- Replay compacted peer heads to rebuild progress; retain all message/tombstone facts.
UPDATE "PeerStateFeedPullCursor" cursor SET "committedThrough" = 0
WHERE EXISTS (
  SELECT 1 FROM "ThreadAudience" audience
  JOIN "FederationThreadSyncState" state ON state."threadId" = audience."threadId"
  WHERE state."namespaceId" IS NULL
    AND audience."targetNamespaceId" = cursor."namespaceId"
);
DELETE FROM "FederationThreadSyncState" WHERE "namespaceId" IS NULL;
DELETE FROM "FederationThreadHistoryGap" WHERE "namespaceId" IS NULL;

ALTER TABLE "FederationThreadSyncState" ALTER COLUMN "namespaceId" SET NOT NULL;
ALTER TABLE "FederationThreadHistoryGap" ALTER COLUMN "namespaceId" SET NOT NULL;
ALTER TABLE "FederationThreadSyncState" DROP CONSTRAINT "FederationThreadSyncState_pkey";
ALTER TABLE "FederationThreadSyncState" ADD CONSTRAINT "FederationThreadSyncState_pkey" PRIMARY KEY ("threadId", "namespaceId");
ALTER TABLE "FederationThreadHistoryGap" DROP CONSTRAINT "FederationThreadHistoryGap_threadId_id_key";
ALTER TABLE "FederationThreadHistoryGap" ADD CONSTRAINT "FederationThreadHistoryGap_threadId_id_key" UNIQUE ("threadId", "namespaceId", id);
DROP INDEX "FederationThreadHistoryGap_interval_key";
CREATE UNIQUE INDEX "FederationThreadHistoryGap_interval_key" ON "FederationThreadHistoryGap" ("threadId", "namespaceId", "startSeq", "endSeq");
DROP INDEX "FederationThreadHistoryGap_recoverable_idx";
CREATE INDEX "FederationThreadHistoryGap_recoverable_idx" ON "FederationThreadHistoryGap" ("threadId", "namespaceId", "endSeq") WHERE recoverable = true;
ALTER TABLE "FederationThreadSyncState" ADD CONSTRAINT "FederationThreadSyncState_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "IdentityNamespace"(id) ON DELETE RESTRICT;
ALTER TABLE "FederationThreadHistoryGap" ADD CONSTRAINT "FederationThreadHistoryGap_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "IdentityNamespace"(id) ON DELETE RESTRICT;
ALTER TABLE "FederationThreadSyncState" ADD CONSTRAINT "FederationThreadSyncState_activeGap_fkey" FOREIGN KEY ("threadId", "namespaceId", "activeGapId") REFERENCES "FederationThreadHistoryGap"("threadId", "namespaceId", id) ON DELETE RESTRICT;
