import { MessageVisibilityService } from './message-visibility.service.js';
import type { AccountThreadFanoutTarget } from './account-thread-fanout-task.js';
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { accountThreadState, durableTask } from '../database/schema.js';
import {
  acquireThreadContentLockInTx,
  requireThreadContentLockInTx,
} from '../common/locks/thread-content-lock.js';
import {
  hasEstablishedThreadRelationship,
  isThreadMutuallyAuthorized,
} from '../relationship/shared/relationship-authorization.js';
import {
  ThreadFeedHeadWriter,
  type ThreadProjectionChange,
} from './thread-feed-head.writer.js';
import {
  yieldThreadFanoutInTx,
  yieldThreadMetaFanoutInTx,
  yieldThreadTombFanoutInTx,
  type ThreadFanoutTarget,
  type ThreadMetaFanoutTarget,
  type ThreadTombFanoutTarget,
} from './thread-fanout-task.js';
import { saveTaskCheckpointInTx } from '../durable-task/task-checkpoint.js';
import { lockAccountFeedAllocatorsInTx } from '../common/locks/account-feed-allocator-lock.js';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../client-state-feed/client-state-feed.service.js';

export interface ThreadFanoutProgress {
  phase: 'FEED' | 'DONE';
  afterAccountId: number;
}

export type ThreadFanoutProjection = ThreadProjectionChange & {
  userId: number;
};

