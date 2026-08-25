import { describe, expect, it, vi } from 'vitest';
import { PeerStateFeedPullService } from './peer-state-feed-pull.service.js';
import type { PeerStateFeedPage } from './peer-state-feed.service.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';

function page(scannedThrough: string, hasMore = false): PeerStateFeedPage {
  return {
    items: [],
    scannedThrough,
    stateFeedEndId: scannedThrough,
    hasMore,
  };
}

function harness(committedThrough = 0n) {
  const order: string[] = [];
  const limit = vi.fn().mockResolvedValue([
    {
      peerDomain: 'peer.test',
      initialized: true,
      committedThrough,
      updatedAt: new Date(),
    },
  ]);
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })),
  }));
  const whereUpdate = vi.fn(async () => order.push('cursor'));
  const tx = {
    execute: vi.fn().mockResolvedValue({ rows: [{ locked: true }] }),
    select,
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: whereUpdate })) })),
  };
  const database = {
    db: {
      transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
      query: {
        peerStateFeedPullCursor: {
          findFirst: vi.fn().mockResolvedValue({ committedThrough }),
        },
      },
    },
  };
  return {
    service: new PeerStateFeedPullService(database as never),
    order,
    whereUpdate,
  };
}

describe('PeerStateFeedPullService atomic page application', () => {
  it('publishes only after state and cursor commit', async () => {
    const { service, order } = harness();
    await service.run('peer.test', {
      fetch: async () => page('0'),
      apply: async () => void order.push('state'),
      afterCommit: async () => void order.push('publish'),
    });
    expect(order).toEqual(['state', 'cursor', 'publish']);
  });

  it('rolls the page back without publishing when one state item is invalid', async () => {
    const { service, order, whereUpdate } = harness();
    await expect(
      service.run('peer.test', {
        fetch: async () => page('0'),
        apply: async () => {
          order.push('state');
          throw new Error('invalid state');
        },
        afterCommit: async () => void order.push('publish'),
      }),
    ).rejects.toThrow('invalid state');
    expect(order).toEqual(['state']);
    expect(whereUpdate).not.toHaveBeenCalled();
  });

  it('rejects unordered or out-of-bound revs before applying state', async () => {
    const { service } = harness(2n);
    const apply = vi.fn();
    await expect(
      service.run('peer.test', {
        fetch: async () => ({
          items: [
            {
              account: 'a',
              domain: 'peer.test',
              eventType: 'PROFILE',
              feedId: '2',
              body: {},
            },
          ],
          scannedThrough: '3',
          stateFeedEndId: '3',
          hasMore: false,
        }),
        apply,
      }),
    ).rejects.toThrow('unordered');
    expect(apply).not.toHaveBeenCalled();
  });

  it('starts a replacement rebuild before committing a corrected cursor', async () => {
    const { service, order } = harness(2n);
    const warn = vi.fn();
    (service as unknown as { logger: { warn: typeof warn } }).logger.warn = warn;
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new RemoteFeedCursorUnavailableError(0n, 4n))
      .mockRejectedValueOnce(new Error('replacement fetch failed'));
    await expect(
      service.run('peer.test', {
        fetch,
        beginRebuild: async () => void order.push('rebuild'),
        apply: async () => void order.push('state'),
      }),
    ).rejects.toThrow('replacement fetch failed');
    expect(order).toEqual(['rebuild', 'cursor']);
    expect(warn).toHaveBeenCalledWith(
      'state-feed cursor for peer peer.test is unavailable; rebuilding from 0',
    );
    expect(fetch).toHaveBeenNthCalledWith(1, 2n, undefined);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
