import { describe, expect, it, vi } from 'vitest';
import { ProfileNamespaceFeedPullService } from './profile-namespace-feed-pull.service.js';
import type { ProfileNamespaceFeedPage } from './profile-namespace-feed.service.js';

function page(
  items: Array<{ namespaceId: number; feedId: string }>,
  feedEndId: string,
  scannedThrough = feedEndId,
  hasMore = false,
): ProfileNamespaceFeedPage {
  return {
    items: items.map((item) => ({ ...item, generatedAt: 1000 })),
    scannedThrough,
    feedEndId,
    hasMore,
  };
}

function harness(pulledThrough = 0n) {
  const epoch = {
    profileNamespaceFeedPulledThrough: pulledThrough,
    sourceGeneratedAt: 0,
  };
  const limit = vi.fn(async () => [
    {
      pulledThrough: epoch.profileNamespaceFeedPulledThrough,
    },
  ]);
  const selectChain = () => ({ from: () => ({ where: () => ({ limit }) }) });
  const tx = {
    execute: vi.fn().mockResolvedValue({ rows: [{ locked: true }] }),
    select: vi.fn(selectChain),
    update: vi.fn(() => ({
      set: (values: {
        inboundProfileNamespaceFeedPulledThrough?: bigint;
        profileNamespaceFeedSourceGeneratedAt?: number;
      }) => ({
        where: async () => {
          if (values.inboundProfileNamespaceFeedPulledThrough !== undefined)
            epoch.profileNamespaceFeedPulledThrough =
              values.inboundProfileNamespaceFeedPulledThrough;
          if (values.profileNamespaceFeedSourceGeneratedAt !== undefined)
            epoch.sourceGeneratedAt =
              values.profileNamespaceFeedSourceGeneratedAt;
          return undefined;
        },
      }),
    })),
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
    service: new ProfileNamespaceFeedPullService(database as never),
    epoch,
    tx,
    database,
  };
}

describe('ProfileNamespaceFeedPullService drain', () => {
  it('applies each item in its own transaction and advances the cursor atomically', async () => {
    const { service, epoch } = harness();
    const applied: string[] = [];
    await service.run('peer.test', 12, {
      fetch: async () =>
        page(
          [
            { namespaceId: 3, feedId: '1' },
            { namespaceId: 4, feedId: '2' },
          ],
          '2',
        ),
      apply: async (tx, item) => {
        expect(tx).toBeDefined();
        applied.push(item.feedId);
        return {
          publisherNamespaceId: 12,
          profileNamespaceId: item.namespaceId,
          triggerFeedId: BigInt(item.feedId),
          expiredLocalRows: false,
          clientChangeId: BigInt(item.feedId),
        };
      },
    });
    expect(applied).toEqual(['1', '2']);
    expect(epoch.profileNamespaceFeedPulledThrough).toBe(2n);
    expect(epoch.sourceGeneratedAt).toBe(1000);
  });

  it('advances the cursor through empty pages and gaps without applying', async () => {
    const { service, epoch } = harness();
    const apply = vi.fn();
    await service.run('peer.test', 12, {
      fetch: async () => page([], '9'),
      apply,
    });
    expect(apply).not.toHaveBeenCalled();
    expect(epoch.profileNamespaceFeedPulledThrough).toBe(9n);
    expect(epoch.sourceGeneratedAt).toBe(0);
  });

  it('drains multiple pages until the fixed source end', async () => {
    const { service, epoch } = harness();
    const pages = [
      page([{ namespaceId: 1, feedId: '1' }], '5', '2', true),
      page([{ namespaceId: 2, feedId: '3' }], '5', '5', false),
    ];
    const seen: string[] = [];
    await service.run('peer.test', 12, {
      fetch: async (after) => {
        seen.push(String(after));
        return pages.shift()!;
      },
      apply: async (_tx, item) => ({
        publisherNamespaceId: 12,
        profileNamespaceId: item.namespaceId,
        triggerFeedId: BigInt(item.feedId),
        expiredLocalRows: false,
        clientChangeId: BigInt(item.feedId),
      }),
    });
    expect(seen).toEqual(['0', '2']);
    expect(epoch.profileNamespaceFeedPulledThrough).toBe(5n);
    expect(epoch.sourceGeneratedAt).toBe(1000);
  });

  it('rejects a page whose boundary math is inconsistent', async () => {
    const { service } = harness();
    await expect(
      service.run('peer.test', 12, {
        fetch: async () => page([], '5', '5', true),
        apply: async () => {
          throw new Error('unreachable');
        },
      }),
    ).rejects.toThrow('invalid profile namespace feed boundary');
  });

  it('rejects unordered items', async () => {
    const { service } = harness();
    await expect(
      service.run('peer.test', 12, {
        fetch: async () =>
          page(
            [
              { namespaceId: 2, feedId: '4' },
              { namespaceId: 1, feedId: '2' },
            ],
            '4',
          ),
        apply: async () => {
          throw new Error('unreachable');
        },
      }),
    ).rejects.toThrow('unordered profile namespace feed items');
  });

  it('reaches an advertised end across drain loops', async () => {
    const { service, epoch } = harness();
    service.advertise('peer.test', 12, 6n);
    let calls = 0;
    await service.run('peer.test', 12, {
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? page([{ namespaceId: 1, feedId: '3' }], '6', '3', true)
          : page([{ namespaceId: 2, feedId: '6' }], '6');
      },
      apply: async (_tx, item) => ({
        publisherNamespaceId: 12,
        profileNamespaceId: item.namespaceId,
        triggerFeedId: BigInt(item.feedId),
        expiredLocalRows: false,
        clientChangeId: BigInt(item.feedId),
      }),
    });
    expect(epoch.profileNamespaceFeedPulledThrough).toBe(6n);
    expect(epoch.sourceGeneratedAt).toBe(1000);
  });

  it('retains the last item time across a trailing scan gap', async () => {
    const { service, epoch } = harness();
    await service.run('peer.test', 12, {
      fetch: async () => page([{ namespaceId: 1, feedId: '1' }], '6'),
      apply: async (_tx, item) => ({
        publisherNamespaceId: 12,
        profileNamespaceId: item.namespaceId,
        triggerFeedId: BigInt(item.feedId),
        expiredLocalRows: false,
        clientChangeId: BigInt(item.feedId),
      }),
    });
    expect(epoch.profileNamespaceFeedPulledThrough).toBe(6n);
    expect(epoch.sourceGeneratedAt).toBe(1000);
  });
});
