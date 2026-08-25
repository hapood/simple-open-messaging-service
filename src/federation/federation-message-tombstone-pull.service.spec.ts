import { describe, expect, it, vi } from 'vitest';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';
import { FederationMessageTombstonePullService } from './federation-message-tombstone-pull.service.js';

function harness(committedThrough = 2n) {
  const state = { initialized: true, committedThrough };
  let update: Partial<typeof state> = {};
  const limit = vi.fn(async () => [{
    peerDomain: 'peer.test',
    ...state,
    updatedAt: new Date(),
  }]);
  const tx = {
    execute: vi.fn().mockResolvedValue({ rows: [{ locked: true }] }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value: Partial<typeof state>) => {
        update = value;
        return {
          where: vi.fn(async () => Object.assign(state, update)),
        };
      }),
    })),
  };
  const database = {
    db: {
      transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
      query: {
        federationTombstonePullCursor: {
          findFirst: vi.fn(async () => ({
            committedThrough: state.committedThrough,
          })),
        },
      },
    },
  };
  return {
    service: new FederationMessageTombstonePullService(database as never),
    state,
  };
}

describe('FederationMessageTombstonePullService cursor recovery', () => {
  it('warns, skips unavailable history, and resumes from the peer cursor', async () => {
    const { service, state } = harness();
    const warn = vi.fn();
    (service as unknown as { logger: { warn: typeof warn } }).logger.warn = warn;
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new RemoteFeedCursorUnavailableError(5n, 9n))
      .mockResolvedValueOnce({
        items: [],
        scannedThrough: '5',
        tombstoneFeedEndId: '5',
        hasMore: false,
      });

    await service.run('peer.test', {
      fetch,
      apply: async () => undefined,
    });

    expect(fetch.mock.calls.map(([after]) => after)).toEqual([2n, 5n]);
    expect(state.committedThrough).toBe(5n);
    expect(warn).toHaveBeenCalledWith(
      'tombstone-feed cursor for peer peer.test is unavailable; resuming from 5',
    );
  });
});
