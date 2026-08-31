import type { DomainCommand } from '../domain-command/domain-command.types.js';

export function readDisbandGroupCommand(command: DomainCommand): {
  actorUserId: number;
  threadId: number;
  deleteForUserId: number | null;
} {
  assertGroupCommand(command);
  if (command.actorUserId === null) {
    throw new Error('disband command has no actor');
  }
  const threadId = readPositiveInteger(command.payload.threadId, 'thread ID');
  const deleteForUserId = command.payload.deleteForUserId;
  if (
    deleteForUserId !== null &&
    (!Number.isSafeInteger(deleteForUserId) || (deleteForUserId as number) < 1)
  ) {
    throw new Error('disband command has an invalid delete user ID');
  }
  if (deleteForUserId !== null && deleteForUserId !== command.actorUserId) {
    throw new Error('disband command may delete data only for its actor');
  }
  return {
    actorUserId: command.actorUserId,
    threadId,
    deleteForUserId: deleteForUserId as number | null,
  };
}

export function readDissolvedMemberRevokeCommand(command: DomainCommand): {
  threadId: number;
  memberUserId: number;
  deleteData: boolean;
} {
  assertGroupCommand(command);
  if (command.parentCommandId === null) {
    throw new Error('dissolved-member revoke has no parent');
  }
  const threadId = readPositiveInteger(command.payload.threadId, 'thread ID');
  const memberUserId = readPositiveInteger(
    command.payload.memberUserId,
    'member user ID',
  );
  const deleteData = command.payload.deleteData;
  if (typeof deleteData !== 'boolean') {
    throw new Error('dissolved-member revoke has an invalid deleteData flag');
  }
  return { threadId, memberUserId, deleteData };
}

function assertGroupCommand(command: DomainCommand): void {
  if (command.aggregateType !== 'GROUP') {
    throw new Error('group command has the wrong aggregate type');
  }
}

function readPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`group command has an invalid ${name}`);
  }
  return value as number;
}
