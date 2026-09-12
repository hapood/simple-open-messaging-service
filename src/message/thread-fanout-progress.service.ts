import { MessageVisibilityService } from './message-visibility.service.js';
import type { AccountThreadFanoutTarget } from './account-thread-fanout-task.js';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { durableTask } from '../database/schema.js';
import {
  acquireThreadContentLockInTx,
  requireThreadContentLockInTx,
} from '../business/shared/locks/thread-content-lock.js';
import {
  hasEstablishedThreadRelationship,
  isThreadMutuallyAuthorized,
} from '../relationship/relationship-authorization.js';
import {
  ThreadFeedHeadWriter,
  type ThreadProjectionChange,
} from './thread-feed-head.writer.js';
import {
  yieldThreadFanoutInTx,
  type ThreadFanoutTarget,
} from './thread-fanout-task.js';
import { saveTaskCheckpointInTx } from '../durable-task/task-checkpoint.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';

export interface ThreadFanoutProgress {
  phase: 'FEED' | 'DONE';
  afterAccountId: number;
}

export type ThreadFanoutProjection = ThreadProjectionChange & {
  userId: number;
};

export function readThreadFanoutProgress(
  value: Record<string, unknown>,
): ThreadFanoutProgress {
  if (Object.keys(value).length === 0)
    return { phase: 'FEED', afterAccountId: 0 };
  const { phase, afterAccountId } = value;
  if (
    !['FEED', 'DONE'].includes(String(phase)) ||
    typeof afterAccountId !== 'number' ||
    !Number.isSafeInteger(afterAccountId) ||
    afterAccountId < 0
  )
    throw new Error('Invalid thread fanout checkpoint');
  return { phase: phase as ThreadFanoutProgress['phase'], afterAccountId };
}

@Injectable()
export class ThreadFanoutProgressService {
  constructor(
    private readonly database: DatabaseService,
    private readonly visibility: MessageVisibilityService,
  ) {}

  /** The source enqueue uses this same lock. A committed successor must cover
   * both heads before the old execution may stop; its own cursor stays at zero.
   * Complete the old task atomically with coverage, without a successor pointer
   * or an intermediate handoff state. Scheduler finalization is idempotent. */
  async yieldToNewer(
    taskId: bigint,
    target: ThreadFanoutTarget,
  ): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const lock = await requireThreadContentLockInTx(tx, target.threadId);
      return yieldThreadFanoutInTx(
        tx,
        lock,
        taskId,
        target,
        DurableTaskType.FAN_OUT_THREAD_CONTENT,
        { phase: 'DONE', afterAccountId: 0 },
      );
    });
  }

  async read(taskId: bigint): Promise<ThreadFanoutProgress> {
    const task = await this.database.db.query.durableTask.findFirst({
      where: eq(durableTask.id, taskId),
    });
    if (!task || task.status !== 'PROCESSING')
      throw new Error('Fanout task is not processing');
    return readThreadFanoutProgress(task.checkpoint);
  }

  /** Every fan-out reconciles the group meta head as a side effect: rows
   * behind the canonical value catch up even when the payload's content heads
   * did not move. Threads without a meta feed (P2P) publish nothing. */
  private advanceGroupMetaHeadInTx(
    tx: DatabaseTransaction,
    threadId: number,
    userIds: readonly number[],
  ): Promise<void> {
    return ThreadFeedHeadWriter.reconcileGroupMetaHeadInTx(tx, {
      threadId,
      userIds,
    });
  }

  async save(taskId: bigint, progress: ThreadFanoutProgress): Promise<void> {
    await this.database.db.transaction((tx) =>
      saveTaskCheckpointInTx(tx, taskId, { ...progress }),
    );
  }

  /** Revalidate retained membership and visibility under the standard parent/thread locks.
   * Projection and completion are atomic; a retry cannot duplicate a published head. */
  async projectAccount(
    taskId: bigint,
    target: AccountThreadFanoutTarget,
  ): Promise<ThreadFanoutProjection[]> {
    return this.database.db.transaction(async (tx) => {
      const projected: ThreadFanoutProjection[] = [];
      const lock = await acquireThreadContentLockInTx(tx, target.threadId);
      if (
        lock &&
        (await this.visibility.findVisibleByThreadSeq(
          target.accountId,
          target.threadId,
          target.messageEndSeq,
          tx,
        )) &&
        (await hasEstablishedThreadRelationship(
          tx,
          target.accountId,
          target.threadId,
        ))
      ) {
        const state = await ThreadFeedHeadWriter.readStateInTx(
          tx,
          target.accountId,
          target.threadId,
        );
        if (
          state &&
          !state.blocked &&
          state.messageEndSeq < target.messageEndSeq
        ) {
          projected.push({
            userId: target.accountId,
            ...(await ThreadFeedHeadWriter.advanceInTx(
              tx,
              target.accountId,
              target,
            )),
          });
        }
      }
      if (lock)
        await this.advanceGroupMetaHeadInTx(tx, target.threadId, [
          target.accountId,
        ]);
      await saveTaskCheckpointInTx(tx, taskId, {
        phase: 'DONE',
        afterAccountId: target.accountId,
      });
      return projected;
    });
  }

  /** Relationship and block changes serialize on the same thread lock. The head
   * writer checks current block state, not the earlier audience snapshot. Feed
   * writes and the cursor commit together, including skipped blocked recipients. */
  async projectBatch(
    taskId: bigint,
    target: ThreadFanoutTarget,
    userIds: number[],
  ): Promise<ThreadFanoutProjection[]> {
    if (userIds.length === 0) return [];
    return this.database.db.transaction(async (tx) => {
      const projected: ThreadFanoutProjection[] = [];
      await requireThreadContentLockInTx(tx, target.threadId);
      for (const userId of userIds) {
        if (await isThreadMutuallyAuthorized(tx, userId, target.threadId))
          projected.push({
            userId,
            ...(await ThreadFeedHeadWriter.advanceInTx(tx, userId, target)),
          });
      }
      await this.advanceGroupMetaHeadInTx(tx, target.threadId, userIds);
      await saveTaskCheckpointInTx(tx, taskId, {
        phase: 'FEED',
        afterAccountId: userIds[userIds.length - 1],
      });
      return projected;
    });
  }
}
