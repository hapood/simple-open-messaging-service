CREATE TABLE "UserPreference" (
  "userId" INTEGER NOT NULL,
  "key" VARCHAR(100) NOT NULL,
  "value" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("userId", "key"),
  CONSTRAINT "UserPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UserPreference_value_not_json_null_check"
    CHECK ("value" <> 'null'::jsonb),
  CONSTRAINT "UserPreference_revision_check"
    CHECK ("revision" >= 0)
);

ALTER TABLE "SessionToken"
  ADD COLUMN "autoTerminateDays" INTEGER NOT NULL DEFAULT 30,
  ADD CONSTRAINT "SessionToken_auto_terminate_days_check"
    CHECK ("autoTerminateDays" IN (7, 30, 90, 180, 365));

DELETE FROM "SessionToken";

ALTER TABLE "SessionToken"
  ALTER COLUMN "expiresAt" SET NOT NULL,
  DROP COLUMN "persistent",
  DROP COLUMN "trusted";
