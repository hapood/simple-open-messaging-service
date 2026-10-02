import {
  readAccountTarget,
  type AccountTarget,
} from '../user/account-address.js';
import { isValidGroupAccount } from '../common/account.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { businessAccountScopeKey } from '../common/locks/account-business-lock.js';

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

export type QueryDeniedGroupMembershipRevocationTask =
  | {
      direction: 'GROUP';
      threadId: number;
      group: { account: string; domain: 'local'; namespaceId: 0 };
      member: Exclude<AccountTarget, number>;
      expectedAuthorizationEpoch: number;
    }
  | {
      direction: 'MEMBER';
      threadId: number;
      group: { account: string; domain: string; namespaceId: number };
      memberUserId: number;
      expectedAuthorizationEpoch: number;
    };

export function readQueryDeniedGroupMembershipRevocationTask(
  task: DurableTask,
): QueryDeniedGroupMembershipRevocationTask {
  const denial = readForbiddenGroupTask(task);
  const { memberUserId } = readForcedMemberRevokeTask(task);
  const groupAccount = task.payload.groupAccount;
  const groupDomain = task.payload.groupDomain;
  const groupNamespaceId = task.payload.groupNamespaceId;
  if (
    typeof groupAccount !== 'string' ||
    !isValidGroupAccount(groupAccount) ||
    typeof groupDomain !== 'string' ||
    groupDomain.length === 0 ||
    !Number.isSafeInteger(groupNamespaceId) ||
    (groupNamespaceId as number) < 0
  )
    throw new Error('invalid denied group identity');
  const group = {
    account: groupAccount,
    domain: groupDomain,
    namespaceId: groupNamespaceId as number,
  };
  if (
    businessAccountScopeKey({
      account: groupAccount,
      profileNamespaceId: groupNamespaceId as number,
    }) !== task.scopeKey
  )
    throw new Error('forced revoke belongs to another group');
  if (task.payload.direction === 'GROUP') {
    if (
      group.domain !== 'local' ||
      group.namespaceId !== 0 ||
      typeof memberUserId === 'number' ||
      memberUserId.namespaceId !== denial.namespaceId
    )
      throw new Error('invalid denied group direction');
    return {
      direction: 'GROUP',
      threadId: denial.threadId,
      group: { ...group, domain: 'local', namespaceId: 0 },
      member: memberUserId,
      expectedAuthorizationEpoch: denial.expectedAuthorizationEpoch,
    };
  }
  if (
    task.payload.direction !== 'MEMBER' ||
    typeof memberUserId !== 'number' ||
    group.domain !== denial.peerDomain ||
    group.namespaceId !== denial.namespaceId
  )
    throw new Error('invalid denied member direction');
  return {
    direction: 'MEMBER',
    threadId: denial.threadId,
    group,
    memberUserId,
    expectedAuthorizationEpoch: denial.expectedAuthorizationEpoch,
  };
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
