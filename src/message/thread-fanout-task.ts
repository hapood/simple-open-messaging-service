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
import { systemAccountIdInTx } from '../user/system-account.js';

export interface ThreadFanoutTarget {
  threadId: number;
  messageEndSeq: number;
}

export interface FederationThreadFanoutTarget {
  threadId: number;
  messageEndSeq: number;
  tombstoneEndSeq: number;
}

export interface ThreadTombFanoutTarget {
  threadId: number;
  tombstoneEndSeq: number;
}

export interface ThreadMetaFanoutTarget {
  threadId: number;
  groupMetaFeedEndId: number;
}

export type ThreadFanoutTaskType =
  | typeof DurableTaskType.FAN_OUT_THREAD_CONTENT
  | typeof DurableTaskType.FAN_OUT_THREAD_TOMB
  | typeof DurableTaskType.FAN_OUT_THREAD_META
  | typeof DurableTaskType.FAN_OUT_FEDERATION_THREAD_CONTENT;

function isInt32(value: unknown, minimum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= 2147483647
  );
}

/** Ordinary message admission. System writers enqueue only the client task. */
export async function enqueueMessageFanoutsInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  target: FederationThreadFanoutTarget,
): Promise<void> {
  await enqueueThreadFanoutInTx(tx, lock, {
    threadId: target.threadId,
    messageEndSeq: target.messageEndSeq,
  });
  await enqueueFederationThreadFanoutInTx(tx, lock, target);
}

/** Deletion admission: refreshes client previews/mentions, pushes THREAD_TOMB_HEAD, and notifies S2S peers. */
export async function enqueueDeletionFanoutsInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  target: FederationThreadFanoutTarget,
): Promise<void> {
  await enqueueThreadFanoutInTx(tx, lock, {
    threadId: target.threadId,
    messageEndSeq: target.messageEndSeq,
  });
  await enqueueThreadTombFanoutInTx(tx, lock, {
    threadId: target.threadId,
    tombstoneEndSeq: target.tombstoneEndSeq,
  });
  await enqueueFederationThreadFanoutInTx(tx, lock, target);
}

/** Re-publish the current complete thread head after content/profile/membership changes. */
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
  const prefix =
    taskType === DurableTaskType.FAN_OUT_THREAD_CONTENT
      ? 'THREAD_FANOUT'
      : taskType === DurableTaskType.FAN_OUT_THREAD_TOMB
        ? 'THREAD_TOMB_FANOUT'
        : taskType === DurableTaskType.FAN_OUT_THREAD_META
          ? 'THREAD_META_FANOUT'
          : 'FEDERATION_THREAD_FANOUT';
  return JSON.stringify([prefix, threadId]);
}

export function parseThreadFanoutTarget(
  value: Record<string, unknown>,
): ThreadFanoutTarget {
  if (!isInt32(value.threadId, 1) || !isInt32(value.messageEndSeq, 0)) {
    throw new Error('Invalid thread fanout target');
  }
  return {
    threadId: value.threadId,
    messageEndSeq: value.messageEndSeq,
  };
}

export function parseFederationThreadFanoutTarget(
  value: Record<string, unknown>,
): FederationThreadFanoutTarget {
  if (
    !isInt32(value.threadId, 1) ||
    !isInt32(value.messageEndSeq, 0) ||
    !isInt32(value.tombstoneEndSeq, 0)
  ) {
    throw new Error('Invalid federation thread fanout target');
  }
  return {
    threadId: value.threadId,
    messageEndSeq: value.messageEndSeq,
    tombstoneEndSeq: value.tombstoneEndSeq,
  };
}

export function parseThreadTombFanoutTarget(
  value: Record<string, unknown>,
): ThreadTombFanoutTarget {
  if (!isInt32(value.threadId, 1) || !isInt32(value.tombstoneEndSeq, 0)) {
    throw new Error('Invalid thread tomb fanout target');
  }
  return {
    threadId: value.threadId,
    tombstoneEndSeq: value.tombstoneEndSeq,
  };
}

