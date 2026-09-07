import { describe, expect, it, vi } from 'vitest';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { GroupDisbandFanoutService } from './group-disband-fanout.service.js';

const parent = {
  id: 10n,
  parentTaskId: null,
  kind: 'MUTATION',
  scopeType: 'GROUP',
  scopeKey: 'group-key',
  taskType: 'DISBAND_GROUP',
  actorUserId: 7,
  payload: { threadId: 12 },
  checkpoint: {},
  coalescingKey: null,
  supersededByTaskId: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('GroupDisbandFanoutService', () => {
  it('atomically admits one child and advances the relationship-pair cursor', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10n,
            status: 'PROCESSING',
            taskType: 'DISBAND_GROUP',
            afterPairId: '40',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { pairId: '41', account: 'member', domain: 'local', namespaceId: 0 },
        ],
      });
    const childValues = vi.fn().mockResolvedValue(undefined);
    const checkpointWhere = vi.fn().mockResolvedValue(undefined);
    const checkpointSet = vi.fn().mockReturnValue({ where: checkpointWhere });
    const tx = {
      execute,
      insert: vi.fn().mockReturnValue({ values: childValues }),
      update: vi.fn().mockReturnValue({ set: checkpointSet }),
    };
    const transaction = vi.fn(
      (callback: (value: typeof tx) => Promise<boolean>) => callback(tx),
    );
    const service = new GroupDisbandFanoutService({
      db: { transaction },
    } as never);

    await expect(service.insertNextMember(parent, 12)).resolves.toBe(true);

    expect(childValues).toHaveBeenCalledWith({
      parentTaskId: 10n,
      kind: 'MUTATION',
      scopeType: 'GROUP',
      scopeKey: 'group-key',
      taskType: 'REVOKE_DISSOLVED_GROUP_MEMBER',
      actorUserId: 7,
      payload: {
        threadId: 12,
        memberUserId: { account: 'member', domain: 'local', namespaceId: 0 },
      },
      status: 'PENDING',
    });
    expect(checkpointSet).toHaveBeenCalledWith({
      checkpoint: { afterPairId: '41' },
    });
    expect(childValues.mock.invocationCallOrder[0]).toBeLessThan(
      checkpointSet.mock.invocationCallOrder[0],
    );
  });

  it('does not advance the cursor when no active relationship remains', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 10n,
            status: 'PROCESSING',
            taskType: 'DISBAND_GROUP',
            afterPairId: '41',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const tx = {
      execute,
      insert: vi.fn(),
      update: vi.fn(),
    };
    const service = new GroupDisbandFanoutService({
      db: {
        transaction: (callback: (value: typeof tx) => Promise<boolean>) =>
          callback(tx),
      },
    } as never);

    await expect(service.insertNextMember(parent, 12)).resolves.toBe(false);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });
});
