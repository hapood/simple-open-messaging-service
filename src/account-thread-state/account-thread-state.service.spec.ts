import { enqueueReverseP2PRevokeInTx } from '../relationship/reverse-revoke-task.js';
import { writeP2PClientRelationshipInTx } from '../relationship/p2p-client-relationship.js';
import { describe, expect, it, vi } from 'vitest';
import { AccountThreadStateService } from './account-thread-state.service.js';
import { PgDialect } from 'drizzle-orm/pg-core';
vi.mock('../relationship/reverse-revoke-task.js', () => ({
  enqueueReverseP2PRevokeInTx: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../relationship/thread-content-lock.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../relationship/thread-content-lock.js')
  >()),
  requireThreadContentLockInTx: vi.fn().mockResolvedValue({ threadId: 9 }),
}));

vi.mock('../relationship/p2p-client-relationship.js', () => ({
  writeP2PClientRelationshipInTx: vi
    .fn()
    .mockResolvedValue([{ userId: 2, feedId: 7 }]),
}));

describe('AccountThreadStateService.endP2P transaction boundary', () => {
  it.each([false, true])(
    'publishes relationship facts atomically and wakes only after commit (commit fails=%s)',
    async (commitFails) => {
      const dialect = new PgDialect();
      const returning = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
      const where = vi.fn(() => ({ returning }));
      const set = vi.fn(() => ({ where }));
      const endpoints = {
        pairId: 10n,
        callerSide: 'A',
        mineUserId: 1,
        mineAccount: 'alice',
        mineDomain: 'local',
        mineNamespaceId: 0,
        peerUserId: 2,
        peerAccount: 'bob',
        peerDomain: 'local',
        peerNamespaceId: 0,
      };
      const tx = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [endpoints] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [endpoints] })
          .mockResolvedValueOnce({ rows: [{ id: 10n, active: true }] })
          .mockResolvedValueOnce({ rows: [{ id: 10 }] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ status: 'ACCEPTED' }] })
          .mockImplementation(async (query) => {
            const text = dialect.sqlToQuery(query).sql;
            if (text.includes('UPDATE "RelationshipPair"'))
              return { rows: [{ threadId: 10 }], rowCount: 1 };
            if (
              text.includes('UPDATE "MessageThread"') &&
              text.includes('"authorizationEpoch"')
            )
              return { rows: [{ id: 10 }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
          }),
        update: vi.fn(() => ({ set })),
        delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      };
      const database = {
        db: {
          transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => {
            const result = await fn(tx);
            expect(clientFeed.notifyFeedUpdates).not.toHaveBeenCalled();
            if (commitFails) throw new Error('commit failed');
            return result;
          }),
        },
      };
      const stateFeed = { writeManyInTx: vi.fn() };
      const clientFeed = { notifyFeedUpdates: vi.fn() };
      const systemMessage = {
        threadId: 10,
        seq: 5,
        creator: null,
        createdAt: new Date(),
      };
      const messages = {
        writeSystemMessageInTx: vi
          .fn()
          .mockResolvedValue({ message: systemMessage }),
      };
      const service = new AccountThreadStateService(
        database as never,
        stateFeed as never,
        clientFeed as never,
        messages as never,
      );

      if (commitFails) {
        await expect(service.endP2P(10, 1)).rejects.toThrow('commit failed');
        expect(clientFeed.notifyFeedUpdates).not.toHaveBeenCalled();
        return;
      }
      await expect(service.endP2P(10, 1)).resolves.toEqual({
        transitioned: true,
        statePeers: [],
        systemMessage,
      });
      expect(messages.writeSystemMessageInTx).toHaveBeenCalledWith(
        tx,
        10,
        { type: 'FRIEND_REMOVED', initiator: 1 },
        {
          threadLock: expect.objectContaining({ tx, threadId: 10 }),
        },
      );
      const queries = tx.execute.mock.calls.map(([query]) =>
        dialect.sqlToQuery(query),
      );
      expect(
        queries.filter(
          ({ sql }) =>
            sql.includes('UPDATE "MessageThread"') &&
            sql.includes('"authorizationEpoch"'),
        ),
      ).toEqual([expect.objectContaining({ params: [1, false, 10] })]);
      expect(enqueueReverseP2PRevokeInTx).toHaveBeenCalledWith(
        tx,
        undefined,
        2,
        1,
      );
      expect(writeP2PClientRelationshipInTx).toHaveBeenCalled();
      expect(clientFeed.notifyFeedUpdates).toHaveBeenCalledWith([
        { userId: 2, feedId: 7 },
      ]);
      // Both canonical account scopes are locked first, followed by
      // RelationshipPair, MessageThread, intents, and participant rows.
      expect(tx.execute.mock.invocationCallOrder[4]).toBeLessThan(
        messages.writeSystemMessageInTx.mock.invocationCallOrder[0],
      );
      expect(tx.update).toHaveBeenCalledOnce();
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ messageVisibleThroughSeq: 5 }),
      );
      expect(tx.delete).not.toHaveBeenCalled(); // history-only compatibility grants no longer exist
      expect(stateFeed.writeManyInTx).not.toHaveBeenCalled();
    },
  );

  it('treats a revoked caller-authored direction as an idempotent success', async () => {
    const endpoints = {
      pairId: 8n,
      callerSide: 'A',
      mineUserId: 1,
      mineAccount: 'alice',
      mineDomain: 'local',
      mineNamespaceId: 0,
      peerUserId: 2,
      peerAccount: 'bob',
      peerDomain: 'local',
      peerNamespaceId: 0,
    };
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [endpoints] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [endpoints] })
        .mockResolvedValueOnce({ rows: [{ id: 8n }] })
        .mockResolvedValueOnce({ rows: [{ id: 10 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ status: 'REVOKED' }] }),
      update: vi.fn(),
    };
    const database = {
      db: {
        transaction: vi.fn(async (fn: (client: typeof tx) => unknown) =>
          fn(tx),
        ),
      },
    };
    const messages = { writeSystemMessageInTx: vi.fn() };
    const service = new AccountThreadStateService(
      database as never,
      {} as never,
      {} as never,
      messages as never,
    );

    await expect(service.endP2P(10, 1)).resolves.toEqual({
      transitioned: false,
      statePeers: [],
      systemMessage: null,
    });
    expect(messages.writeSystemMessageInTx).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });
});

describe('AccountThreadStateService.setBlocked', () => {
  it('commits the participant fact and client feed before notifying devices', async () => {
    const returning = vi.fn().mockResolvedValue([{ userId: 4 }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const tx = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ blocked: false, feedId: 12, threadFeedEndId: 8 }],
      }),
      update: vi.fn(() => ({ set })),
    };
    const database = {
      db: {
        transaction: vi.fn(async (fn: (client: typeof tx) => unknown) =>
          fn(tx),
        ),
      },
    };
    const clientFeed = {
      writeInTx: vi.fn().mockResolvedValue(12),
      notifyFeedUpdated: vi.fn(),
    };
    const service = new AccountThreadStateService(
      database as never,
      {} as never,
      clientFeed as never,
    );

    await service.setBlocked(4, 9, true);

    expect(clientFeed.writeInTx).not.toHaveBeenCalled();
    expect(clientFeed.notifyFeedUpdated).toHaveBeenCalledWith({
      userId: 4,
      feedId: 12,
      threadFeedEndId: 8,
    });
    expect(database.db.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      clientFeed.notifyFeedUpdated.mock.invocationCallOrder[0],
    );
  });
});
