import type { DatabaseTransaction } from '../database/database.service.js';
import type { DurableTaskQueueService } from '../durable-task/durable-task-queue.service.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../user/account-address.js';
import { systemAccountIdInTx } from '../user/system-account.js';

/** Called within the active-to-inactive transition, after its business locks. */
export async function enqueueReverseP2PRevokeInTx(
  tx: DatabaseTransaction,
  tasks: DurableTaskQueueService,
  authorUserId: number,
  targetUserId: AccountTarget,
): Promise<void> {
  const endpoints = await Promise.all([
    accountAddressInTx(tx, authorUserId),
    accountAddressInTx(tx, targetUserId),
  ]);
  await tasks.enqueueTaskInTx(tx, {
    scope: { type: 'USER_PAIR', endpoints },
    taskType: DurableTaskType.REVOKE_USER_RELATIONSHIP,
    actorUserId: await systemAccountIdInTx(tx),
    payload: {
      operation: 'RESPOND_TO_REVOKE',
      intentAuthorUserId: authorUserId,
      targetUserId,
    },
  });
}

export async function enqueueReverseGroupRevokeInTx(
  tx: DatabaseTransaction,
  tasks: DurableTaskQueueService,
  input: {
    threadId: number;
    group: { account: string; domain: string };
    memberUserId: AccountTarget;
    author: 'MEMBER' | 'GROUP';
  },
): Promise<void> {
  await tasks.enqueueTaskInTx(tx, {
    scope: { type: 'GROUP', address: input.group },
    taskType:
      input.author === 'GROUP'
        ? DurableTaskType.REVOKE_GROUP_RELATIONSHIP
        : DurableTaskType.REVOKE_USER_RELATIONSHIP,
    actorUserId: await systemAccountIdInTx(tx),
    payload: {
      operation: 'RESPOND_TO_REVOKE',
      threadId: input.threadId,
      memberUserId: input.memberUserId,
      ...(input.author === 'MEMBER'
        ? { intentAuthorUserId: input.memberUserId }
        : {}),
    },
  });
}
