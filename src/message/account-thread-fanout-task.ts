import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import { insertPendingTaskInTx } from '../durable-task/task-admission.js';
import {
  requireThreadContentLockInTx,
  type ThreadContentLock,
} from '../relationship/thread-content-lock.js';
import { relationshipEndpointMatchesUserSql } from '../relationship/relationship-authorization.js';
import {
  localAccountsForTargetsInTx,
  type AccountTarget,
} from '../user/account-address.js';
import {
  parseThreadFanoutTarget,
  type ThreadFanoutTarget,
} from './thread-fanout-task.js';

export interface AccountThreadFanoutTarget extends ThreadFanoutTarget {
  accountId: number;
}

export function accountThreadFanoutScope(
  threadId: number,
  accountId: number,
): string {
  return JSON.stringify(['ACCOUNT_THREAD_FANOUT', threadId, accountId]);
}

export function parseAccountThreadFanoutTarget(
  value: Record<string, unknown>,
): AccountThreadFanoutTarget {
  if (
    !Number.isSafeInteger(value.accountId) ||
    (value.accountId as number) <= 0
  )
    throw new Error('Invalid account thread fanout target');
  return {
    ...parseThreadFanoutTarget(value),
    accountId: value.accountId as number,
  };
}

/** A departure targets both local P2P endpoints, or the departing local group member.
 * Keep every target independent of ordinary fanout and of later departure tasks. */
export async function enqueueDepartureFanoutsInTx(
  tx: DatabaseTransaction,
  lock: ThreadContentLock,
  target: ThreadFanoutTarget,
  kind: 'P2P' | 'GROUP',
  subject: AccountTarget,
): Promise<void> {
  await requireThreadContentLockInTx(tx, target.threadId, lock);
  const recipients =
    kind === 'GROUP'
      ? await localAccountsForTargetsInTx(tx, [subject])
      : (
          await tx.execute<{ id: number }>(sql`
        SELECT a.id FROM "Account" a
        JOIN "AccountThreadState" s ON s."accountId" = a.id
        WHERE s."threadId" = ${target.threadId} AND EXISTS (
          SELECT 1 FROM "RelationshipPair" pair
          WHERE pair.kind = 'P2P' AND pair."threadId" = s."threadId"
            AND (${relationshipEndpointMatchesUserSql(sql`pair`, 'A', sql`a`)}
              OR ${relationshipEndpointMatchesUserSql(sql`pair`, 'B', sql`a`)})
        ) ORDER BY a.id
      `)
        ).rows;
  for (const recipient of recipients) {
    const payload = parseAccountThreadFanoutTarget({
      ...target,
      accountId: recipient.id,
    });
    await insertPendingTaskInTx(tx, {
      kind: 'PROJECTION',
      scopeType: 'THREAD',
      scopeKey: accountThreadFanoutScope(target.threadId, recipient.id),
      taskType: DurableTaskType.FAN_OUT_ACCOUNT_THREAD_CONTENT,
      payload: { ...payload },
    });
  }
}