export function parseThreadMetaFanoutTarget(
  value: Record<string, unknown>,
): ThreadMetaFanoutTarget {
  if (!isInt32(value.threadId, 1) || !isInt32(value.groupMetaFeedEndId, 0)) {
    throw new Error('Invalid thread meta fanout target');
  }
  return {
    threadId: value.threadId,
    groupMetaFeedEndId: value.groupMetaFeedEndId,
  };
}

async function enqueueCoalescedThreadTaskInTx<T extends { threadId: number }>(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  taskType: ThreadFanoutTaskType,
  target: T,
  parse: (value: Record<string, unknown>) => T,
  merge: (previous: T, next: T) => T,
): Promise<bigint> {
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
    const previous = parse(pending.payload);
    const merged = merge(previous, target);
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
    actorUserId: await systemAccountIdInTx(tx),
    payload: { ...target },
    coalescingKey: scopeKey,
  });
  return created.taskId;
}

/** Persist in the source transaction under its thread lock. */
export async function enqueueThreadFanoutInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  input: ThreadFanoutTarget,
): Promise<bigint> {
  const target = parseThreadFanoutTarget({ ...input });
  return enqueueCoalescedThreadTaskInTx(
    tx,
    lock,
    DurableTaskType.FAN_OUT_THREAD_CONTENT,
    target,
    parseThreadFanoutTarget,
    (previous, next) => {
      if (previous.threadId !== next.threadId)
        throw new Error('Fanout task scope mismatch');
      return {
        threadId: next.threadId,
        messageEndSeq: Math.max(previous.messageEndSeq, next.messageEndSeq),
      };
    },
  );
}

export async function enqueueFederationThreadFanoutInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  input: FederationThreadFanoutTarget,
): Promise<bigint> {
  const target = parseFederationThreadFanoutTarget({ ...input });
  return enqueueCoalescedThreadTaskInTx(
    tx,
    lock,
    DurableTaskType.FAN_OUT_FEDERATION_THREAD_CONTENT,
    target,
    parseFederationThreadFanoutTarget,
    (previous, next) => {
      if (previous.threadId !== next.threadId)
        throw new Error('Fanout task scope mismatch');
      return {
        threadId: next.threadId,
        messageEndSeq: Math.max(previous.messageEndSeq, next.messageEndSeq),
        tombstoneEndSeq: Math.max(
          previous.tombstoneEndSeq,
          next.tombstoneEndSeq,
        ),
      };
    },
  );
}

export async function enqueueThreadTombFanoutInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  input: ThreadTombFanoutTarget,
): Promise<bigint> {
  const target = parseThreadTombFanoutTarget({ ...input });
  return enqueueCoalescedThreadTaskInTx(
    tx,
    lock,
    DurableTaskType.FAN_OUT_THREAD_TOMB,
    target,
    parseThreadTombFanoutTarget,
    (previous, next) => {
      if (previous.threadId !== next.threadId)
        throw new Error('Fanout task scope mismatch');
      return {
        threadId: next.threadId,
        tombstoneEndSeq: Math.max(
          previous.tombstoneEndSeq,
          next.tombstoneEndSeq,
        ),
      };
    },
  );
}

export async function enqueueThreadMetaFanoutInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  input: ThreadMetaFanoutTarget,
): Promise<bigint> {
  const target = parseThreadMetaFanoutTarget({ ...input });
  return enqueueCoalescedThreadTaskInTx(
    tx,
    lock,
    DurableTaskType.FAN_OUT_THREAD_META,
    target,
    parseThreadMetaFanoutTarget,
    (previous, next) => {
      if (previous.threadId !== next.threadId)
        throw new Error('Fanout task scope mismatch');
      return {
        threadId: next.threadId,
        groupMetaFeedEndId: Math.max(
          previous.groupMetaFeedEndId,
          next.groupMetaFeedEndId,
        ),
      };
    },
  );
}

