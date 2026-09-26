import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { durableTask } from '../database/schema.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import {
  insertPendingTaskInTx,
  updatePendingTaskInTx,
} from '../durable-task/task-admission.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../common/locks/thread-content-lock.js';

export interface ThreadFanoutTarget {
  threadId: number;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  /** Legacy coalesced message revision hint. It is not a viewer-specific avatar
   * revision: the head writer derives that from committed counterpart messages
   * or the group-wide Meta row, so mixed-author fanouts remain safe. */
  profileRev?: number;
}

export type ThreadFanoutTaskType =
  | typeof DurableTaskType.FAN_OUT_THREAD_CONTENT
  | typeof DurableTaskType.FAN_OUT_FEDERATION_THREAD_CONTENT;

/** Ordinary message/deletion admission. System writers enqueue only the client task. */
export async function enqueueMessageFanoutsInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  target: ThreadFanoutTarget,
): Promise<void> {
  await enqueueThreadFanoutInTx(tx, lock, target);
  await enqueueThreadFanoutInTx(
    tx,
    lock,
    target,
    DurableTaskType.FAN_OUT_FEDERATION_THREAD_CONTENT,
  );
}

/** Re-publish the current complete thread head after metadata-only changes. */
export async function enqueueCurrentThreadFanoutsInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
): Promise<void> {
  await requireThreadContentLockInTx(tx, lock.threadId, lock);
  const head = await tx.execute<{
    messageEndSeq: number;
    tombstoneEndSeq: number;
  }>(sql`
    SELECT COALESCE(MAX(message.seq), 0)::integer AS "messageEndSeq",
           thread."tombstoneEndSeq" AS "tombstoneEndSeq"
    FROM "MessageThread" thread
    LEFT JOIN "Message" message ON message."threadId" = thread.id
    WHERE thread.id = ${lock.threadId}
    GROUP BY thread.id, thread."tombstoneEndSeq"
  `);
  const current = head.rows[0];
  if (!current) throw new Error(`thread ${lock.threadId} does not exist`);
  await enqueueMessageFanoutsInTx(tx, lock, {
    threadId: lock.threadId,
    ...current,
  });
}

export function threadFanoutScope(
  taskType: ThreadFanoutTaskType,
  threadId: number,
): string {
  return JSON.stringify([
    taskType === DurableTaskType.FAN_OUT_THREAD_CONTENT
      ? 'THREAD_FANOUT'
      : 'FEDERATION_THREAD_FANOUT',
    threadId,
  ]);
}

function mergeThreadFanoutTargets(
  previous: ThreadFanoutTarget,
  next: ThreadFanoutTarget,
): ThreadFanoutTarget {
  if (previous.threadId !== next.threadId)
    throw new Error('Fanout task scope mismatch');
  return {
    threadId: next.threadId,
    messageEndSeq: Math.max(previous.messageEndSeq, next.messageEndSeq),
    tombstoneEndSeq: Math.max(previous.tombstoneEndSeq, next.tombstoneEndSeq),
    profileRev: Math.max(previous.profileRev ?? 0, next.profileRev ?? 0),
  };
}

export function parseThreadFanoutTarget(
  value: Record<string, unknown>,
): ThreadFanoutTarget {
  const integer = (value: unknown, minimum: number): value is number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= 2147483647;
  if (
    !integer(value.threadId, 1) ||
    !integer(value.messageEndSeq, 0) ||
    !integer(value.tombstoneEndSeq, 0)
  ) {
    throw new Error('Invalid thread fanout target');
  }
  let profileRev: number | undefined;
  if (value.profileRev !== undefined) {
    if (!integer(value.profileRev, 0))
      throw new Error('Invalid thread fanout target');
    profileRev = value.profileRev;
  }
  return {
    threadId: value.threadId,
    messageEndSeq: value.messageEndSeq,
    tombstoneEndSeq: value.tombstoneEndSeq,
    ...(profileRev === undefined ? {} : { profileRev }),
  };
}

/** Persist in the source transaction under its thread lock. The conditional
 * PENDING update races safely with a scheduler claim: if claimed, append trailing
 * work instead. Client and federation projections coalesce independently. */
export async function enqueueThreadFanoutInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  input: ThreadFanoutTarget,
  taskType: ThreadFanoutTaskType = DurableTaskType.FAN_OUT_THREAD_CONTENT,
): Promise<bigint> {
  const target = parseThreadFanoutTarget({ ...input });
  await requireThreadContentLockInTx(tx, target.threadId, lock);
  const scopeKey = threadFanoutScope(taskType, target.threadId);
  const [pending] = await tx
    .select()
    .from(durableTask)
    .where(
      and(
        eq(durableTask.scopeKey, scopeKey),
        eq(durableTask.kind, 'PROJECTION'),
        eq(durableTask.taskType, taskType),
        eq(durableTask.status, 'PENDING'),
      ),
    )
    .orderBy(desc(durableTask.id))
    .limit(1);
  if (pending) {
    const previous = parseThreadFanoutTarget(pending.payload);
    const merged = mergeThreadFanoutTargets(previous, target);
    const updated = await updatePendingTaskInTx(tx, pending.id, {
      payload: { ...merged },
    });
    if (updated) return updated.taskId;
  }
  const created = await insertPendingTaskInTx(tx, {
    kind: 'PROJECTION',
    scopeType: 'THREAD',
    scopeKey,
    taskType,
    payload: { ...target },
    coalescingKey: scopeKey,
  });
  return created.taskId;
}

/** Cover both heads in the successor before completing the old execution.
 * The caller acquires business/thread locks before this helper locks task rows. */
export async function yieldThreadFanoutInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  taskId: bigint,
  target: ThreadFanoutTarget,
  taskType: ThreadFanoutTaskType,
  doneCheckpoint: Record<string, unknown>,
): Promise<boolean> {
  await requireThreadContentLockInTx(tx, target.threadId, lock);
  const [next] = await tx
    .select()
    .from(durableTask)
    .where(
      and(
        eq(durableTask.scopeKey, threadFanoutScope(taskType, target.threadId)),
        eq(durableTask.kind, 'PROJECTION'),
        eq(durableTask.taskType, taskType),
        eq(durableTask.status, 'PENDING'),
        gt(durableTask.id, taskId),
      ),
    )
    .orderBy(asc(durableTask.id))
    .limit(1)
    .for('no key update');
  if (!next) return false;
  const newer = parseThreadFanoutTarget(next.payload);
  if (newer.threadId !== target.threadId)
    throw new Error('Fanout successor scope mismatch');
  if (
    newer.messageEndSeq <= target.messageEndSeq &&
    newer.tombstoneEndSeq <= target.tombstoneEndSeq
  )
    return false;
  await tx
    .update(durableTask)
    .set({
      payload: { ...mergeThreadFanoutTargets(target, newer) },
    })
    .where(eq(durableTask.id, next.id));
  const updated = await tx
    .update(durableTask)
    .set({
      status: 'SUCCEEDED',
      checkpoint: doneCheckpoint,
      completedAt: sql`GREATEST(clock_timestamp(), ${durableTask.startedAt}, ${durableTask.createdAt})`,
      resultCode: null,
      lastError: null,
    })
    .where(
      and(eq(durableTask.id, taskId), eq(durableTask.status, 'PROCESSING')),
    )
    .returning({ id: durableTask.id });
  if (updated.length !== 1) throw new Error('Fanout task is not processing');
  return true;
}
