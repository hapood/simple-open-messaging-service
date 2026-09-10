import { and, desc, eq, gt } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  account,
  durableTask,
  peerStateFeedTarget,
} from '../database/schema.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import {
  insertPendingTaskInTx,
  updatePendingTaskInTx,
} from '../durable-task/task-admission.js';

/** The source feed has already been written/reindexed in the admission transaction. */
export type StateFeedFanout =
  | { target: 'CLIENT'; userId: number; feedId: string }
  | { target: 'PEER'; peerDomain: string; namespaceId: number; feedId: string };

export function stateFeedScope(input: StateFeedFanout): string {
  return JSON.stringify([
    'STATE_FEED',
    input.target,
    input.target === 'CLIENT' ? input.userId : input.namespaceId,
  ]);
}

export function readStateFeedFanout(
  value: Record<string, unknown>,
): StateFeedFanout {
  if (
    typeof value.feedId !== 'string' ||
    !/^[1-9]\d*$/.test(value.feedId) ||
    (value.target === 'CLIENT'
      ? !Number.isSafeInteger(value.userId) ||
        Number(value.userId) <= 0 ||
        BigInt(value.feedId) > 2147483647n
      : value.target !== 'PEER' ||
        typeof value.peerDomain !== 'string' ||
        !value.peerDomain ||
        !Number.isSafeInteger(value.namespaceId) ||
        Number(value.namespaceId) <= 0)
  )
    throw new Error('invalid state feed fanout target');
  return value as unknown as StateFeedFanout;
}

/** Reuses allocator ordering; fanout never enters business locks or changes a feed. */
export async function lockStateFeedOwnerInTx(
  tx: DatabaseTransaction,
  input: StateFeedFanout,
): Promise<boolean> {
  if (input.target === 'CLIENT') {
    const rows = await tx
      .select({ id: account.id })
      .from(account)
      .where(eq(account.id, input.userId))
      .for('no key update');
    return rows.length > 0;
  }
  const rows = await tx
    .select({ id: peerStateFeedTarget.namespaceId })
    .from(peerStateFeedTarget)
    .where(
      and(
        eq(peerStateFeedTarget.namespaceId, input.namespaceId),
        eq(peerStateFeedTarget.peerDomain, input.peerDomain),
      ),
    )
    .for('no key update');
  return rows.length > 0;
}

export function mergeStateFeedFanout(
  previous: StateFeedFanout,
  next: StateFeedFanout,
): StateFeedFanout {
  if (stateFeedScope(previous) !== stateFeedScope(next))
    throw new Error('state feed target changed');
  return {
    ...next,
    feedId:
      BigInt(previous.feedId) > BigInt(next.feedId)
        ? previous.feedId
        : next.feedId,
  };
}

/** One target is bounded work; independent feeds never replace each other's coverage. */
export async function enqueueStateFeedFanoutInTx(
  tx: DatabaseTransaction,
  input: StateFeedFanout,
): Promise<void> {
  readStateFeedFanout({ ...input });
  if (!(await lockStateFeedOwnerInTx(tx, input)))
    throw new Error('state feed owner missing');
  const key = stateFeedScope(input);
  const [pending] = await tx
    .select()
    .from(durableTask)
    .where(
      and(
        eq(durableTask.taskType, DurableTaskType.FAN_OUT_STATE_FEED),
        eq(durableTask.coalescingKey, key),
        eq(durableTask.status, 'PENDING'),
      ),
    )
    .orderBy(desc(durableTask.id))
    .limit(1);
  const payload = {
    ...(pending
      ? mergeStateFeedFanout(readStateFeedFanout(pending.payload), input)
      : input),
  };
  if (pending && (await updatePendingTaskInTx(tx, pending.id, { payload })))
    return;
  await insertPendingTaskInTx(tx, {
    kind: 'PROJECTION',
    scopeType: 'STATE_FEED',
    scopeKey: key,
    taskType: DurableTaskType.FAN_OUT_STATE_FEED,
    coalescingKey: key,
    payload,
  });
}

export async function yieldStateFeedFanoutInTx(
  tx: DatabaseTransaction,
  taskId: bigint,
  input: StateFeedFanout,
): Promise<boolean> {
  const [next] = await tx
    .select()
    .from(durableTask)
    .where(
      and(
        eq(durableTask.taskType, DurableTaskType.FAN_OUT_STATE_FEED),
        eq(durableTask.coalescingKey, stateFeedScope(input)),
        eq(durableTask.status, 'PENDING'),
        gt(durableTask.id, taskId),
      ),
    )
    .orderBy(desc(durableTask.id))
    .limit(1)
    .for('no key update');
  if (!next) return false;
  await updatePendingTaskInTx(tx, next.id, {
    payload: {
      ...mergeStateFeedFanout(input, readStateFeedFanout(next.payload)),
    },
  });
  return true;
}
