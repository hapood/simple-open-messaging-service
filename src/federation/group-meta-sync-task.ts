import { isValidGroupAccount, isValidSomfpDomain } from '../common/account.js';
import { DurableTaskType } from '../durable-task/durable-task.constants.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';

export interface GroupMetaSyncTaskPayload {
  groupId: number;
  groupAccount: string;
  peerDomain: string;
  namespaceId: number;
  through: string;
}

export type GroupMetaSyncCheckpoint =
  | {
      phase: 'PULL';
      mode: 'full' | 'delta';
      after: string;
      through: string;
    }
  | {
      phase: 'CLEANUP_MEMBERS';
      mode: 'full';
      through: string;
    }
  | {
      phase: 'FINALIZE';
      mode: 'full';
      through: string;
    }
  | {
      phase: 'FINALIZE';
      mode: 'delta';
      through: string;
    };

export function readGroupMetaSyncTask(task: DurableTask): {
  payload: GroupMetaSyncTaskPayload;
  checkpoint: GroupMetaSyncCheckpoint;
} {
  if (
    task.kind !== 'PROJECTION' ||
    task.scopeType !== 'GROUP' ||
    task.taskType !== DurableTaskType.SYNC_GROUP_META
  )
    throw new Error('invalid group-meta sync task kind');
  return {
    payload: readGroupMetaSyncPayload(task.payload),
    checkpoint: readGroupMetaSyncCheckpoint(task.checkpoint),
  };
}

export function readGroupMetaSyncPayload(
  value: Record<string, unknown>,
): GroupMetaSyncTaskPayload {
  requireExactKeys(value, [
    'groupId',
    'groupAccount',
    'peerDomain',
    'namespaceId',
    'through',
  ]);
  if (!Number.isSafeInteger(value.groupId) || Number(value.groupId) <= 0)
    throw new Error('invalid group-meta sync groupId');
  if (
    typeof value.groupAccount !== 'string' ||
    !isValidGroupAccount(value.groupAccount)
  )
    throw new Error('invalid group-meta sync groupAccount');
  if (
    typeof value.peerDomain !== 'string' ||
    !isValidSomfpDomain(value.peerDomain)
  )
    throw new Error('invalid group-meta sync peerDomain');
  if (
    !Number.isSafeInteger(value.namespaceId) ||
    Number(value.namespaceId) <= 0
  )
    throw new Error('invalid group-meta sync namespaceId');
  if (!isDecimal(value.through))
    throw new Error('invalid group-meta sync through');
  return {
    groupId: Number(value.groupId),
    groupAccount: value.groupAccount,
    peerDomain: value.peerDomain,
    namespaceId: Number(value.namespaceId),
    through: value.through,
  };
}

export function readGroupMetaSyncCheckpoint(
  value: Record<string, unknown>,
): GroupMetaSyncCheckpoint {
  const phase = value.phase;
  const mode = value.mode;
  if (phase === 'PULL') {
    requireExactKeys(value, ['phase', 'mode', 'after', 'through']);
    if (mode !== 'full' && mode !== 'delta')
      throw new Error('invalid group-meta sync mode');
    if (!isDecimal(value.after) || !isDecimal(value.through))
      throw new Error('invalid group-meta sync pull cursor');
    if (BigInt(value.through) < BigInt(value.after))
      throw new Error('invalid group-meta sync pull boundary');
    return { phase, mode, after: value.after, through: value.through };
  }
  if (phase !== 'CLEANUP_MEMBERS' && phase !== 'FINALIZE')
    throw new Error('invalid group-meta sync phase');
  requireExactKeys(value, ['phase', 'mode', 'through']);
  if (!isDecimal(value.through))
    throw new Error('invalid group-meta sync final boundary');
  if (phase === 'CLEANUP_MEMBERS') {
    if (mode !== 'full')
      throw new Error('delta group-meta sync cannot clean full members');
    return { phase, mode, through: value.through };
  }
  if (mode === 'full' || mode === 'delta')
    return { phase, mode, through: value.through };
  throw new Error('invalid group-meta sync mode');
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    keys.length !== required.length ||
    keys.some((key, index) => key !== required[index])
  )
    throw new Error('invalid group-meta sync object shape');
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}
