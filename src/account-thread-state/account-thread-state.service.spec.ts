import { describe, expect, it, vi } from 'vitest';
import { AccountThreadStateService } from './account-thread-state.service.js';

describe('AccountThreadStateService.setBlocked', () => {
  it('commits the participant fact and client feed before notifying devices', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 31 }]);
    const where = vi.fn(() => ({ returning }));
    const set = vi.fn(() => ({ where }));
    // Answered in the exact order setBlocked drives the lock chain: thread
    // locate, P2P pairs, pair row lock, thread row lock, participant read,
    // head read.
    const responses = [
      { rows: [{ type: 'P2P', groupId: null, account: null, domain: null }] },
      {
        rows: [
          {
            id: '77',
            endpointAAccount: 'al',
            endpointADomain: 'local',
            endpointBAccount: 'bo',
            endpointBDomain: 'a.test',
          },
        ],
      },
      // One advisory lock per P2P endpoint business scope.
      { rows: [{ pg_advisory_xact_lock: 1 }] },
      { rows: [{ pg_advisory_xact_lock: 1 }] },
      { rows: [{ id: '77' }] },
      { rows: [{ id: 9 }] },
      { rows: [{ blocked: false }] },
      { rows: [{ feedId: 12, threadFeedEndId: 8 }] },
    ];
    const execute = vi.fn(() =>
      Promise.resolve(responses.shift() ?? { rows: [] }),
    );
    const tx = {
      execute,
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
