import type { DomainCommand } from '../domain-command/domain-command.types.js';

export function readFriendInviteCommand(command: DomainCommand): {
  actorUserId: number;
  inviteId: string;
} {
  if (command.aggregateType !== 'USER_PAIR') {
    throw new Error('friend invite command has the wrong aggregate type');
  }
  if (command.actorUserId === null) {
    throw new Error('friend invite command has no actor');
  }
  const inviteId = command.payload.inviteId;
  if (typeof inviteId !== 'string' || !/^[1-9][0-9]*$/.test(inviteId)) {
    throw new Error('friend invite command has an invalid invite ID');
  }
  return { actorUserId: command.actorUserId, inviteId };
}
