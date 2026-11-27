import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireThreadContentLockInTx } from '../common/locks/thread-content-lock.js';
import { initializeRelationshipThreadStateInTx } from './federation-relationship-thread-state.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

vi.mock('../common/locks/thread-content-lock.js', () => ({
  requireThreadContentLockInTx: vi.fn(
    async (tx, threadId, held) => held ?? { tx, threadId },
  ),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function preparationTransaction() {
  const head = {
    messageEndSeq: 12,
    tombstoneEndSeq: 4,
    reverseEnabled: true,
  };
  const execute = vi
    .fn<(query: SQL) => Promise<{ rows: unknown[] }>>()
    .mockResolvedValue({ rows: [head] });
  const tx = { execute };
  const reconcile = vi
    .spyOn(
      FederationThreadSyncStateService,
      'reconcileRelationshipAuthorizationInTx',
    )
    .mockResolvedValue({
      created: true,
      epochChanged: false,
      reverseRequired: true,
    });
  return { tx, execute, reconcile };
}

describe('federation message round preparation', () => {
  it('skips local namespaces without acquiring locks or reading authorization', async () => {
    const { tx, execute, reconcile } = preparationTransaction();

    await FederationThreadSyncStateService.prepareMessageRoundInTx(
      tx as never,
      31,
      0,
    );

    expect(requireThreadContentLockInTx).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('does not initialize synchronization without an authorized source head', async () => {
    const { tx, execute, reconcile } = preparationTransaction();
    execute.mockResolvedValue({ rows: [] });

    await FederationThreadSyncStateService.prepareMessageRoundInTx(
      tx as never,
      31,
      3,
    );

    expect(requireThreadContentLockInTx).toHaveBeenCalledWith(
      tx,
      31,
      undefined,
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each(['message round', 'relationship activation'] as const)(
    'aligns %s from the same retained head under the content lock',
    async (entryPoint) => {
      const { tx, execute, reconcile } = preparationTransaction();
      const held = { tx, threadId: 31 };
      const transaction = vi.fn(async (callback) => callback(tx));

      if (entryPoint === 'relationship activation') {
        execute.mockResolvedValueOnce({ rows: [{ namespaceId: 3 }] });
        await initializeRelationshipThreadStateInTx(
          tx as never,
          31,
          9n,
          held as never,
        );
        expect(requireThreadContentLockInTx).toHaveBeenNthCalledWith(
          2,
          tx,
          31,
          held,
        );
      } else {
        const service = new FederationThreadSyncStateService({
          db: { transaction },
        } as never);
        await service.prepareMessageRound(31, 3);
        expect(transaction).toHaveBeenCalledOnce();
      }

      expect(reconcile).toHaveBeenCalledExactlyOnceWith(tx, {
        threadId: 31,
        namespaceId: 3,
        messageTargetSeq: 12,
        deletionTargetSeq: 4,
        reverseEnabled: true,
        threadLock: held,
      });
      expect(
        vi.mocked(requireThreadContentLockInTx).mock.invocationCallOrder[0],
      ).toBeLessThan(execute.mock.invocationCallOrder[0]);
      expect(execute.mock.invocationCallOrder.at(-1)).toBeLessThan(
        reconcile.mock.invocationCallOrder[0],
      );

      const query = new PgDialect().sqlToQuery(execute.mock.calls.at(-1)![0]);
      expect(query.params).toEqual([31, 3]);
      expect(query.sql).toContain('pair.active = true');
      expect(query.sql).toContain("intent.status = 'ACCEPTED'");
      expect(query.sql).toContain(
        'intent.status = \'REQUESTED\' AND intent."expiresAt" > CURRENT_TIMESTAMP',
      );
      expect(query.sql).toContain('intent."updatedAt" DESC');
      expect(query.sql).not.toMatch(/FOR (?:NO KEY UPDATE|UPDATE|SHARE)/);
    },
  );
});
