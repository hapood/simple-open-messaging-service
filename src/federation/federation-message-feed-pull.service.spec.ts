import { describe, expect, it, vi } from 'vitest';
import { FederationMessageFeedPullService } from './federation-message-feed-pull.service.js';
import type { FederationMessageFeedPage } from './federation-message-feed.service.js';

function page(scannedThrough: string, hasMore = false): FederationMessageFeedPage {
  return {
    messages: [],
    scannedThrough,
    allocatedThrough: scannedThrough,
    hasMore,
  };
}

function harness(remoteHwm = 0n) {
  const order: string[] = [];
  const execute = vi.fn().mockResolvedValue({ rows: [{ locked: true }] });
  const limit = vi.fn().mockResolvedValue([
    {
      peerDomain: 'peer.test',
      startChangeId: 0n,
      remoteHwm,
      updatedAt: new Date(),
    },
  ]);
  const whereSelect = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: whereSelect }));
  const select = vi.fn(() => ({ from }));
  const whereUpdate = vi.fn(async () => {
    order.push('cursor');
  });
  const set = vi.fn(() => ({ where: whereUpdate }));
  const update = vi.fn(() => ({ set }));
  const tx = { execute, select, update };
  const transaction = vi.fn(
    async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
  );
  const database = {
    db: {
      transaction,
      query: {
        federationPullCursor: {
          findFirst: vi.fn().mockResolvedValue({ remoteHwm }),
        },
      },
    },
  };
  return {
    service: new FederationMessageFeedPullService(database as never),
    order,
    whereUpdate,
  };
}

describe('FederationMessageFeedPullService commit boundary', () => {
  it('publishes a page only after apply and cursor advancement complete', async () => {
    const { service, order } = harness();
    const fetch = vi.fn().mockResolvedValue(page('0'));

    await service.run('peer.test', {
      fetch,
      apply: async () => {
        order.push('apply');
      },
      afterCommit: async () => {
        order.push('publish');
      },
    });

    expect(order).toEqual(['apply', 'cursor', 'publish']);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not publish or advance the cursor when page application fails', async () => {
    const { service, order, whereUpdate } = harness();

    await expect(
      service.run('peer.test', {
        fetch: async () => page('0'),
        apply: async () => {
          order.push('apply');
          throw new Error('invalid page');
        },
        afterCommit: async () => {
          order.push('publish');
        },
      }),
    ).rejects.toThrow('invalid page');

    expect(order).toEqual(['apply']);
    expect(whereUpdate).not.toHaveBeenCalled();
  });
});
