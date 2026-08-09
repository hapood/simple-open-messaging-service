import { describe, expect, it, vi } from 'vitest';
import { ThreadParticipantService } from './thread-participant.service.js';

describe('ThreadParticipantService.endP2P transaction boundary', () => {
  it('writes relationship, clear boundary and both revisions before publishing SSE', async () => {
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
      execute: vi.fn().mockResolvedValue({ rows: [{ id: 10, revision: 1 }] }),
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
    let committed = false;
    const database = {
      db: {
        transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => {
          const result = await fn(tx);
          committed = true;
          return result;
        }),
      },
    };
    const revisions = {
      isThreadHiddenInTx: vi.fn().mockResolvedValue(false),
      recordThreadDeleteInTx: vi.fn().mockResolvedValue(11),
      recordThreadAddInTx: vi.fn().mockResolvedValue(7),
      notifyThreadRevision: vi.fn(() => expect(committed).toBe(true)),
    };
    const service = new ThreadParticipantService(
      database as never,
      revisions as never,
    );

    await expect(service.endP2P(10, 1, true, 2)).resolves.toEqual({
      transitioned: true,
      statePeers: [],
    });
    expect(tx.execute).toHaveBeenCalledTimes(6);
    // FriendPair is locked first, then MessageThread (the third execute), and
    // only afterwards may participant/audience mutation begin.
    expect(tx.execute.mock.invocationCallOrder[2]).toBeLessThan(
      tx.update.mock.invocationCallOrder[0],
    );
    expect(tx.update).toHaveBeenCalledTimes(3);
    expect(tx.delete).not.toHaveBeenCalled();
    expect(revisions.recordThreadDeleteInTx).toHaveBeenCalledWith(tx, 1, 10);
    expect(revisions.recordThreadAddInTx).toHaveBeenCalledWith(tx, 2, 10);
    expect(revisions.notifyThreadRevision).toHaveBeenCalledTimes(2);
  });

  it('publishes no SSE if either revision write aborts the transaction', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
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
      execute: vi.fn().mockResolvedValue({ rows: [{ id: 10, revision: 1 }] }),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(identities),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
      })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    };
    const database = {
      db: {
        transaction: vi.fn(async (fn: (client: typeof tx) => unknown) =>
          fn(tx),
        ),
      },
    };
    const rollback = new Error('peer revision failed');
    const revisions = {
      isThreadHiddenInTx: vi.fn().mockResolvedValue(false),
      recordThreadAddInTx: vi
        .fn()
        .mockResolvedValueOnce(11)
        .mockRejectedValueOnce(rollback),
      notifyThreadRevision: vi.fn(),
    };
    const service = new ThreadParticipantService(
      database as never,
      revisions as never,
    );

    await expect(service.endP2P(10, 1, false, 2)).rejects.toBe(rollback);
    expect(revisions.notifyThreadRevision).not.toHaveBeenCalled();
  });
});
