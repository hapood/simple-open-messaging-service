import type { DurableTask } from '../durable-task/durable-task.types.js';

export interface FederatedRelationshipRequestTask {
  actorUserId: number;
  account: string;
  domain: string;
}

export function readFederatedRelationshipRequestTask(
  task: DurableTask,
): FederatedRelationshipRequestTask {
  if (task.scopeType !== 'USER_PAIR' || task.actorUserId === null) {
    throw new Error('federated relationship request task has an invalid scope');
  }
  const account = readNonEmptyString(task.payload.account, 'account');
  const domain = readNonEmptyString(task.payload.domain, 'domain');
  return { actorUserId: task.actorUserId, account, domain };
}

export function readSendFederatedRelationshipRequestTask(
  task: DurableTask,
): FederatedRelationshipRequestTask & {
  note: string;
  displayName: string;
  avatar?: string;
} {
  const base = readFederatedRelationshipRequestTask(task);
  const note = readString(task.payload.note, 'note');
  const displayName = readNonEmptyString(
    task.payload.displayName,
    'display name',
  );
  const avatar = task.payload.avatar;
  if (avatar !== undefined && typeof avatar !== 'string') {
    throw new Error(
      'federated relationship request task has an invalid avatar',
    );
  }
  return { ...base, note, displayName, ...(avatar ? { avatar } : {}) };
}

function readNonEmptyString(value: unknown, name: string): string {
  const result = readString(value, name);
  if (!result)
    throw new Error(`federated relationship request task has an empty ${name}`);
  return result;
}

function readString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(
      `federated relationship request task has an invalid ${name}`,
    );
  }
  return value;
}
