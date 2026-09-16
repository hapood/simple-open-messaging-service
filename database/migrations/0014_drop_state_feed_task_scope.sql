-- Retire the state-feed wake scope. Feed delivery is a best-effort post-commit
-- wake emitted from the mutation call path (see docs/design/fan-out-execution.md),
-- so admitted STATE_FEED rows have no executor and are deleted before the value
-- leaves the enum. PostgreSQL cannot drop an enum value directly, so the type is
-- recreated and swapped.

DELETE FROM "DurableTask"
WHERE "scopeType" = 'STATE_FEED';

ALTER TYPE "DurableTaskScopeType" RENAME TO "DurableTaskScopeType_retired";

CREATE TYPE "DurableTaskScopeType" AS ENUM (
  'THREAD',
  'USER_PAIR',
  'GROUP',
  'ACCOUNT_THREAD'
);

ALTER TABLE "DurableTask"
  ALTER COLUMN "scopeType" TYPE "DurableTaskScopeType"
  USING "scopeType"::text::"DurableTaskScopeType";

DROP TYPE "DurableTaskScopeType_retired";
