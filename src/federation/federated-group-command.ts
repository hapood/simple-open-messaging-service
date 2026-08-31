import type { DomainCommand } from '../domain-command/domain-command.types.js';

export function readFederatedGroupCommand(command: DomainCommand): {
  actorUserId: number;
  account: string;
  domain: string;
} {
  if (command.aggregateType !== 'GROUP' || command.actorUserId === null) {
    throw new Error('federated group command has an invalid scope');
  }
  const account = command.payload.account;
  const domain = command.payload.domain;
  if (
    typeof account !== 'string' ||
    !account.startsWith('!') ||
    typeof domain !== 'string' ||
    !domain
  ) {
    throw new Error('federated group command has an invalid address');
  }
  return { actorUserId: command.actorUserId, account, domain };
}

export function readRequestFederatedGroupJoinCommand(command: DomainCommand) {
  const base = readFederatedGroupCommand(command);
  const note = command.payload.note;
  const displayName = command.payload.displayName;
  const avatar = command.payload.avatar;
  if (
    typeof note !== 'string' ||
    typeof displayName !== 'string' ||
    !displayName ||
    (avatar !== undefined && typeof avatar !== 'string')
  ) {
    throw new Error('federated group command has invalid request metadata');
  }
  return { ...base, note, displayName, ...(avatar ? { avatar } : {}) };
}
