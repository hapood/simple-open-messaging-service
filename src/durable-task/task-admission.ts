import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { durableTask } from '../database/schema.js';

type TaskInsert = typeof durableTask.$inferInsert;
type PendingTaskInput = Pick<
  TaskInsert,
  | 'kind'
  | 'scopeType'
  | 'scopeKey'
  | 'taskType'
  | 'payload'
  | 'actorUserId'
  | 'checkpoint'
  | 'coalescingKey'
>;
type PendingTaskUpdate = Partial<
  Pick<TaskInsert, 'taskType' | 'actorUserId' | 'payload' | 'checkpoint'>
>;

/** Callers own the transaction, business locks, identity and coalescing policy. */
export async function insertPendingTaskInTx(
  tx: DatabaseTransaction,
  input: PendingTaskInput,
) {
  const [inserted] = await tx
    .insert(durableTask)
    .values({ ...input, status: 'PENDING' })
    .returning({ taskId: durableTask.id });
  if (!inserted) throw new Error('durable task insert returned no row');
  return inserted;
}

/** A scheduler claim may win: callers decide whether to append or reject. */
export async function updatePendingTaskInTx(
  tx: DatabaseTransaction,
  taskId: bigint,
  changes: PendingTaskUpdate,
) {
  const [updated] = await tx
    .update(durableTask)
    .set(changes)
    .where(and(eq(durableTask.id, taskId), eq(durableTask.status, 'PENDING')))
    .returning({ taskId: durableTask.id });
  return updated;
}

/** The caller supplies exact IDs or a scoped predicate, never a whole-lane default. */
export async function supersedePendingTasksInTx(
  tx: DatabaseTransaction,
  targets: SQL,
) {
  await tx
    .update(durableTask)
    .set({
      status: 'SUPERSEDED',
      // A transaction may have waited for tasks created after its start timestamp.
      completedAt: sql`GREATEST(clock_timestamp(), ${durableTask.createdAt})`,
    })
    .where(and(targets, eq(durableTask.status, 'PENDING')));
}
