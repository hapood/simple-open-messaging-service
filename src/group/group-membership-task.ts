import {
  readAccountTarget,
  type AccountTarget,
} from '../user/account-address.js';
import {
  GroupRole,
  type GroupRole as GroupRoleValue,
} from '../database/enums.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';

export interface GroupMembershipTaskBase {
  actorUserId: number;
  threadId: number;
}

export function readLeaveGroupTask(task: DurableTask): GroupMembershipTaskBase {
  return readBase(task);
}

export function readTargetGroupTask(
  task: DurableTask,
): GroupMembershipTaskBase & { targetUserId: AccountTarget } {
  return {
    ...readBase(task),
    targetUserId: readAccountTarget(task.payload.targetUserId),
  };
}

export function readSetGroupRoleTask(
  task: DurableTask,
): ReturnType<typeof readTargetGroupTask> & { role: GroupRoleValue } {
  const base = readTargetGroupTask(task);
  const role = task.payload.role;
  if (role !== GroupRole.ADMIN && role !== GroupRole.MEMBER) {
    throw new Error('set-group-role task has an invalid role');
  }
  return { ...base, role };
}

export function readGroupRequestTask(
  task: DurableTask,
): GroupMembershipTaskBase & {
  requestId: bigint;
  memberUserId: AccountTarget;
} {
  const base = readBase(task);
  const requestId = task.payload.requestId;
  if (typeof requestId !== 'string' || !/^[1-9][0-9]*$/.test(requestId)) {
    throw new Error('group request task has an invalid request ID');
  }
  return {
    ...base,
    requestId: BigInt(requestId),
    memberUserId: readAccountTarget(task.payload.memberUserId),
  };
}

export function readAcceptGroupInvitationTask(
  task: DurableTask,
): GroupMembershipTaskBase {
  return readBase(task);
}

function readBase(task: DurableTask): GroupMembershipTaskBase {
  if (task.scopeType !== 'GROUP') {
    throw new Error('group membership task has the wrong scope type');
  }
  if (task.actorUserId === null) {
    throw new Error('group membership task has no actor');
  }
  return {
    actorUserId: task.actorUserId,
    threadId: readPositiveInteger(task.payload.threadId, 'thread ID'),
  };
}

function readPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`group membership task has an invalid ${name}`);
  }
  return value as number;
}