async function yieldCoalescedThreadFanoutInTx<T extends { threadId: number }>(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  taskId: bigint,
  target: T,
  taskType: ThreadFanoutTaskType,
  doneCheckpoint: Record<string, unknown>,
  parse: (value: Record<string, unknown>) => T,
  isNewer: (newer: T, current: T) => boolean,
  merge: (current: T, newer: T) => T,
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
  const newer = parse(next.payload);
  if (newer.threadId !== target.threadId)
    throw new Error('Fanout successor scope mismatch');
  if (!isNewer(newer, target)) return false;
  await tx
    .update(durableTask)
    .set({
      payload: { ...merge(target, newer) },
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

/** Cover heads in the successor before completing the old execution. */
export async function yieldThreadFanoutInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  taskId: bigint,
  target: ThreadFanoutTarget,
  doneCheckpoint: Record<string, unknown>,
): Promise<boolean> {
  return yieldCoalescedThreadFanoutInTx(
    tx,
    lock,
    taskId,
    target,
    DurableTaskType.FAN_OUT_THREAD_CONTENT,
    doneCheckpoint,
    parseThreadFanoutTarget,
    (newer, current) => newer.messageEndSeq > current.messageEndSeq,
    (current, newer) => ({
      threadId: current.threadId,
      messageEndSeq: Math.max(current.messageEndSeq, newer.messageEndSeq),
    }),
  );
}

export async function yieldFederationThreadFanoutInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  taskId: bigint,
  target: FederationThreadFanoutTarget,
  doneCheckpoint: Record<string, unknown>,
): Promise<boolean> {
  return yieldCoalescedThreadFanoutInTx(
    tx,
    lock,
    taskId,
    target,
    DurableTaskType.FAN_OUT_FEDERATION_THREAD_CONTENT,
    doneCheckpoint,
    parseFederationThreadFanoutTarget,
    (newer, current) =>
      newer.messageEndSeq > current.messageEndSeq ||
      newer.tombstoneEndSeq > current.tombstoneEndSeq,
    (current, newer) => ({
      threadId: current.threadId,
      messageEndSeq: Math.max(current.messageEndSeq, newer.messageEndSeq),
      tombstoneEndSeq: Math.max(current.tombstoneEndSeq, newer.tombstoneEndSeq),
    }),
  );
}

export async function yieldThreadTombFanoutInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  taskId: bigint,
  target: ThreadTombFanoutTarget,
  doneCheckpoint: Record<string, unknown>,
): Promise<boolean> {
  return yieldCoalescedThreadFanoutInTx(
    tx,
    lock,
    taskId,
    target,
    DurableTaskType.FAN_OUT_THREAD_TOMB,
    doneCheckpoint,
    parseThreadTombFanoutTarget,
    (newer, current) => newer.tombstoneEndSeq > current.tombstoneEndSeq,
    (current, newer) => ({
      threadId: current.threadId,
      tombstoneEndSeq: Math.max(current.tombstoneEndSeq, newer.tombstoneEndSeq),
    }),
  );
}

export async function yieldThreadMetaFanoutInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  taskId: bigint,
  target: ThreadMetaFanoutTarget,
  doneCheckpoint: Record<string, unknown>,
): Promise<boolean> {
  return yieldCoalescedThreadFanoutInTx(
    tx,
    lock,
    taskId,
    target,
    DurableTaskType.FAN_OUT_THREAD_META,
    doneCheckpoint,
    parseThreadMetaFanoutTarget,
    (newer, current) => newer.groupMetaFeedEndId > current.groupMetaFeedEndId,
    (current, newer) => ({
      threadId: current.threadId,
      groupMetaFeedEndId: Math.max(
        current.groupMetaFeedEndId,
        newer.groupMetaFeedEndId,
      ),
    }),
  );
}
