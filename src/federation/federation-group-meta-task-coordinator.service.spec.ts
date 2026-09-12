import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import { FederationGroupMetaTaskCoordinator } from './federation-group-meta-task-coordinator.service.js';

type Blocker = {
  id: bigint;
  status: 'PENDING' | 'PROCESSING' | 'ASYNC_PROCESSING' | 'FAILED';
  payload: Record<string, unknown>;
};

function payload(through: string) {
  return {
    groupId: 8,
    groupAccount: '!group',
    peerDomain: 'peer.test',
    namespaceId: 3,
    through,
  };
}

function harness(metaEndId: bigint | null, blockers: Blocker[] = []) {
  let executeIndex = 0;
  const execute = vi.fn(async () => {
    executeIndex += 1;
    if (executeIndex === 1) return { rows: [] };
    if (executeIndex === 2) return { rows: [{ groupId: 8, metaEndId }] };
    return { rows: blockers };
  });
  const returning = vi.fn(async () => [{ taskId: 40n }]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const where = vi.fn(() => ({
    returning: vi.fn().mockResolvedValue([{ taskId: blockers[0]?.id ?? 40n }]),
  }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const tx = { execute, insert, update };
  const transaction = vi.fn(
    async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
  );
  const database = { db: { transaction } } as unknown as DatabaseService;
  return {
    coordinator: new FederationGroupMetaTaskCoordinator(database),
    transaction,
    tx,
    execute,
    values,
    set,
    insert,
    update,
  };
}

const input = {
  groupId: 8,
  groupAccount: '!group',
  peerDomain: 'peer.test',
  namespaceId: 3,
  through: 20n,
};

describe('FederationGroupMetaTaskCoordinator', () => {
  it('returns ready without creating a task when the mirror reached the head', async () => {
    const h = harness(20n);

    await expect(h.coordinator.ensure(input)).resolves.toEqual({
      ready: true,
      committedThrough: 20n,
    });
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('creates an initial full task when the mirror has no committed feed', async () => {
    const h = harness(null);

    await expect(h.coordinator.ensure(input)).resolves.toEqual({
      ready: false,
      taskId: 40n,
    });
    expect(h.values).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'PROJECTION',
        taskType: 'SYNC_GROUP_META',
        payload: payload('20'),
        checkpoint: {
          phase: 'PULL',
          mode: 'full',
          after: '0',
          through: '20',
        },
        status: 'PENDING',
      }),
    );
  });

  it('can create the dependency in the caller state-item transaction', async () => {
    const h = harness(null);

    await expect(
      h.coordinator.ensureInTx(h.tx as never, input),
    ).resolves.toEqual({
      ready: false,
      taskId: 40n,
    });

    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.insert).toHaveBeenCalledOnce();
  });

  it('raises an existing pending target in place', async () => {
    const h = harness(5n, [
      { id: 30n, status: 'PENDING', payload: payload('25') },
    ]);

    await h.coordinator.ensure(input);

    expect(h.set).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: payload('25'),
        checkpoint: {
          phase: 'PULL',
          mode: 'delta',
          after: '5',
          through: '25',
        },
      }),
    );
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('creates a pending successor instead of extending an active task', async () => {
    const h = harness(5n, [
      { id: 31n, status: 'ASYNC_PROCESSING', payload: payload('10') },
    ]);

    await expect(h.coordinator.ensure(input)).resolves.toEqual({
      ready: false,
      taskId: 40n,
    });
    expect(h.values).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: payload('20'),
        checkpoint: {
          phase: 'PULL',
          mode: 'delta',
          after: '5',
          through: '20',
        },
      }),
    );
  });

  it('reuses an active task that already covers the target', async () => {
    const h = harness(5n, [
      { id: 31n, status: 'ASYNC_PROCESSING', payload: payload('25') },
    ]);

    await expect(h.coordinator.ensure(input)).resolves.toEqual({
      ready: false,
      taskId: 31n,
    });
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('admits new work after a failure from committed progress', async () => {
    const h = harness(5n, [
      { id: 31n, status: 'FAILED', payload: payload('10') },
    ]);

    await expect(h.coordinator.ensure(input)).resolves.toEqual({
      ready: false,
      taskId: 40n,
    });
    expect(h.values).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpoint: { phase: 'PULL', mode: 'delta', after: '5', through: '20' },
      }),
    );
  });
});
