import { describe, expect, it, vi } from 'vitest';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../database/database.service.js';
import { DurableTaskQueueService } from './durable-task-queue.service.js';

function createHarness(taskIds: bigint[] = [1n]) {
  const execute = vi.fn(async () => undefined);
  const returning = vi.fn(async () => {
    const taskId = taskIds.shift();
    return taskId === undefined ? [] : [{ taskId }];
  });
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const tx = { execute, insert };
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

function createProjectionHarness(
  pending: Array<{ id: bigint; payload: Record<string, unknown> }> = [],
  taskId = 100n,
) {
  const execute = vi.fn(async () => undefined);
  const forUpdate = vi.fn(async () => pending);
  const orderBy = vi.fn(() => ({ for: forUpdate }));
  const whereSelected = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where: whereSelected }));
  const select = vi.fn(() => ({ from }));
  const returning = vi.fn(async () => [{ taskId }]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const whereUpdated = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where: whereUpdated }));
  const update = vi.fn(() => ({ set }));
  const tx = {
    execute,
    select,
    insert,
    update,
  } as unknown as DatabaseTransaction;
  const database = {} as DatabaseService;
  return {
    service: new DurableTaskQueueService(database),
    tx,
    execute,
    values,
    set,
    forUpdate,
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
  it.each([
    'ACCEPT_GROUP_JOIN_REQUEST',
    'INVITE_GROUP_MEMBER',
    'FORCE_REVOKE_GROUP_MEMBER',
  ])(
    'retains a pending forced revocation when admitting %s',
    async (taskType) => {
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
            address: { account: '!group', domain: 'local' },
          },
          taskType,
          actorUserId: 7,
          payload: { threadId: 10, memberUserId: 7, targetUserId: 7 },
        }),
      ).resolves.toEqual({ taskId: 5n });
      expect(harness.update).not.toHaveBeenCalled();
      expect(harness.insert).not.toHaveBeenCalled();
    },
  );

  it('canonicalizes a local addressed forced-revoke member to the account-ID slot', async () => {
    const harness = createReplaceableMutationHarness([[]], {
      insertedTaskId: 9n,
    });
    await harness.service.enqueueTask({
      scope: { type: 'GROUP', address: { account: '!group', domain: 'local' } },
      taskType: 'FORCE_REVOKE_GROUP_MEMBER',
      payload: {
        threadId: 10,
        memberUserId: { account: 'alice', domain: 'local', namespaceId: 0 },
      },
    });
    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { threadId: 10, memberUserId: 7 },
        coalescingKey: JSON.stringify(['GROUP_MEMBER_INTENT', 'GROUP', 7]),
      }),
    );
  });

  it('returns the existing task for an identical pending leave', async () => {
    const harness = createReplaceableMutationHarness([
      [
        {
          id: 5n,
          taskType: 'LEAVE_GROUP',
          actorUserId: 7,
          payload: { threadId: 10 },
        },
      ],
    ]);

    await expect(
      harness.service.enqueueTask({
        scope: {
          type: 'GROUP',
          address: { domain: 'local', account: '!group' },
        },
        taskType: 'LEAVE_GROUP',
        actorUserId: 7,
        payload: { threadId: 10 },
      }),
    ).resolves.toEqual({ taskId: 5n });

    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.insert).not.toHaveBeenCalled();
  });

  it('rewrites a tail pending member-intent task in place', async () => {
    const harness = createReplaceableMutationHarness(
      [
        [
          {
            id: 5n,
            taskType: 'LEAVE_GROUP',
            actorUserId: 7,
            payload: { threadId: 10 },
          },
        ],
        [],
      ],
      { updatedTaskId: 5n },
    );

    await expect(
      harness.service.enqueueTask({
        scope: {
          type: 'GROUP',
          address: { domain: 'local', account: '!group' },
        },
        taskType: 'ACCEPT_GROUP_INVITATION',
        actorUserId: 7,
        payload: { threadId: 10 },
      }),
    ).resolves.toEqual({ taskId: 5n });

    expect(harness.set).toHaveBeenCalledWith({
      taskType: 'ACCEPT_GROUP_INVITATION',
      actorUserId: 7,
      payload: { threadId: 10 },
    });
    expect(harness.insert).not.toHaveBeenCalled();
  });

  it('rewrites a pending intent without consulting intervening work', async () => {
    const harness = createReplaceableMutationHarness(
      [
        [
          {
            id: 5n,
            taskType: 'LEAVE_GROUP',
            actorUserId: 7,
            payload: { threadId: 10 },
          },
        ],
      ],
      { updatedTaskId: 5n },
    );
    await expect(
      harness.service.enqueueTask({
        scope: {
          type: 'GROUP',
          address: { domain: 'local', account: '!group' },
        },
        taskType: 'ACCEPT_GROUP_INVITATION',
        actorUserId: 7,
        payload: { threadId: 10 },
      }),
    ).resolves.toEqual({ taskId: 5n });
    expect(harness.insert).not.toHaveBeenCalled();
  });

  it.each(['PROCESSING', 'ASYNC_PROCESSING'])(
    'reuses an identical %s intent without appending work',
    async (status) => {
      const harness = createReplaceableMutationHarness([
        [],
        [
          {
            id: 5n,
            status,
            taskType: 'REVOKE_USER_RELATIONSHIP',
            actorUserId: 7,
            payload: { threadId: 10 },
            coalescingKey: JSON.stringify(['P2P_INTENT', 7]),
          },
        ],
      ]);
      await expect(
        harness.service.enqueueTask({
          scope: {
            type: 'USER_PAIR',
            endpoints: [
              { account: 'alice', domain: 'local' },
              { account: 'bob', domain: 'local' },
            ],
          },
          taskType: 'REVOKE_USER_RELATIONSHIP',
          actorUserId: 7,
          payload: { threadId: 10 },
        }),
      ).resolves.toEqual({ taskId: 5n });
      expect(harness.insert).not.toHaveBeenCalled();
      expect(harness.update).not.toHaveBeenCalled();
    },
  );

  it('uses a separate group-authored slot for kick and invitation decisions', async () => {
    const harness = createReplaceableMutationHarness([[]], {
      insertedTaskId: 12n,
    });

    await harness.service.enqueueTask({
      scope: {
        type: 'GROUP',
        address: { domain: 'local', account: '!group' },
      },
      taskType: 'KICK_GROUP_MEMBER',
      actorUserId: 3,
      payload: { threadId: 10, targetUserId: 7 },
    });

    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
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
            { domain: 'B.EXAMPLE', account: 'bob' },
            { domain: 'a.example', account: 'alice' },
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
            { domain: 'A.EXAMPLE', account: 'alice' },
            { domain: 'b.example', account: 'bob' },
          ],
        },
        taskType: 'SEND_FRIEND_REQUEST',
        actorUserId: 7,
        payload: { requestId: 'request-1' },
      }),
    ).resolves.toEqual({ taskId: 42n });

    expect(harness.values).toHaveBeenCalledTimes(2);
    const firstValues = harness.values.mock.calls[0][0];
    const secondValues = harness.values.mock.calls[1][0];
    expect(firstValues).toMatchObject({
      kind: 'MUTATION',
      scopeType: 'USER_PAIR',
      scopeKey: JSON.stringify([
        'task-scope',
        'USER_PAIR',
        ['a.example', 'alice'],
        ['b.example', 'bob'],
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
        address: { domain: 'CHAT.EXAMPLE', account: 'group-1' },
      },
      taskType: 'DISBAND_GROUP',
      payload: {},
    });

    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'MUTATION',
        scopeType: 'GROUP',
        scopeKey: JSON.stringify([
          'business-scope',
          'ACCOUNT',
          'chat.example',
          'group-1',
        ]),
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
    const input = {
      scope: {
        type: 'GROUP' as const,
        address: { domain: 'chat.example', account: 'group-1' },
      },
      taskType: 'DISBAND_GROUP',
      actorUserId: 7,
      payload: {},
      ...override,
    };

    await expect(harness.service.enqueueTask(input)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(harness.values).not.toHaveBeenCalled();
  });

  it('rejects cyclic payloads and a missing insert result', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidHarness = createHarness();

    await expect(
      invalidHarness.service.enqueueTask({
        scope: {
          type: 'GROUP',
          address: { domain: 'chat.example', account: 'group-1' },
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
          address: { domain: 'chat.example', account: 'group-1' },
        },
        taskType: 'DISBAND_GROUP',
        payload: {},
      }),
    ).rejects.toThrow('durable task insert returned no row');
  });

  it('coalesces Group Meta head fan-out without storing a revision or roster', async () => {
    const harness = createProjectionHarness([
      { id: 8n, payload: { threadId: 42 } },
    ]);

    await expect(
      harness.service.enqueueGroupMetaHeadFanoutInTx(harness.tx, {
        group: { domain: 'LOCAL', account: '!group' },
        threadId: 42,
      }),
    ).resolves.toEqual({ taskId: 100n });

    expect(harness.values).toHaveBeenCalledWith({
      kind: 'PROJECTION',
      scopeType: 'GROUP',
      scopeKey: JSON.stringify([
        'business-scope',
        'ACCOUNT',
        'local',
        '!group',
      ]),
      taskType: 'FAN_OUT_GROUP_META_HEAD',
      actorUserId: null,
      payload: { threadId: 42 },
      checkpoint: { afterAudienceId: '0' },
      coalescingKey: JSON.stringify(['FAN_OUT_GROUP_META_HEAD', 42]),
      status: 'PENDING',
    });
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'SUPERSEDED',
      }),
    );
  });

  it('rejects invalid fan-out input and malformed pending payloads', async () => {
    const invalid = createProjectionHarness();
    await expect(
      invalid.service.enqueueGroupMetaHeadFanoutInTx(invalid.tx, {
        group: { domain: 'local', account: '!group' },
        threadId: 0,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(invalid.values).not.toHaveBeenCalled();

    const malformed = createProjectionHarness([
      { id: 8n, payload: { threadId: 42, revision: 1 } },
    ]);
    await expect(
      malformed.service.enqueueGroupMetaHeadFanoutInTx(malformed.tx, {
        group: { domain: 'local', account: '!group' },
        threadId: 42,
      }),
    ).rejects.toThrow('invalid pending Group Meta head fan-out payload');
    expect(malformed.values).not.toHaveBeenCalled();
  });
});
