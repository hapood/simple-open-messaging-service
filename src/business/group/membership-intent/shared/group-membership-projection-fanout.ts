import { and, asc, eq, inArray } from 'drizzle-orm';
import { durableTask } from '../../../../database/schema.js';
import type { DatabaseTransaction } from '../../../../database/database.service.js';
import { DurableTaskType } from '../../../../durable-task/durable-task.constants.js';
import {
  insertPendingTaskInTx,
  supersedePendingTasksInTx,
} from '../../../../durable-task/task-admission.js';
import type { DurableTask } from '../../../../durable-task/durable-task.types.js';
import { businessAccountScopeKey } from '../../../shared/locks/account-business-lock.js';

export function groupMembershipProjectionFanoutKey(threadId: number): string {
  return JSON.stringify([DurableTaskType.FAN_OUT_GROUP_PROJECTION, threadId]);
}

/** Caller owns the group business lock: the acceptance transaction already holds it.
 * Insert-then-supersede keeps one pending successor alive across races; a concurrent
 * claim must leave PROCESSING intact. No payload/checkpoint is inherited: every
 * successor reconciles the latest join-request projection watermark. */
export async function admitGroupMembershipProjectionFanoutInTx(
  tx: DatabaseTransaction,
  input: { threadId: number; groupAccount: string },
): Promise<void> {
  const scopeKey = businessAccountScopeKey({
    account: input.groupAccount,
    domain: 'local',
  });
  const coalescingKey = groupMembershipProjectionFanoutKey(input.threadId);
  const pending = await tx
    .select({ id: durableTask.id, payload: durableTask.payload })
    .from(durableTask)
    .where(
      and(
        eq(durableTask.kind, 'PROJECTION'),
        eq(durableTask.scopeType, 'GROUP'),
        eq(durableTask.scopeKey, scopeKey),
        eq(durableTask.taskType, DurableTaskType.FAN_OUT_GROUP_PROJECTION),
        eq(durableTask.coalescingKey, coalescingKey),
        eq(durableTask.status, 'PENDING'),
      ),
    )
    .orderBy(asc(durableTask.id))
    .for('no key update');
  for (const task of pending) {
    if (
      task.payload.threadId !== input.threadId ||
      Object.keys(task.payload).length !== 1
    )
      throw new Error('invalid pending group membership projection payload');
  }
  await insertPendingTaskInTx(tx, {
    kind: 'PROJECTION',
    scopeType: 'GROUP',
    scopeKey,
    taskType: DurableTaskType.FAN_OUT_GROUP_PROJECTION,
    actorUserId: null,
    payload: { threadId: input.threadId },
    checkpoint: { afterManagerId: '0' },
    coalescingKey,
  });
  if (pending.length > 0)
    await supersedePendingTasksInTx(
      tx,
      inArray(
        durableTask.id,
        pending.map((task) => task.id),
      ),
    );
}

export function readGroupMembershipProjectionFanoutTask(task: DurableTask): {
  threadId: number;
} {
  if (
    task.kind !== 'PROJECTION' ||
    task.scopeType !== 'GROUP' ||
    task.taskType !== DurableTaskType.FAN_OUT_GROUP_PROJECTION ||
    Object.keys(task.payload).length !== 1 ||
    !Number.isSafeInteger(task.payload.threadId) ||
    Number(task.payload.threadId) <= 0
  )
    throw new Error('invalid group membership projection fan-out task');
  return { threadId: Number(task.payload.threadId) };
}
