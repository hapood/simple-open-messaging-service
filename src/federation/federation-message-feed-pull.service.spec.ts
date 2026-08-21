import { describe, expect, it, vi } from 'vitest';
import { FederationMessageFeedPullService } from './federation-message-feed-pull.service.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';
import type { FederationMessageFeedPage } from './federation-message-feed.service.js';

function page(
  scannedThrough: string,
  hasMore = false,
): FederationMessageFeedPage {
  return {
    items: [],
    scannedThrough,
    messageFeedEndId: scannedThrough,
    hasMore,
  };
}

function harness(committedThrough = 0n, initialized = true) {
  const order: string[] = [];
  const state = { initialized, retainedAfter: 0n, committedThrough };
  const execute = vi.fn().mockResolvedValue({ rows: [{ locked: true }] });
  const limit = vi.fn(async () => [
    {
      peerDomain: 'peer.test',
      initialized: state.initialized,
      retainedAfter: state.retainedAfter,
      committedThrough: state.committedThrough,
      updatedAt: new Date(),
    },
  ]);
  const whereSelect = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: whereSelect }));
  const select = vi.fn(() => ({ from }));
  let nextUpdate: {
    initialized?: boolean;
    retainedAfter?: bigint;
    committedThrough?: bigint;
  } = {};
  const whereUpdate = vi.fn(async () => {
    if (nextUpdate.initialized !== undefined)
      state.initialized = nextUpdate.initialized;
    if (nextUpdate.retainedAfter !== undefined)
      state.retainedAfter = nextUpdate.retainedAfter;
    if (nextUpdate.committedThrough !== undefined)
      state.committedThrough = nextUpdate.committedThrough;
    order.push('cursor');
  });
  const set = vi.fn((value: typeof nextUpdate) => {
    nextUpdate = value;
    return { where: whereUpdate };
  });
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
          findFirst: vi.fn(async () => ({
            initialized: state.initialized,
            committedThrough: state.committedThrough,
          })),
        },
        peerStateFeedPullCursor: {
          findFirst: vi.fn(async () => undefined),
        },
      },
    },
  };
  return {
    service: new FederationMessageFeedPullService(database as never),
    order,
    transaction,
    whereUpdate,
    state,
  };
}

describe('FederationMessageFeedPullService commit boundary', () => {
  it('finishes remote page fetch before opening the apply transaction', async () => {
    const { service, transaction } = harness();

    await service.run('peer.test', {
      fetch: async () => {
        expect(transaction).not.toHaveBeenCalled();
        return page('0');
      },
      apply: async () => undefined,
    });

    expect(transaction).toHaveBeenCalledOnce();
  });

  it('positions an uninitialized cursor before requesting its first page', async () => {
    const { service, state } = harness(0n, false);
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new RemoteFeedCursorUnavailableError(4n))
      .mockResolvedValueOnce(page('6'))
      .mockResolvedValueOnce(page('6'));

    await service.run('peer.test', {
      fetch,
      apply: async () => undefined,
    });

    expect(fetch.mock.calls.map(([after]) => after)).toEqual([undefined, 4n]);
    expect(state).toEqual({
      initialized: true,
      retainedAfter: 4n,
      committedThrough: 6n,
    });
  });

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

  it('accepts an ordinary advancing page without reset metadata', async () => {
    const { service, state } = harness();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page('8'))
      .mockResolvedValueOnce(page('8'));

    await service.run('peer.test', {
      fetch,
      apply: async () => undefined,
    });

    expect(fetch.mock.calls.map(([after]) => after)).toEqual([0n]);
    expect(state.committedThrough).toBe(8n);
  });

  it('atomically adopts a monotonic remote floor and continues draining', async () => {
    const { service, state } = harness();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new RemoteFeedCursorUnavailableError(5n))
      .mockResolvedValueOnce(page('8'))
      .mockResolvedValueOnce(page('8'));
    const apply = vi.fn();
    const afterCommit = vi.fn();

    await service.run('peer.test', { fetch, apply, afterCommit });

    expect(fetch.mock.calls.map(([after]) => after)).toEqual([0n, 5n]);
    expect(state).toEqual({
      initialized: true,
      retainedAfter: 5n,
      committedThrough: 8n,
    });
    expect(apply).toHaveBeenCalledOnce();
    expect(afterCommit).toHaveBeenCalledOnce();
  });

  it('accepts a correcting cursor when the local after is beyond the source end', async () => {
    const { service, state, whereUpdate } = harness(5n);
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new RemoteFeedCursorUnavailableError(4n))
      .mockResolvedValueOnce(page('4'));

    await service.run('peer.test', {
      fetch,
      apply: async () => undefined,
    });

    expect(state.committedThrough).toBe(4n);
    expect(whereUpdate).toHaveBeenCalled();
  });

  it('freezes an advertised HWM as the page truncation boundary', async () => {
    const { service } = harness();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page('8'))
      .mockResolvedValueOnce(page('8'));
    service.advertise('peer.test', 8n);

    await service.run('peer.test', {
      fetch,
      apply: async () => undefined,
    });

    expect(fetch.mock.calls).toEqual([[0n, 8n]]);
  });

  it('does not fetch an advertised message window before its state dependency', async () => {
    const { service } = harness(4n);
    const fetch = vi.fn().mockResolvedValue(page('8'));
    service.advertise('peer.test', 8n, 5n);

    await service.run('peer.test', {
      fetch,
      apply: async () => undefined,
    });

    expect(fetch).not.toHaveBeenCalled();
  });
});
