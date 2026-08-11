-- Remove the obsolete database-backed change queue completely. Federation allocation now lives on
-- FederationServeCursor; local clients already recover through thread revisions and per-thread seq.

ALTER TABLE "FederationServeCursor"
  ADD COLUMN "allocatedThrough" BIGINT NOT NULL DEFAULT 0;

UPDATE "FederationServeCursor" cursor
SET "allocatedThrough" = target."allocatedThrough"
FROM "DiscoveryTarget" target
WHERE target.id = cursor."targetId";

ALTER TABLE "FederationServeCursor"
  ADD CONSTRAINT "FederationServeCursor_allocatedThrough_check"
  CHECK ("allocatedThrough" >= "lastServedThrough");

ALTER TABLE "FederationServeCursor"
  DROP CONSTRAINT "FederationServeCursor_targetId_fkey";

DROP INDEX "FederationServeCursor_targetId_key";

ALTER TABLE "FederationServeCursor"
  DROP COLUMN "targetId";

DROP TABLE "DiscoveryChange";
DROP TABLE "DiscoveryTarget";
