import { describe, expect, it, vi } from 'vitest';
import { AccountThreadStateService } from './account-thread-state.service.js';

describe('AccountThreadStateService.endP2P transaction boundary', () => {
  it('writes the relationship revocation and clear boundary without a thread revision', async () => {
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
        .mockResolvedValue({ rows: [], rowCount: 0 }),
      update: vi.fn(() => ({ set })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    };
    const database = {
      db: {
        transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => {
          const result = await fn(tx);
          return result;
        }),
      },
    };
    const stateFeed = { writeManyInTx: vi.fn() };
    const systemMessage = {
      threadId: 10,
      seq: 5,
      creator: null,
      createdAt: new Date(),
    };
    const messages = {
      writeDepartureMessageInTx: vi
        .fn()
        .mockResolvedValue({ message: systemMessage }),
    };
    const service = new AccountThreadStateService(
      database as never,
      stateFeed as never,
      {} as never,
      messages as never,
    );

    await expect(service.endP2P(10, 1, true)).resolves.toEqual({
      transitioned: true,
      statePeers: [],
      systemMessage,
      localRecipientIds: [1, 2],
    });
    expect(messages.writeDepartureMessageInTx).toHaveBeenCalledWith(
      tx,
      10,
      'FRIEND_REMOVED',
      { account: 'bob', domain: 'local', namespaceId: 0 },
      {
        actorUserId: 1,
        markReadUserId: 1,
        recipientUserIds: [1, 2],
        visibleThroughUserIds: [1, 2],
        threadLock: expect.objectContaining({ tx, threadId: 10 }),
      },
    );
    expect(tx.execute).toHaveBeenCalledTimes(13);
    // Both canonical account scopes are locked first, followed by
    // RelationshipPair, MessageThread, intents, and participant rows.
    expect(tx.execute.mock.invocationCallOrder[4]).toBeLessThan(
      messages.writeDepartureMessageInTx.mock.invocationCallOrder[0],
    );
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled(); // history-only compatibility grants no longer exist
    expect(stateFeed.writeManyInTx).not.toHaveBeenCalled();
  });

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
    const messages = { writeDepartureMessageInTx: vi.fn() };
    const service = new AccountThreadStateService(
      database as never,
      {} as never,
      {} as never,
      messages as never,
    );

    await expect(service.endP2P(10, 1, false)).resolves.toEqual({
      transitioned: false,
      statePeers: [],
      systemMessage: null,
      localRecipientIds: [1, 2],
    });
    expect(messages.writeDepartureMessageInTx).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });
});

describe('AccountThreadStateService.setBlocked', () => {
  it('commits the participant fact and client feed before notifying devices', async () => {
    const returning = vi.fn().mockResolvedValue([{ userId: 4 }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const tx = { update: vi.fn(() => ({ set })) };
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

    expect(clientFeed.writeInTx).toHaveBeenCalledWith(tx, {
      userId: 4,
      account: '',
      domain: 'local',
      namespaceId: 0,
      eventType: 'THREAD_BLOCK',
      subjectAccount: '9',
      subjectDomain: 'local',
      body: { threadId: 9, blocked: true },
    });
    expect(clientFeed.notifyFeedUpdated).toHaveBeenCalledWith({
      userId: 4,
      feedId: 12,
    });
    expect(database.db.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      clientFeed.notifyFeedUpdated.mock.invocationCallOrder[0],
    );
  });
});
