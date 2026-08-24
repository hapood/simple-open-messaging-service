import { describe, expect, it, vi } from 'vitest';
import { ThreadParticipantService } from './thread-participant.service.js';

describe('ThreadParticipantService.endP2P transaction boundary', () => {
  it('writes the relationship revocation and clear boundary without a thread revision', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    const identities = [
      {
        id: 1,
        userId: 1,
        account: 'alice',
        domain: 'local',
        relationshipRev: 0,
      },
      { id: 2, userId: 2, account: 'bob', domain: 'local', relationshipRev: 0 },
    ];
    const tx = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ id: 10, revision: 1, authorized: true }],
      }),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(identities),
          })),
        })),
      })),
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
      writeSystemMessageInTx: vi
        .fn()
        .mockResolvedValue({ message: systemMessage }),
    };
    const service = new ThreadParticipantService(
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
    expect(messages.writeSystemMessageInTx).toHaveBeenCalledWith(
      tx,
      10,
      'FRIEND_REMOVED',
      2,
      { actorUserId: 1, markReadUserId: 1, recipientUserIds: [1, 2] },
    );
    expect(tx.execute).toHaveBeenCalledTimes(7);
    // RelationshipPair is locked first, then MessageThread (the third execute), and
    // only afterwards may participant/audience mutation begin.
    expect(tx.execute.mock.invocationCallOrder[2]).toBeLessThan(
      tx.update.mock.invocationCallOrder[0],
    );
    expect(tx.update).toHaveBeenCalledTimes(3);
    expect(tx.delete).not.toHaveBeenCalled(); // history-only compatibility grants no longer exist
    expect(stateFeed.writeManyInTx).not.toHaveBeenCalled();
  });
});

describe('ThreadParticipantService.setBlocked', () => {
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
    const service = new ThreadParticipantService(
      database as never,
      {} as never,
      clientFeed as never,
    );

    await service.setBlocked(4, 9, true);

    expect(clientFeed.writeInTx).toHaveBeenCalledWith(tx, {
      userId: 4,
      account: '',
      domain: '',
      eventType: 'THREAD_BLOCK',
      subjectAccount: '9',
      subjectDomain: '',
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
