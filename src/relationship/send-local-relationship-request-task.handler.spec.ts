import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseService } from '../database/database.service.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { SendLocalRelationshipRequestTaskHandler } from './send-local-relationship-request-task.handler.js';

function task(payload: Record<string, unknown> = {}): DurableTask {
  return {
    id: 1n,
    parentTaskId: null,
    kind: 'MUTATION',
    scopeType: 'USER_PAIR',
    scopeKey: 'pair-key',
    taskType: 'SEND_LOCAL_RELATIONSHIP_REQUEST',
    actorUserId: 7,
    payload: { targetUserId: 9, note: 'hello', ...payload },
    checkpoint: {},
    coalescingKey: null,
    supersededByTaskId: null,
    status: 'PROCESSING',
    resultCode: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  };
}

function createHarness(options?: {
  friends?: boolean;
  created?: boolean;
  identities?: Array<{
    id: number;
    availability: string;
    disabledAt: Date | null;
  }>;
}) {
  const where = vi.fn().mockResolvedValue(
    options?.identities ?? [
      { id: 7, availability: 'AVAILABLE', disabledAt: null },
      { id: 9, availability: 'AVAILABLE', disabledAt: null },
    ],
  );
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const database = { db: { select } } as unknown as DatabaseService;
  const dispatcher = new DurableTaskDispatcherService();
  const tx = { marker: 'transaction' };
  const writeLocalP2PIntentInTx = vi
    .fn()
    .mockResolvedValue([{ userId: 7, feedId: 3 }]);
  const createRelationshipRequest = vi.fn(
    async (
      _from: number,
      _to: number,
      _note: string,
      afterWrite: (transaction: typeof tx, created: boolean) => Promise<void>,
    ) => {
      await afterWrite(tx, options?.created ?? true);
      return { status: 'created' } as const;
    },
  );
  const areFriends = vi.fn().mockResolvedValue(options?.friends ?? false);
  const tick = vi.fn().mockResolvedValue(undefined);
  const notifyFeedUpdates = vi.fn();
  const handler = new SendLocalRelationshipRequestTaskHandler(
    database,
    dispatcher,
    { createRelationshipRequest, writeLocalP2PIntentInTx } as never,
    { areFriends } as never,
    { tick } as never,
    { notifyFeedUpdates } as never,
  );
  handler.onModuleInit();
  return {
    dispatcher,
    handler,
    tx,
    createRelationshipRequest,
    writeLocalP2PIntentInTx,
    areFriends,
    tick,
    notifyFeedUpdates,
  };
}

describe('SendLocalRelationshipRequestTaskHandler', () => {
  it.each([true, false])(
    'charges new and refreshed requests in the relationship transaction (created=%s)',
    async (created) => {
      const harness = createHarness({ created });

      await harness.dispatcher.execute(task());

      expect(harness.createRelationshipRequest).toHaveBeenCalledWith(
        7,
        9,
        'hello',
        expect.any(Function),
      );
      expect(harness.tick).toHaveBeenCalledWith(7, 'requests', harness.tx);
      expect(harness.writeLocalP2PIntentInTx).toHaveBeenCalledWith(
        harness.tx,
        7,
        9,
        true,
        'hello',
      );
      expect(harness.notifyFeedUpdates).toHaveBeenCalledWith([
        { userId: 7, feedId: 3 },
      ]);
    },
  );

  it('treats an already-active friendship as an idempotent success', async () => {
    const harness = createHarness({ friends: true });

    await harness.dispatcher.execute(task());

    expect(harness.areFriends).toHaveBeenCalledWith(7, 9);
    expect(harness.createRelationshipRequest).not.toHaveBeenCalled();
  });

  it('rejects execution when the target is no longer available', async () => {
    const harness = createHarness({
      identities: [{ id: 7, availability: 'AVAILABLE', disabledAt: null }],
    });

    await expect(harness.dispatcher.execute(task())).rejects.toMatchObject({
      bizCode: 10001,
    } satisfies Partial<BusinessException>);
    expect(harness.createRelationshipRequest).not.toHaveBeenCalled();
  });

  it('rejects malformed persisted payloads as task invariants', async () => {
    const harness = createHarness();

    await expect(
      harness.dispatcher.execute(task({ targetUserId: '9' })),
    ).rejects.toThrow('invalid target user ID');
  });

  it('treats a persisted self-request as an internal invariant violation', async () => {
    const harness = createHarness();

    const result = harness.dispatcher.execute(task({ targetUserId: 7 }));

    await expect(result).rejects.toThrow(
      'can not request a relationship with yourself',
    );
    await expect(result).rejects.not.toBeInstanceOf(BusinessException);
    expect(harness.createRelationshipRequest).not.toHaveBeenCalled();
  });
});
