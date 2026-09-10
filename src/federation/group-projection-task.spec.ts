import { describe, expect, it } from 'vitest';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { readGroupMetaHeadFanoutTask } from './group-projection-task.js';

const task = {
  id: 1n,
  kind: 'PROJECTION',
  scopeType: 'GROUP',
  scopeKey: 'group',
  taskType: 'FAN_OUT_GROUP_META_HEAD',
  actorUserId: null,
  payload: { threadId: 7 },
  checkpoint: { afterAudienceId: '0' },
  coalescingKey: 'projection',
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('Group Meta head fan-out task', () => {
  it('reads the closed thread payload', () => {
    expect(readGroupMetaHeadFanoutTask(task)).toEqual({ threadId: 7 });
  });

  it.each([
    { ...task, payload: { threadId: 0 } },
    { ...task, payload: { threadId: 7, revision: 2 } },
    { ...task, kind: 'MUTATION' as const },
  ])('rejects a malformed task', (candidate) => {
    expect(() => readGroupMetaHeadFanoutTask(candidate)).toThrow(
      'invalid Group Meta head fan-out task',
    );
  });
});