function readThreadFanoutProgress(
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
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  async yieldToNewer(
    taskId: bigint,
    target: ThreadFanoutTarget,
  ): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const lock = await requireThreadContentLockInTx(tx, target.threadId);
      return yieldThreadFanoutInTx(tx, lock, taskId, target, {
        phase: 'DONE',
        afterAccountId: 0,
      });
    });
  }

  async yieldTombToNewer(
    taskId: bigint,
    target: ThreadTombFanoutTarget,
  ): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const lock = await requireThreadContentLockInTx(tx, target.threadId);
      return yieldThreadTombFanoutInTx(tx, lock, taskId, target, {
        phase: 'DONE',
        afterAccountId: 0,
      });
    });
  }

  async yieldMetaToNewer(
    taskId: bigint,
    target: ThreadMetaFanoutTarget,
  ): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      const lock = await requireThreadContentLockInTx(tx, target.threadId);
      return yieldThreadMetaFanoutInTx(tx, lock, taskId, target, {
        phase: 'DONE',
        afterAccountId: 0,
      });
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

  private advanceGroupProfileInTx(
    tx: DatabaseTransaction,
    threadId: number,
    userIds: readonly number[],
  ): Promise<number[]> {
    return ThreadFeedHeadWriter.reconcileGroupProfileInTx(tx, {
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
   * Publishes both the truncated ThreadFeed head and final ClientStateFeed tomb/meta heads. */
  async projectAccount(
    taskId: bigint,
    target: AccountThreadFanoutTarget,
  ): Promise<{
    projected: ThreadFanoutProjection[];
    clientUpdates: PendingClientStateFeedUpdate[];
  }> {
    return this.database.db.transaction(async (tx) => {
      const projected: ThreadFanoutProjection[] = [];
      const clientUpdates: PendingClientStateFeedUpdate[] = [];
      const lock = await acquireThreadContentLockInTx(tx, target.threadId);
      if (lock) await lockAccountFeedAllocatorsInTx(tx, [target.accountId]);
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
        const [bounds] = await tx
          .select({
            blocked: accountThreadState.blocked,
            messageEndSeq: accountThreadState.messageEndSeq,
            messageVisibleThroughSeq:
              accountThreadState.messageVisibleThroughSeq,
            tombstoneVisibleThroughSeq:
              accountThreadState.tombstoneVisibleThroughSeq,
            groupMetaVisibleThroughId:
              accountThreadState.groupMetaVisibleThroughId,
          })
          .from(accountThreadState)
          .where(
            and(
              eq(accountThreadState.accountId, target.accountId),
              eq(accountThreadState.threadId, target.threadId),
            ),
          )
          .limit(1);
        if (bounds && !bounds.blocked) {
          const effectiveMessageEnd =
            bounds.messageVisibleThroughSeq === null
              ? target.messageEndSeq
              : Math.min(target.messageEndSeq, bounds.messageVisibleThroughSeq);
          if (bounds.messageEndSeq < effectiveMessageEnd) {
            projected.push({
              userId: target.accountId,
              ...(await ThreadFeedHeadWriter.advanceInTx(tx, target.accountId, {
                threadId: target.threadId,
                messageEndSeq: effectiveMessageEnd,
              })),
            });
          }
          const profileChanged = await this.advanceGroupProfileInTx(
            tx,
            target.threadId,
            [target.accountId],
          );
          if (
            profileChanged.includes(target.accountId) &&
            !projected.some(({ userId }) => userId === target.accountId)
          ) {
            projected.push({
              userId: target.accountId,
              unreadCountChanged: false,
              previewChanged: false,
            });
          }
          if (
            bounds.tombstoneVisibleThroughSeq !== null &&
            bounds.tombstoneVisibleThroughSeq > 0
          ) {
            const feedId = await this.clientStateFeed.publishThreadTombHeadInTx(
              tx,
              target.accountId,
              target.threadId,
              bounds.tombstoneVisibleThroughSeq,
            );
            if (feedId !== null) {
              clientUpdates.push({
                kind: 'thread-tomb-head',
                userId: target.accountId,
                feedId,
              });
            }
          }
          if (
            bounds.groupMetaVisibleThroughId !== null &&
            bounds.groupMetaVisibleThroughId > 0
          ) {
            const feedId = await this.clientStateFeed.publishThreadMetaHeadInTx(
              tx,
              target.accountId,
              target.threadId,
              bounds.groupMetaVisibleThroughId,
            );
            if (feedId !== null) {
              clientUpdates.push({
                kind: 'thread-meta-head',
                userId: target.accountId,
                feedId,
              });
            }
          }
        }
      }
      await saveTaskCheckpointInTx(tx, taskId, {
        phase: 'DONE',
        afterAccountId: target.accountId,
      });
      return { projected, clientUpdates };
    });
  }

  /** Relationship and block changes serialize on the same thread lock. */
  async projectActiveAccount(
    taskId: bigint,
    target: ThreadFanoutTarget,
    userId: number,
  ): Promise<ThreadFanoutProjection[]> {
    return this.database.db.transaction(async (tx) => {
      const projected: ThreadFanoutProjection[] = [];
      await requireThreadContentLockInTx(tx, target.threadId);
      await lockAccountFeedAllocatorsInTx(tx, [userId]);
      if (await isThreadMutuallyAuthorized(tx, userId, target.threadId)) {
        projected.push({
          userId,
          ...(await ThreadFeedHeadWriter.advanceInTx(tx, userId, target)),
        });
        const profileChanged = await this.advanceGroupProfileInTx(
          tx,
          target.threadId,
          [userId],
        );
        if (
          profileChanged.includes(userId) &&
          !projected.some((item) => item.userId === userId)
        )
          projected.push({
            userId,
            unreadCountChanged: false,
            previewChanged: false,
          });
      }
      await saveTaskCheckpointInTx(tx, taskId, {
        phase: 'FEED',
        afterAccountId: userId,
      });
      return projected;
    });
  }

  async projectActiveTombAccount(
    taskId: bigint,
    target: ThreadTombFanoutTarget,
    userId: number,
  ): Promise<PendingClientStateFeedUpdate[]> {
    return this.database.db.transaction(async (tx) => {
      const updates: PendingClientStateFeedUpdate[] = [];
      await requireThreadContentLockInTx(tx, target.threadId);
      await lockAccountFeedAllocatorsInTx(tx, [userId]);
      if (await isThreadMutuallyAuthorized(tx, userId, target.threadId)) {
        const [state] = await tx
          .select({
            blocked: accountThreadState.blocked,
            tombstoneVisibleThroughSeq:
              accountThreadState.tombstoneVisibleThroughSeq,
          })
          .from(accountThreadState)
          .where(
            and(
              eq(accountThreadState.accountId, userId),
              eq(accountThreadState.threadId, target.threadId),
            ),
          )
          .limit(1);
        if (state && !state.blocked) {
          const effectiveEnd =
            state.tombstoneVisibleThroughSeq === null
              ? target.tombstoneEndSeq
              : Math.min(
                  target.tombstoneEndSeq,
                  state.tombstoneVisibleThroughSeq,
                );
          const feedId = await this.clientStateFeed.publishThreadTombHeadInTx(
            tx,
            userId,
            target.threadId,
            effectiveEnd,
          );
          if (feedId !== null) {
            updates.push({ kind: 'thread-tomb-head', userId, feedId });
          }
        }
      }
      await saveTaskCheckpointInTx(tx, taskId, {
        phase: 'FEED',
        afterAccountId: userId,
      });
      return updates;
    });
  }

  async projectActiveMetaAccount(
    taskId: bigint,
    target: ThreadMetaFanoutTarget,
    userId: number,
  ): Promise<PendingClientStateFeedUpdate[]> {
    return this.database.db.transaction(async (tx) => {
      const updates: PendingClientStateFeedUpdate[] = [];
      await requireThreadContentLockInTx(tx, target.threadId);
      await lockAccountFeedAllocatorsInTx(tx, [userId]);
      if (await isThreadMutuallyAuthorized(tx, userId, target.threadId)) {
        const [state] = await tx
          .select({
            blocked: accountThreadState.blocked,
            groupMetaVisibleThroughId:
              accountThreadState.groupMetaVisibleThroughId,
          })
          .from(accountThreadState)
          .where(
            and(
              eq(accountThreadState.accountId, userId),
              eq(accountThreadState.threadId, target.threadId),
            ),
          )
          .limit(1);
        if (state && !state.blocked) {
          const effectiveEnd =
            state.groupMetaVisibleThroughId === null
              ? target.groupMetaFeedEndId
              : Math.min(
                  target.groupMetaFeedEndId,
                  state.groupMetaVisibleThroughId,
                );
          const feedId = await this.clientStateFeed.publishThreadMetaHeadInTx(
            tx,
            userId,
            target.threadId,
            effectiveEnd,
          );
          if (feedId !== null) {
            updates.push({ kind: 'thread-meta-head', userId, feedId });
          }
        }
      }
      await saveTaskCheckpointInTx(tx, taskId, {
        phase: 'FEED',
        afterAccountId: userId,
      });
      return updates;
    });
  }
}
