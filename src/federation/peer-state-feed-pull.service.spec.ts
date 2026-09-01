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
  const cursor = {
    peerDomain: 'peer.test',
    initialized: true,
    committedThrough,
    updatedAt: new Date(),
  };
  const limit = vi.fn(async () => [{ ...cursor }]);
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })),
  }));
  const whereUpdate = vi.fn(async () => undefined);
  const setUpdate = vi.fn((values: Partial<typeof cursor>) => ({
    where: async () => {
      Object.assign(cursor, values);
      order.push('cursor');
      return whereUpdate();
    },
  }));
  const tx = {
    execute: vi.fn().mockResolvedValue({ rows: [{ locked: true }] }),
    select,
    update: vi.fn(() => ({ set: setUpdate })),
  };
  const database = {
    db: {
      transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
      query: {
        peerStateFeedPullCursor: {
          findFirst: vi.fn(async () => ({ ...cursor })),
        },
      },
    },
  };
  return {
    service: new PeerStateFeedPullService(database as never),
    database,
    order,
    whereUpdate,
  };
}

describe('PeerStateFeedPullService atomic item application', () => {
  it('publishes each item only after its state and cursor commit', async () => {
    const { service, order } = harness();
    await service.run('peer.test', 12, {
      fetch: async () => ({
        ...page('1'),
        items: [
          {
            account: '!group',
            eventType: 'GROUP_META_FEED_HEAD',
            feedId: '1',
            body: { groupMetaFeedEndId: '1' },
          },
        ],
      }),
      apply: async () => void order.push('state'),
      afterCommit: async () => void order.push('publish'),
    });
    expect(order).toEqual(['state', 'cursor', 'publish']);
  });

  it('rolls the page back without publishing when one state item is invalid', async () => {
    const { service, order, whereUpdate } = harness();
    await expect(
      service.run('peer.test', 12, {
        fetch: async () => ({
          ...page('1'),
          items: [
            {
              account: '!group',
              eventType: 'GROUP_META_FEED_HEAD',
              feedId: '1',
              body: {},
            },
          ],
        }),
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

  it('keeps an earlier item committed when a later item fails', async () => {
    const { service, order } = harness();
    const apply = vi.fn(async (_tx: unknown, itemPage: PeerStateFeedPage) => {
      const feedId = itemPage.items[0]!.feedId;
      order.push(`state-${feedId}`);
      if (feedId === '2') throw new Error('second item failed');
    });
    await expect(
      service.run('peer.test', 12, {
        fetch: async () => ({
          items: [
            {
              account: '!group-a',
              eventType: 'GROUP_META_FEED_HEAD',
              feedId: '1',
              body: {},
            },
            {
              account: '!group-b',
              eventType: 'GROUP_META_FEED_HEAD',
              feedId: '2',
              body: {},
            },
          ],
          scannedThrough: '2',
          stateFeedEndId: '2',
          hasMore: false,
        }),
        apply,
        afterCommit: async (itemPage) =>
          void order.push(`publish-${itemPage.items[0]!.feedId}`),
      }),
    ).rejects.toThrow('second item failed');
    expect(order).toEqual(['state-1', 'cursor', 'publish-1', 'state-2']);
  });

  it('resumes from the last committed item after the pull service is recreated', async () => {
    const { service, database, order } = harness();
    const firstApply = vi.fn(
      async (_tx: unknown, itemPage: PeerStateFeedPage) => {
        const feedId = itemPage.items[0]!.feedId;
        order.push(`state-${feedId}`);
        if (feedId === '2') throw new Error('process stopped on item 2');
      },
    );
    await expect(
      service.run('peer.test', 12, {
        fetch: async () => ({
          items: [
            {
              account: '!group-a',
              eventType: 'GROUP_META_FEED_HEAD',
              feedId: '1',
              body: {},
            },
            {
              account: '!group-b',
              eventType: 'GROUP_META_FEED_HEAD',
              feedId: '2',
              body: {},
            },
          ],
          scannedThrough: '2',
          stateFeedEndId: '2',
          hasMore: false,
        }),
        apply: firstApply,
        afterCommit: async (itemPage) =>
          void order.push(`publish-${itemPage.items[0]!.feedId}`),
      }),
    ).rejects.toThrow('process stopped on item 2');

    const resumed = new PeerStateFeedPullService(database as never);
    const resumedFetch = vi.fn(async () => ({
      items: [
        {
          account: '!group-b',
          eventType: 'GROUP_META_FEED_HEAD' as const,
          feedId: '2',
          body: {},
        },
        {
          account: '!group-c',
          eventType: 'GROUP_META_FEED_HEAD' as const,
          feedId: '3',
          body: {},
        },
      ],
      scannedThrough: '3',
      stateFeedEndId: '3',
      hasMore: false,
    }));
    await resumed.run('peer.test', 12, {
      fetch: resumedFetch,
      apply: async (_tx, itemPage) =>
        void order.push(`state-${itemPage.items[0]!.feedId}`),
      afterCommit: async (itemPage) =>
        void order.push(`publish-${itemPage.items[0]!.feedId}`),
    });

    expect(resumedFetch).toHaveBeenCalledWith(1n, undefined);
    expect(order).toEqual([
      'state-1',
      'cursor',
      'publish-1',
      'state-2',
      'state-2',
      'cursor',
      'publish-2',
      'state-3',
      'cursor',
      'publish-3',
    ]);
  });

  it('rejects unordered or out-of-bound revs before applying state', async () => {
    const { service } = harness(2n);
    const apply = vi.fn();
    await expect(
      service.run('peer.test', 12, {
        fetch: async () => ({
          items: [
            {
              account: 'a',
              eventType: 'GROUP_META_FEED_HEAD',
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
    (service as unknown as { logger: { warn: typeof warn } }).logger.warn =
      warn;
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new RemoteFeedCursorUnavailableError(0n, 4n))
      .mockRejectedValueOnce(new Error('replacement fetch failed'));
    await expect(
      service.run('peer.test', 12, {
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
