import { describe, expect, it, vi } from 'vitest';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { GroupRevokeFanoutService } from './group-revoke-fanout.service.js';
import { businessAccountScopeKey } from '../business/shared/locks/account-business-lock.js';
import { requireThreadContentLockInTx } from '../business/shared/locks/thread-content-lock.js';

vi.mock('../business/shared/locks/thread-content-lock.js', () => ({
  requireThreadContentLockInTx: vi.fn().mockResolvedValue({ threadId: 12 }),
}));
vi.mock('./group-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./group-state.js')>()),
  readGroupState: vi
    .fn()
    .mockResolvedValue({ account: '!group', domain: 'local' }),
}));

const parent = {
  id: 10n,
  kind: 'MUTATION',
  scopeType: 'GROUP',
  scopeKey: businessAccountScopeKey({ account: '!group', domain: 'local' }),
  taskType: 'DISBAND_GROUP',
  actorUserId: 7,
  payload: { threadId: 12 },
  checkpoint: {},
  coalescingKey: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('GroupRevokeFanoutService', () => {
  it('stops stale forbidden enumeration before admitting or checkpointing children', async () => {
    const task = {
      ...parent,
      taskType: 'REVOKE_FORBIDDEN_GROUP',
      payload: {
        threadId: 12,
        peerDomain: 'peer.test',
        namespaceId: 5,
        expectedAuthorizationEpoch: 8,
      },
    };
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              status: 'PROCESSING',
              taskType: task.taskType,
              afterPairId: '41',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ authorizationEpoch: 9 }] }),
      update: vi.fn(),
    };
    const enqueueTaskInTx = vi.fn();
    const service = new GroupRevokeFanoutService(
      {
        db: {
          transaction: (run: (tx: unknown) => unknown) => run(tx),
        },
      } as never,
      { enqueueTaskInTx } as never,
    );
    await expect(service.insertNextMember(task, 12)).resolves.toBe(false);
    expect(enqueueTaskInTx).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

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
    const checkpointWhere = vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: parent.id }]),
    }));
    const checkpointSet = vi.fn().mockReturnValue({ where: checkpointWhere });
    const tx = {
      execute,
      insert: vi.fn().mockReturnValue({ values: childValues }),
      update: vi.fn().mockReturnValue({ set: checkpointSet }),
    };
    const transaction = vi.fn(
      (callback: (value: typeof tx) => Promise<boolean>) => callback(tx),
    );
    const service = new GroupRevokeFanoutService(
      {
        db: { transaction },
      } as never,
      { enqueueTaskInTx: childValues } as never,
    );

    await expect(service.insertNextMember(parent, 12)).resolves.toBe(true);

    expect(childValues).toHaveBeenCalledWith(tx, {
      scope: { type: 'GROUP', address: { account: '!group', domain: 'local' } },
      taskType: 'FORCE_REVOKE_GROUP_MEMBER',
      actorUserId: 7,
      payload: {
        threadId: 12,
        memberUserId: { account: 'member', domain: 'local', namespaceId: 0 },
      },
    });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(requireThreadContentLockInTx).toHaveBeenCalledWith(tx, 12);
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
    const service = new GroupRevokeFanoutService(
      {
        db: {
          transaction: (callback: (value: typeof tx) => Promise<boolean>) =>
            callback(tx),
        },
      } as never,
      { enqueueTaskInTx: vi.fn() } as never,
    );

    await expect(service.insertNextMember(parent, 12)).resolves.toBe(false);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });
});
