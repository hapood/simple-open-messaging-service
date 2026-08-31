import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import { DomainCommandQueueService } from './domain-command-queue.service.js';

function createHarness(commandIds: bigint[] = [1n]) {
  const execute = vi.fn(async () => undefined);
  const returning = vi.fn(async () => {
    const commandId = commandIds.shift();
    return commandId === undefined ? [] : [{ commandId }];
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
    service: new DomainCommandQueueService(database),
    execute,
    values,
    returning,
  };
}

describe('DomainCommandQueueService', () => {
  it('uses the canonical user-pair key and inserts every accepted command', async () => {
    const harness = createHarness([41n, 42n]);
    const firstPayload = { requestId: 'request-1', nested: { accepted: true } };

    await expect(
      harness.service.enqueue({
        aggregate: {
          type: 'USER_PAIR',
          endpoints: [
            { domain: 'B.EXAMPLE', account: 'bob' },
            { domain: 'a.example', account: 'alice' },
          ],
        },
        commandType: 'SEND_FRIEND_REQUEST',
        actorUserId: 7,
        payload: firstPayload,
      }),
    ).resolves.toEqual({ commandId: 41n });

    await expect(
      harness.service.enqueue({
        aggregate: {
          type: 'USER_PAIR',
          endpoints: [
            { domain: 'A.EXAMPLE', account: 'alice' },
            { domain: 'b.example', account: 'bob' },
          ],
        },
        commandType: 'SEND_FRIEND_REQUEST',
        actorUserId: 7,
        payload: { requestId: 'request-1' },
      }),
    ).resolves.toEqual({ commandId: 42n });

    expect(harness.values).toHaveBeenCalledTimes(2);
    const firstValues = harness.values.mock.calls[0][0];
    const secondValues = harness.values.mock.calls[1][0];
    expect(firstValues).toMatchObject({
      aggregateType: 'USER_PAIR',
      aggregateKey: JSON.stringify([
        'business-scope',
        'USER_PAIR',
        ['a.example', 'alice'],
        ['b.example', 'bob'],
      ]),
      commandType: 'SEND_FRIEND_REQUEST',
      actorUserId: 7,
      payload: firstPayload,
      status: 'PENDING',
    });
    expect(secondValues.aggregateKey).toBe(firstValues.aggregateKey);
    expect(firstValues.payload).not.toBe(firstPayload);
  });

  it('locks the group aggregate before inserting and stores a null actor', async () => {
    const harness = createHarness([9n]);

    await harness.service.enqueue({
      aggregate: {
        type: 'GROUP',
        address: { domain: 'CHAT.EXAMPLE', account: 'group-1' },
      },
      commandType: 'DISBAND_GROUP',
      payload: {},
    });

    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateType: 'GROUP',
        aggregateKey: JSON.stringify([
          'business-scope',
          'GROUP',
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
    ['lower-case command type', { commandType: 'disband_group' }],
    ['invalid actor', { actorUserId: 0 }],
    ['non-finite number', { payload: { count: Number.NaN } }],
    ['undefined value', { payload: { value: undefined } }],
    ['custom object', { payload: { value: new Date() } }],
  ])('rejects %s before opening a transaction', async (_name, override) => {
    const harness = createHarness();
    const input = {
      aggregate: {
        type: 'GROUP' as const,
        address: { domain: 'chat.example', account: 'group-1' },
      },
      commandType: 'DISBAND_GROUP',
      actorUserId: 7,
      payload: {},
      ...override,
    };

    await expect(harness.service.enqueue(input)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(harness.values).not.toHaveBeenCalled();
  });

  it('rejects cyclic payloads and a missing insert result', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidHarness = createHarness();

    await expect(
      invalidHarness.service.enqueue({
        aggregate: {
          type: 'GROUP',
          address: { domain: 'chat.example', account: 'group-1' },
        },
        commandType: 'DISBAND_GROUP',
        payload: cyclic,
      }),
    ).rejects.toThrow('must not contain cycles');

    const emptyHarness = createHarness([]);
    await expect(
      emptyHarness.service.enqueue({
        aggregate: {
          type: 'GROUP',
          address: { domain: 'chat.example', account: 'group-1' },
        },
        commandType: 'DISBAND_GROUP',
        payload: {},
      }),
    ).rejects.toThrow('domain command insert returned no row');
  });
});
