import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { captureThreadStateUpdatesInTx } from '../../../client-state-feed/capture-thread-state-updates.js';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../../../client-state-feed/client-state-feed.service.js';
import { DatabaseService } from '../../../database/database.service.js';
import { saveTaskCheckpointInTx } from '../../../durable-task/task-checkpoint.js';
import type { DurableTask } from '../../../durable-task/durable-task.types.js';
import { lockAccountFeedAllocatorsInTx } from '../../../common/locks/account-feed-allocator-lock.js';
import { requireThreadContentLockInTx } from '../../../common/locks/thread-content-lock.js';

interface MembershipProjectionManagerEffect {
  processed: boolean;
  clientUpdates: PendingClientStateFeedUpdate[];
}

/** Syncs one group's join-request projection watermark and unread head for
 * each current local manager under the thread content lock. Reconciles the
 * latest source state per manager and never moves a watermark backwards, so a
 * superseded worker and successor runs stay safe. */
@Injectable()
export class GroupMembershipProjectionFanoutService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clientStateFeed: ClientStateFeedService,
  ) {}

  async execute(
    task: DurableTask,
    payload: { threadId: number },
  ): Promise<void> {
    for (;;) {
      const effect = await this.processNextManager(task, payload.threadId);
      if (!effect.processed) return;
      this.clientStateFeed.notifyFeedUpdates(effect.clientUpdates);
    }
  }

  private async processNextManager(
    task: DurableTask,
    threadId: number,
  ): Promise<MembershipProjectionManagerEffect> {
    return this.database.db.transaction(async (tx) => {
      // Request lists move under this thread's content lock; acquire it before
      // even the task row so watermark sync serializes with the decisions that
      // rewrite the projections.
      await requireThreadContentLockInTx(tx, threadId);
      const locked = await tx.execute<{
        status: string;
        taskType: string;
        coalescingKey: string | null;
        afterManagerId: string | null;
      }>(sql`
        SELECT status, "taskType", "coalescingKey",
               checkpoint ->> 'afterManagerId' AS "afterManagerId"
        FROM "DurableTask"
        WHERE id = ${task.id}
        FOR NO KEY UPDATE
      `);
      const current = locked.rows[0];
      if (!current || current.status !== 'PROCESSING') return emptyEffect();
      if (current.taskType !== task.taskType)
        throw new Error(
          'processing group membership projection fan-out type changed',
        );
      if (current.coalescingKey === null)
        throw new Error(
          'processing group membership projection fan-out has no coalescing key',
        );
      const successor = (
        await tx.execute<{ id: number }>(sql`
          SELECT id FROM "DurableTask"
          WHERE "coalescingKey" = ${current.coalescingKey} AND status = 'PENDING'
            AND id > ${task.id}
          LIMIT 1
        `)
      ).rows[0];
      // A newer task starts from the first manager and reconciles the latest
      // watermark. Every transaction is already a manager boundary, so this
      // task can yield without abandoning a projection page.
      if (successor) return emptyEffect();
      const afterManagerId = readCursor(current.afterManagerId);
      const next = await tx.execute<{ userId: number }>(sql`
        SELECT owner.id AS "userId" FROM "GroupMetaMemberFeed" fact
        JOIN "Account" owner ON fact.body -> 'namespaceId' = to_jsonb(0)
          AND owner.account = fact.body ->> 'account'
        JOIN "AccountThreadState" participant
          ON participant."accountId" = owner.id AND participant."threadId" = ${threadId}
        WHERE fact."threadId" = ${threadId}
          AND fact.operation = 'MEMBER_UPSERT' AND fact.body ->> 'role' IN ('OWNER', 'ADMIN')
          AND owner.id > ${afterManagerId}
        ORDER BY owner.id
        LIMIT 1
      `);
      const manager = next.rows[0];
      if (!manager) return emptyEffect();
      const [application] = (
        await tx.execute<{
          groupAccount: string;
          applicationEndId: number;
        }>(sql`
        SELECT thread."groupAccount" AS "groupAccount",
          meta."applicationEndId" AS "applicationEndId"
        FROM "MessageThread" thread
        JOIN "GroupMeta" meta ON meta."threadId" = thread.id
        WHERE thread.id = ${threadId}
      `)
      ).rows;
      if (!application || !application.groupAccount)
        throw new Error('group membership projection fan-out lost its group');
      // One fan-out watermark per direction, mirroring the group's own number
      // streams (migration 0009): applications onto joinRequestEndFeedId,
      // invitations onto groupInviteEndFeedId. Summing the two would advance
      // the application cursor on invitation events and erase the direction.
      // The forward-only guard publishes only bigger ids over smaller ones.
      // Account owns both allocators advanced below. Acquire it after the
      // thread lock and before AccountThreadState or client-feed writes.
      await lockAccountFeedAllocatorsInTx(tx, [manager.userId]);
      const updated = await tx.execute<{ accountId: number }>(sql`
        WITH ends AS (
          SELECT g."applicationEndId", g."invitationEndId"
          FROM "GroupMeta" g
          WHERE g."threadId" = ${threadId}
        )
        UPDATE "AccountThreadState" s
        SET "joinRequestEndFeedId" = ends."applicationEndId",
          "groupInviteEndFeedId" = ends."invitationEndId",
          "updatedAt" = CURRENT_TIMESTAMP
        FROM ends
        WHERE s."threadId" = ${threadId}
          AND s."accountId" = ${manager.userId}
          AND (s."joinRequestEndFeedId" < ends."applicationEndId"
            OR s."groupInviteEndFeedId" < ends."invitationEndId")
        RETURNING s."accountId" AS "accountId"
      `);
      const clientUpdates = updated.rows.length
        ? await captureThreadStateUpdatesInTx(
            tx,
            updated.rows.map((row) => row.accountId),
          )
        : [];
      await saveTaskCheckpointInTx(tx, task.id, {
        afterManagerId: String(manager.userId),
      });
      return { processed: true, clientUpdates };
    });
  }
}

function readCursor(value: string | null): bigint {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error('invalid group membership projection fan-out checkpoint');
  return BigInt(value);
}

function emptyEffect(): MembershipProjectionManagerEffect {
  return { processed: false, clientUpdates: [] };
}
