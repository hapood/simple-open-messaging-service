import {
  GroupRole,
  type GroupRole as GroupRoleValue,
} from '../database/enums.js';
import type { DomainCommand } from '../domain-command/domain-command.types.js';

export interface GroupMembershipCommandBase {
  actorUserId: number;
  threadId: number;
}

export function readLeaveGroupCommand(
  command: DomainCommand,
): GroupMembershipCommandBase & { deleteData: boolean } {
  const base = readBase(command);
  if (typeof command.payload.deleteData !== 'boolean') {
    throw new Error('leave-group command has an invalid deleteData flag');
  }
  return { ...base, deleteData: command.payload.deleteData };
}

export function readTargetGroupCommand(
  command: DomainCommand,
): GroupMembershipCommandBase & { targetUserId: number } {
  return {
    ...readBase(command),
    targetUserId: readPositiveInteger(
      command.payload.targetUserId,
      'target user ID',
    ),
  };
}

export function readSetGroupRoleCommand(
  command: DomainCommand,
): ReturnType<typeof readTargetGroupCommand> & { role: GroupRoleValue } {
  const base = readTargetGroupCommand(command);
  const role = command.payload.role;
  if (role !== GroupRole.ADMIN && role !== GroupRole.MEMBER) {
    throw new Error('set-group-role command has an invalid role');
  }
  return { ...base, role };
}

export function readGroupRequestCommand(
  command: DomainCommand,
): GroupMembershipCommandBase & {
  requestId: bigint;
  memberUserId: number;
} {
  const base = readBase(command);
  const requestId = command.payload.requestId;
  if (typeof requestId !== 'string' || !/^[1-9][0-9]*$/.test(requestId)) {
    throw new Error('group request command has an invalid request ID');
  }
  return {
    ...base,
    requestId: BigInt(requestId),
    memberUserId: readPositiveInteger(
      command.payload.memberUserId,
      'member user ID',
    ),
  };
}

export function readAcceptGroupInvitationCommand(
  command: DomainCommand,
): GroupMembershipCommandBase {
  return readBase(command);
}

function readBase(command: DomainCommand): GroupMembershipCommandBase {
  if (command.aggregateType !== 'GROUP') {
    throw new Error('group membership command has the wrong aggregate type');
  }
  if (command.actorUserId === null) {
    throw new Error('group membership command has no actor');
  }
  return {
    actorUserId: command.actorUserId,
    threadId: readPositiveInteger(command.payload.threadId, 'thread ID'),
  };
}

function readPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`group membership command has an invalid ${name}`);
  }
  return value as number;
}
