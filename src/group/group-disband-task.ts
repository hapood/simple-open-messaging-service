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

export function readForcedMemberRevokeTask(task: DurableTask): {
  threadId: number;
  memberUserId: AccountTarget;
} {
  assertGroupTask(task);
  const threadId = readPositiveInteger(task.payload.threadId, 'thread ID');
  const memberUserId = readAccountTarget(task.payload.memberUserId);
  return { threadId, memberUserId };
}

export function readForbiddenGroupTask(task: DurableTask): {
  threadId: number;
  peerDomain: string;
  namespaceId: number;
  expectedAuthorizationEpoch: number;
} {
  assertGroupTask(task);
  const { peerDomain, expectedAuthorizationEpoch } = task.payload;
  if (typeof peerDomain !== 'string' || !peerDomain || peerDomain === 'local')
    throw new Error('invalid denied peer domain');
  if (
    !Number.isSafeInteger(expectedAuthorizationEpoch) ||
    (expectedAuthorizationEpoch as number) < 0
  )
    throw new Error('invalid denied authorization epoch');
  return {
    threadId: readPositiveInteger(task.payload.threadId, 'thread ID'),
    peerDomain,
    namespaceId: readPositiveInteger(task.payload.namespaceId, 'namespace ID'),
    expectedAuthorizationEpoch: expectedAuthorizationEpoch as number,
  };
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
