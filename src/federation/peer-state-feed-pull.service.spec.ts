import { describe, expect, it, vi } from 'vitest';
import { PeerStateFeedPullService } from './peer-state-feed-pull.service.js';
import type { PeerStateFeedPage } from './peer-state-feed.service.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';

function page(scannedThrough: string, hasMore = false): PeerStateFeedPage {
  return {
    items: [],
    scannedThrough,
    stateFeedEndId: scannedThrough,
    profileNamespaceFeedEndId: '0',
    hasMore,
  };
}

function harness(pulledThrough: bigint | null = 0n) {
  const order: string[] = [];
  const epoch = { stateFeedPulledThrough: pulledThrough };
  const limit = vi.fn(async () => [
    { pulledThrough: epoch.stateFeedPulledThrough },
  ]);
  const selectChain = () => ({
    from: () => ({ where: () => ({ limit }) }),
  });
  const whereUpdate = vi.fn(async () => undefined);
  const setUpdate = vi.fn(
    (values: { stateFeedPulledThrough: bigint | null }) => ({
      where: async () => {
        Object.assign(epoch, values);
        order.push('cursor');
        return whereUpdate();
      },
    }),
  );
  const tx = {
    execute: vi.fn().mockResolvedValue({ rows: [{ locked: true }] }),
    select: vi.fn(selectChain),
    update: vi.fn(() => ({ set: setUpdate })),
  };
  const database = {
    db: {
      transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
      select: vi.fn(selectChain),
    },
  };
  return {
    service: new PeerStateFeedPullService(database as never),
    database,
    epoch,
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
            eventType: 'THREAD_CONTENT_HEAD',
            feedId: '1',
            body: {
              messageEndSeq: 0,
              tombstoneEndSeq: 0,
              groupMetaFeedEndId: '1',
            },
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
              eventType: 'THREAD_CONTENT_HEAD',
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

  it('commits asynchronous work together with the item cursor', async () => {
    const { service, order, whereUpdate } = harness();
    const afterCommit = vi.fn();

    await service.run('peer.test', 12, {
      fetch: async () => ({
        ...page('1'),
        items: [
          {
            account: '!group',
            eventType: 'THREAD_CONTENT_HEAD',
            feedId: '1',
            body: {
              messageEndSeq: 0,
              tombstoneEndSeq: 0,
              groupMetaFeedEndId: '8',
            },
          },
        ],
      }),
      apply: async () => {
        order.push('dependency');
      },
      afterCommit,
    });

    expect(order).toEqual(['dependency', 'cursor']);
    expect(whereUpdate).toHaveBeenCalledOnce();
    expect(afterCommit).toHaveBeenCalledOnce();
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
              eventType: 'THREAD_CONTENT_HEAD',
              feedId: '1',
              body: {},
            },
            {
              account: '!group-b',
              eventType: 'THREAD_CONTENT_HEAD',
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
              eventType: 'THREAD_CONTENT_HEAD',
              feedId: '1',
              body: {},
            },
            {
              account: '!group-b',
              eventType: 'THREAD_CONTENT_HEAD',
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
          eventType: 'THREAD_CONTENT_HEAD' as const,
          feedId: '2',
          body: {},
        },
        {
          account: '!group-c',
          eventType: 'THREAD_CONTENT_HEAD' as const,
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
              eventType: 'THREAD_CONTENT_HEAD',
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

  it('initializes from zero without warning and continues the drain', async () => {
    const { service, order, epoch } = harness(null);
    const logger = { warn: vi.fn(), log: vi.fn() };
    Object.assign(service, { logger });
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new RemoteFeedCursorUnavailableError(0n, 4n))
      .mockResolvedValueOnce(page('3'));
    await service.run('peer.test', 12, {
      fetch,
      apply: async () => void order.push('state'),
    });
    expect(epoch.stateFeedPulledThrough).toBe(3n);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      'initialized state-feed cursor for peer peer.test (namespace 12) at 0',
    );
    expect(fetch).toHaveBeenNthCalledWith(1, undefined, undefined);
    expect(fetch).toHaveBeenNthCalledWith(2, 0n, undefined);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([0n, 2n, 4n])(
    'rejects reset to %s for an initialized cursor without changing progress',
    async (resumeAfter) => {
      const { service, epoch, database } = harness(2n);
      const fetch = vi
        .fn()
        .mockRejectedValue(
          new RemoteFeedCursorUnavailableError(resumeAfter, 5n),
        );
      const apply = vi.fn();
      await expect(
        service.run('peer.test', 12, { fetch, apply }),
      ).rejects.toThrow(
        'initialized state-feed cursor rejected by peer peer.test (namespace 12, committedThrough=2',
      );
      expect(epoch.stateFeedPulledThrough).toBe(2n);
      expect(database.db.transaction).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [-1n, 4n],
    [1n, 4n],
    [0n, 0n],
  ])('rejects invalid bootstrap bounds %s / %s', async (after, before) => {
    const { service, epoch, database } = harness(null);
    const fetch = vi
      .fn()
      .mockRejectedValue(new RemoteFeedCursorUnavailableError(after, before));
    await expect(
      service.run('peer.test', 12, { fetch, apply: vi.fn() }),
    ).rejects.toThrow('invalid state-feed bootstrap cursor');
    expect(epoch.stateFeedPulledThrough).toBeNull();
    expect(database.db.transaction).not.toHaveBeenCalled();
  });
});
