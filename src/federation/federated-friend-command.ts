import type { DomainCommand } from '../domain-command/domain-command.types.js';

export interface FederatedFriendCommand {
  actorUserId: number;
  account: string;
  domain: string;
}

export function readFederatedFriendCommand(
  command: DomainCommand,
): FederatedFriendCommand {
  if (command.aggregateType !== 'USER_PAIR' || command.actorUserId === null) {
    throw new Error('federated friend command has an invalid scope');
  }
  const account = readNonEmptyString(command.payload.account, 'account');
  const domain = readNonEmptyString(command.payload.domain, 'domain');
  return { actorUserId: command.actorUserId, account, domain };
}

export function readSendFederatedFriendCommand(command: DomainCommand):
  FederatedFriendCommand & {
    note: string;
    displayName: string;
    avatar?: string;
  } {
  const base = readFederatedFriendCommand(command);
  const note = readString(command.payload.note, 'note');
  const displayName = readNonEmptyString(
    command.payload.displayName,
    'display name',
  );
  const avatar = command.payload.avatar;
  if (avatar !== undefined && typeof avatar !== 'string') {
    throw new Error('federated friend command has an invalid avatar');
  }
  return { ...base, note, displayName, ...(avatar ? { avatar } : {}) };
}

function readNonEmptyString(value: unknown, name: string): string {
  const result = readString(value, name);
  if (!result) throw new Error(`federated friend command has an empty ${name}`);
  return result;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`federated friend command has an invalid ${name}`);
  }
  return value;
}
