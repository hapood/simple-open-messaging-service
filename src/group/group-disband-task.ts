import {
  readAccountTarget,
  type AccountTarget,
} from '../user/account-address.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';

export function readDisbandGroupTask(task: DurableTask): {
  actorUserId: number;
  threadId: number;
} {
  assertGroupTask(task);
  if (task.actorUserId === null) {
    throw new Error('disband task has no actor');
  }
  const threadId = readPositiveInteger(task.payload.threadId, 'thread ID');
  return {
    actorUserId: task.actorUserId,
    threadId,
  };
}

export function readDissolvedMemberRevokeTask(task: DurableTask): {
  threadId: number;
  memberUserId: AccountTarget;
} {
  assertGroupTask(task);
  if (task.parentTaskId === null) {
    throw new Error('dissolved-member revoke has no parent');
  }
  const threadId = readPositiveInteger(task.payload.threadId, 'thread ID');
  const memberUserId = readAccountTarget(task.payload.memberUserId);
  return { threadId, memberUserId };
}

function assertGroupTask(task: DurableTask): void {
  if (task.scopeType !== 'GROUP') {
    throw new Error('group task has the wrong scope type');
  }
}

function readPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`group task has an invalid ${name}`);
  }
  return value as number;
}
