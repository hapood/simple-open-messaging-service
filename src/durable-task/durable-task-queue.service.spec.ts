import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import { DurableTaskQueueService } from './durable-task-queue.service.js';

function createHarness(taskIds: bigint[] = [1n]) {
  const execute = vi.fn(async () => undefined);
  const returning = vi.fn(async () => {
    const taskId = taskIds.shift();
    return taskId === undefined ? [] : [{ taskId }];
  });
  const values = vi.fn((input: Record<string, unknown>) => {
    void input;
    return { returning };
  });
  const insert = vi.fn(() => ({ values }));
  // Coalescing lookups find no pending or running mutation: every enqueue
  // falls through to a fresh insert.
  const limit = vi.fn(async () => []);
  const forUpdate = vi.fn(() => ({ limit }));
  const orderBy = vi.fn(() => ({ limit, for: forUpdate }));
  const inArray = vi.fn(() => ({ orderBy }));
  const where = vi.fn(() => ({ orderBy, inArray }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const tx = { execute, insert, select };
  const transaction = vi.fn(
    async (callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx),
  );
  const database = {
    db: { transaction },
  } as unknown as DatabaseService;

  return {
    service: new DurableTaskQueueService(database),
    execute,
    values,
    returning,
  };
}

function createReplaceableMutationHarness(
  selectResults: unknown[][],
  options: { insertedTaskId?: bigint; updatedTaskId?: bigint } = {},
) {
  const pendingResults = [...selectResults];
  const limit = vi.fn(async () => pendingResults.shift() ?? []);
  const forUpdate = vi.fn(() => ({ limit }));
  const orderBy = vi.fn(() => ({ for: forUpdate, limit }));
  const whereSelected = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where: whereSelected }));
  const select = vi.fn(() => ({ from }));
  const insertReturning = vi.fn(async () =>
    options.insertedTaskId === undefined
      ? []
      : [{ taskId: options.insertedTaskId }],
  );
  const values = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values }));
  const updateReturning = vi.fn(async () =>
    options.updatedTaskId === undefined
      ? []
      : [{ taskId: options.updatedTaskId }],
  );
  const whereUpdated = vi.fn(() => ({ returning: updateReturning }));
  const set = vi.fn(() => ({ where: whereUpdated }));
  const update = vi.fn(() => ({ set }));
  const execute = vi.fn(async () => undefined);
  const tx = {
    select,
    insert,
    update,
    execute,
    query: { account: { findFirst: vi.fn().mockResolvedValue({ id: 7 }) } },
  };
  const database = {
    db: {
      transaction: vi.fn(
        async (callback: (value: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    },
  } as unknown as DatabaseService;
  return {
    service: new DurableTaskQueueService(database),
    values,
    insert,
    set,
    update,
  };
}

describe('DurableTaskQueueService', () => {
  it('retains an equivalent pending forced revocation', async () => {
    const harness = createReplaceableMutationHarness([
      [
        {
          id: 5n,
          taskType: 'FORCE_REVOKE_GROUP_MEMBER',
          actorUserId: 3,
          payload: { threadId: 10, memberUserId: 7 },
        },
      ],
    ]);
    await expect(
      harness.service.enqueueTask({
        scope: {
          type: 'GROUP',
          address: { account: '!group', profileNamespaceId: 0 },
        },
        taskType: 'FORCE_REVOKE_GROUP_MEMBER',
        actorUserId: 7,
        payload: { threadId: 10, memberUserId: 7, targetUserId: 7 },
      }),
    ).resolves.toEqual({ taskId: 5n });
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.insert).not.toHaveBeenCalled();
  });

  it('canonicalizes a local addressed forced-revoke member to the account-ID slot', async () => {
    const harness = createReplaceableMutationHarness([[]], {
      insertedTaskId: 9n,
    });
    await harness.service.enqueueTask({
      scope: {
        type: 'GROUP',
        address: { account: '!group', profileNamespaceId: 0 },
      },
      taskType: 'FORCE_REVOKE_GROUP_MEMBER',
      payload: {
        threadId: 10,
        memberUserId: {
          account: 'alice',
          profileNamespaceId: 0,
          namespaceId: 0,
        },
      },
    });
    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { threadId: 10, memberUserId: 7 },
        coalescingKey: JSON.stringify(['GROUP_MEMBER_INTENT', 'GROUP', 7]),
      }),
    );
  });

  it('uses the canonical user-pair key and inserts every accepted task', async () => {
    const harness = createHarness([41n, 42n]);
    const firstPayload = { requestId: 'request-1', nested: { accepted: true } };

    await expect(
      harness.service.enqueueTask({
        scope: {
          type: 'USER_PAIR',
          endpoints: [
            { profileNamespaceId: 2, account: 'bob' },
            { profileNamespaceId: 1, account: 'alice' },
          ],
        },
        taskType: 'SEND_FRIEND_REQUEST',
        actorUserId: 7,
        payload: firstPayload,
      }),
    ).resolves.toEqual({ taskId: 41n });

    await expect(
      harness.service.enqueueTask({
        scope: {
          type: 'USER_PAIR',
          endpoints: [
            { profileNamespaceId: 1, account: 'alice' },
            { profileNamespaceId: 2, account: 'bob' },
          ],
        },
        taskType: 'SEND_FRIEND_REQUEST',
        actorUserId: 7,
        payload: { requestId: 'request-1' },
      }),
    ).resolves.toEqual({ taskId: 42n });

    expect(harness.values).toHaveBeenCalledTimes(2);
    const firstValues = harness.values.mock.calls[0]![0];
    const secondValues = harness.values.mock.calls[1]![0];
    expect(firstValues).toMatchObject({
      kind: 'MUTATION',
      scopeType: 'USER_PAIR',
      scopeKey: JSON.stringify([
        'task-scope',
        'USER_PAIR',
        [1, 'alice'],
        [2, 'bob'],
      ]),
      taskType: 'SEND_FRIEND_REQUEST',
      actorUserId: 7,
      payload: firstPayload,
      status: 'PENDING',
    });
    expect(secondValues.scopeKey).toBe(firstValues.scopeKey);
    expect(firstValues.payload).not.toBe(firstPayload);
  });

  it('locks the group scope before inserting and stores a null actor', async () => {
    const harness = createHarness([9n]);

    await harness.service.enqueueTask({
      scope: {
        type: 'GROUP',
        address: { profileNamespaceId: 3, account: 'group-1' },
      },
      taskType: 'DISBAND_GROUP',
      payload: { threadId: 10 },
    });

    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'MUTATION',
        scopeType: 'GROUP',
        scopeKey: JSON.stringify(['business-scope', 'ACCOUNT', 3, 'group-1']),
        actorUserId: null,
      }),
    );
    expect(harness.execute.mock.invocationCallOrder[0]).toBeLessThan(
      harness.values.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['lower-case task type', { taskType: 'disband_group' }],
    ['invalid actor', { actorUserId: 0 }],
    ['non-finite number', { payload: { count: Number.NaN } }],
    ['undefined value', { payload: { value: undefined } }],
    ['custom object', { payload: { value: new Date() } }],
  ])('rejects %s before opening a transaction', async (_name, override) => {
    const harness = createHarness();
    // The it.each table feeds a union of one-field overrides; only `payload`
    // is read back out, so narrow it once here.
    const overrides = override as { payload?: Record<string, unknown> };
    const input = {
      scope: {
        type: 'GROUP' as const,
        address: { profileNamespaceId: 3, account: 'group-1' },
      },
      taskType: 'DISBAND_GROUP',
      actorUserId: 7,
      ...override,
      payload: { threadId: 10, ...(overrides.payload ?? {}) },
    };

    await expect(harness.service.enqueueTask(input)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(harness.values).not.toHaveBeenCalled();
  });

  it('rejects cyclic payloads and a missing insert result', async () => {
    const cyclic: Record<string, unknown> = { threadId: 10 };
    cyclic.self = cyclic;
    const invalidHarness = createHarness();

    await expect(
      invalidHarness.service.enqueueTask({
        scope: {
          type: 'GROUP',
          address: { profileNamespaceId: 3, account: 'group-1' },
        },
        taskType: 'DISBAND_GROUP',
        payload: cyclic,
      }),
    ).rejects.toThrow('must not contain cycles');

    const emptyHarness = createHarness([]);
    await expect(
      emptyHarness.service.enqueueTask({
        scope: {
          type: 'GROUP',
          address: { profileNamespaceId: 3, account: 'group-1' },
        },
        taskType: 'DISBAND_GROUP',
        payload: { threadId: 10 },
      }),
    ).rejects.toThrow('durable task insert returned no row');
  });
});
