import { localAccountsForTargetsInTx } from '../user/account-address.js';
vi.mock('../user/account-address.js', async (original) => ({
  ...(await original<typeof import('../user/account-address.js')>()),
  localAccountsForTargetsInTx: vi.fn(async () => [{ id: 2 }]),
}));
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { RelationshipService } from './relationship.service.js';
import { requireThreadContentLockInTx } from './thread-content-lock.js';
import { SystemMessageType } from '../message/system-message.js';

describe('transactional friendship activation', () => {
  function harness(active: boolean, threadId: number | null = 15) {
    const service = Object.create(RelationshipService.prototype);
    const queries: string[] = [];
    const tx = {
      execute: vi.fn(async (query) => {
        queries.push(new PgDialect().sqlToQuery(query).sql);
        return {
          rows: queries.at(-1)!.includes('SELECT DISTINCT ON')
            ? []
            : [{ id: 15 }],
        };
      }),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: async () => [{ userId: 2, feedId: 85 }],
          }),
        }),
      })),
    };
    const writeSystemMessageInTx = vi.fn(
      async (writerTx, id, _event, options) => {
        expect(writerTx).toBe(tx);
        const calls = tx.execute.mock.calls.length;
        await requireThreadContentLockInTx(writerTx, id, options.threadLock);
        expect(tx.execute).toHaveBeenCalledTimes(calls);
      },
    );
    const setPairActiveInTx = vi.fn();
    const initializeReadWindowsInTx = vi.fn().mockResolvedValue(undefined);
    Object.assign(service, {
      previews: { initializeReadWindowsInTx },
      relationshipIntents: {
        readP2PRelationshipInTx: vi
          .fn()
          .mockResolvedValue({ pair: { id: 7n, active, threadId } }),
        setPairActiveInTx,
      },
      createP2PFriendshipInTx: vi.fn().mockResolvedValue(15),
      reactivateP2PFriendshipInTx: vi.fn().mockResolvedValue(15),
      messages: { writeSystemMessageInTx },
    });
    return {
      service,
      tx,
      queries,
      writeSystemMessageInTx,
      setPairActiveInTx,
      initializeReadWindowsInTx,
    };
  }

  it.each([null, 15])(
    'writes once inside activation with one child lock (existing thread %s)',
    async (threadId) => {
      const h = harness(false, threadId);
      const result = await h.service.reconcileFriendPairInTx(h.tx, 2, 3, true);
      expect(h.initializeReadWindowsInTx).toHaveBeenCalledExactlyOnceWith(
        h.tx,
        15,
        [2],
      );
      expect(
        h.initializeReadWindowsInTx.mock.invocationCallOrder[0],
      ).toBeLessThan(h.writeSystemMessageInTx.mock.invocationCallOrder[0]);
      expect(h.writeSystemMessageInTx).toHaveBeenCalledExactlyOnceWith(
        h.tx,
        15,
        { type: SystemMessageType.FRIEND_ADDED },
        expect.objectContaining({
          threadLock: expect.objectContaining({ tx: h.tx, threadId: 15 }),
        }),
      );
      expect(h.queries).toHaveLength(2);
      expect(h.queries[1]).toContain('"RelationshipIntent"');
      expect(h.queries[0]).toContain('FOR NO KEY UPDATE OF thread');
      expect(h.queries[0]).not.toContain('pg_advisory_xact_lock');
      expect(result.clientFeedUpdates).toEqual([{ userId: 2, feedId: 85 }]);
    },
  );

  it('does not acquire a content lock or write for an already active confirmation', async () => {
    const h = harness(true);
    await h.service.reconcileFriendPairInTx(h.tx, 2, 3, true);
    expect(h.tx.execute).not.toHaveBeenCalled();
    expect(h.writeSystemMessageInTx).not.toHaveBeenCalled();
    expect(h.initializeReadWindowsInTx).not.toHaveBeenCalled();
  });

  it('propagates message storage failure to the transaction owner', async () => {
    const h = harness(false);
    h.writeSystemMessageInTx.mockRejectedValueOnce(new Error('write failed'));
    await expect(
      h.service.reconcileFriendPairInTx(h.tx, 2, 3, true),
    ).rejects.toThrow('write failed');
  });
});
