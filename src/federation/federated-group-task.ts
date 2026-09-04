import type { DurableTask } from '../durable-task/durable-task.types.js';

export function readFederatedGroupTask(task: DurableTask): {
  actorUserId: number;
  account: string;
  domain: string;
} {
  if (task.scopeType !== 'GROUP' || task.actorUserId === null) {
    throw new Error('federated group task has an invalid scope');
  }
  const account = task.payload.account;
  const domain = task.payload.domain;
  if (
    typeof account !== 'string' ||
    !account.startsWith('!') ||
    typeof domain !== 'string' ||
    !domain
  ) {
    throw new Error('federated group task has an invalid address');
  }
  return { actorUserId: task.actorUserId, account, domain };
}

export function readRequestFederatedGroupJoinTask(task: DurableTask) {
  const base = readFederatedGroupTask(task);
  const note = task.payload.note;
  const displayName = task.payload.displayName;
  const avatar = task.payload.avatar;
  if (
    typeof note !== 'string' ||
    typeof displayName !== 'string' ||
    !displayName ||
    (avatar !== undefined && typeof avatar !== 'string')
  ) {
    throw new Error('federated group task has invalid request metadata');
  }
  return { ...base, note, displayName, ...(avatar ? { avatar } : {}) };
}
