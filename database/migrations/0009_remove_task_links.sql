ALTER TABLE "DurableTask"
  DROP CONSTRAINT "DurableTask_parentTaskId_fkey",
  DROP CONSTRAINT "DurableTask_supersededByTaskId_fkey",
  DROP CONSTRAINT "DurableTask_parent_order_check",
  DROP CONSTRAINT "DurableTask_supersession_check";

DROP INDEX "DurableTask_parentTaskId_idx";
DROP INDEX "DurableTask_supersededByTaskId_idx";

ALTER TABLE "DurableTask"
  DROP COLUMN "parentTaskId",
  DROP COLUMN "supersededByTaskId",
  ADD CONSTRAINT "DurableTask_supersession_check"
    CHECK (status <> 'SUPERSEDED' OR "coalescingKey" IS NOT NULL);
