DROP TABLE "LinkFavicon";

DROP INDEX "LinkCardRule_enabled_priority_idx";

ALTER TABLE "LinkCardRule" RENAME COLUMN "displayName" TO "note";
ALTER TABLE "LinkCardRule" ALTER COLUMN "note" DROP NOT NULL;
ALTER TABLE "LinkCardRule"
  DROP COLUMN "matchUrl",
  DROP COLUMN "includeSubdomains",
  DROP COLUMN "enabled",
  DROP COLUMN "priority";
