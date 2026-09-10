-- Failed tasks are terminal and no longer fence subsequent work in their lane.
DROP INDEX public."DurableTask_blocking_scope_id_idx";
CREATE INDEX "DurableTask_blocking_scope_id_idx"
  ON public."DurableTask" (kind, "scopeKey", id)
  WHERE status IN ('PENDING', 'PROCESSING', 'ASYNC_PROCESSING');

-- Notifications are delivered only after commit. Cover every writer, including
-- task admission inside domain transactions and asynchronous terminal writes.
-- Checkpoint-only updates do not change scheduling eligibility.
CREATE FUNCTION public.notify_durable_task_work() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('durable_task_work', '');
  RETURN NULL;
END;
$$;

CREATE TRIGGER "DurableTask_insert_wake"
AFTER INSERT ON public."DurableTask"
FOR EACH ROW WHEN (NEW.status = 'PENDING')
EXECUTE FUNCTION public.notify_durable_task_work();

CREATE TRIGGER "DurableTask_update_wake"
AFTER UPDATE ON public."DurableTask"
FOR EACH ROW WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  OR (NEW.status = 'PENDING' AND (
    OLD."taskType" IS DISTINCT FROM NEW."taskType"
    OR OLD.payload IS DISTINCT FROM NEW.payload
    OR OLD.checkpoint IS DISTINCT FROM NEW.checkpoint
  ))
)
EXECUTE FUNCTION public.notify_durable_task_work();
