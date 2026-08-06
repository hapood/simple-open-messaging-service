-- ThreadAudience is a current-access set, not an access-history ledger. Revocation deletes the row;
-- a later authorization inserts it again. Message history remains in the server's shared cache.
DROP INDEX "ThreadAudience_local_epoch_key";
DROP INDEX "ThreadAudience_peer_epoch_key";
DROP INDEX "ThreadAudience_local_access_idx";
DROP INDEX "ThreadAudience_peer_access_idx";

ALTER TABLE "ThreadAudience"
  DROP CONSTRAINT "ThreadAudience_accessEpoch_check",
  DROP CONSTRAINT "ThreadAudience_visibleRange_check",
  DROP COLUMN "accessEpoch",
  DROP COLUMN "startAfterOriginSeq",
  DROP COLUMN "visibleThroughOriginSeq",
  DROP COLUMN "endedAt";

CREATE UNIQUE INDEX "ThreadAudience_local_key"
  ON "ThreadAudience" ("targetDomain", "localUserId", "threadId")
  WHERE "targetDomain" = 'local';

CREATE UNIQUE INDEX "ThreadAudience_peer_key"
  ON "ThreadAudience" ("targetDomain", "threadId")
  WHERE "targetDomain" <> 'local';

CREATE INDEX "ThreadAudience_local_access_idx"
  ON "ThreadAudience" ("localUserId", "threadId")
  WHERE "targetDomain" = 'local';

CREATE INDEX "ThreadAudience_peer_access_idx"
  ON "ThreadAudience" ("targetDomain", "threadId")
  WHERE "targetDomain" <> 'local';

ALTER TABLE "DiscoveryTarget"
  DROP CONSTRAINT "DiscoveryTarget_latestChangeId_check";

ALTER TABLE "DiscoveryTarget"
  RENAME COLUMN "latestChangeId" TO "allocatedThrough";

ALTER TABLE "DiscoveryTarget"
  ADD CONSTRAINT "DiscoveryTarget_allocatedThrough_check" CHECK ("allocatedThrough" >= 0);
