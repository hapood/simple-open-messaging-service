import { describe, expect, it } from 'vitest';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import {
  readGroupMetaSyncCheckpoint,
  readGroupMetaSyncTask,
} from './group-meta-sync-task.js';

const task = {
  id: 4n,
  parentTaskId: null,
  kind: 'PROJECTION',
  scopeType: 'GROUP',
  scopeKey: 'group-key',
  taskType: 'SYNC_GROUP_META',
  actorUserId: null,
  payload: {
    groupId: 8,
    groupAccount: '!group',
    peerDomain: 'peer.test',
    namespaceId: 3,
    through: '20',
  },
  checkpoint: {
    phase: 'PULL',
    mode: 'delta',
    after: '10',
    through: '20',
  },
  coalescingKey: 'group-meta',
  supersededByTaskId: null,
  status: 'ASYNC_PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('group-meta sync task contract', () => {
  it('reads the closed payload and pull checkpoint', () => {
    expect(readGroupMetaSyncTask(task)).toEqual({
      payload: task.payload,
      checkpoint: task.checkpoint,
    });
  });

  it('accepts only the defined cleanup and finalization shapes', () => {
    expect(
      readGroupMetaSyncCheckpoint({
        phase: 'CLEANUP_MEMBERS',
        mode: 'full',
        through: '20',
      }),
    ).toEqual({
      phase: 'CLEANUP_MEMBERS',
      mode: 'full',
      through: '20',
    });
    expect(
      readGroupMetaSyncCheckpoint({
        phase: 'FINALIZE',
        mode: 'delta',
        through: '20',
      }),
    ).toEqual({ phase: 'FINALIZE', mode: 'delta', through: '20' });
    expect(() =>
      readGroupMetaSyncCheckpoint({
        phase: 'CLEANUP_MEMBERS',
        mode: 'delta',
        through: '20',
      }),
    ).toThrow('cannot clean full members');
  });

  it('rejects unknown fields and inverted boundaries', () => {
    expect(() =>
      readGroupMetaSyncTask({
        ...task,
        payload: { ...task.payload, unexpected: true },
      }),
    ).toThrow('object shape');
    expect(() =>
      readGroupMetaSyncCheckpoint({
        phase: 'PULL',
        mode: 'full',
        after: '21',
        through: '20',
      }),
    ).toThrow('pull boundary');
  });
});
