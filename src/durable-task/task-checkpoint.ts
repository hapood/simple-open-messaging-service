import { and, eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { durableTask } from '../database/schema.js';

/** Save alongside the business writes; never open a separate transaction here. */
export async function saveTaskCheckpointInTx(
  tx: DatabaseTransaction,
  taskId: bigint,
  checkpoint: Record<string, unknown>,
): Promise<void> {
  const updated = await tx
    .update(durableTask)
    .set({ checkpoint })
    .where(
      and(eq(durableTask.id, taskId), eq(durableTask.status, 'PROCESSING')),
    )
    .returning({ id: durableTask.id });
  if (updated.length !== 1) throw new Error('Task is not processing');
}
