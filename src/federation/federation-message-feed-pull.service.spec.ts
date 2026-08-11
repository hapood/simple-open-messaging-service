import { describe, expect, it, vi } from 'vitest';
import {
  FederationMessageFeedPullService,
  RemoteMessageFeedCursorResetError,
} from './federation-message-feed-pull.service.js';
import type { FederationMessageFeedPage } from './federation-message-feed.service.js';

function page(
  scannedThrough: string,
  hasMore = false,
): FederationMessageFeedPage {
  return {
    messages: [],
    scannedThrough,
    allocatedThrough: scannedThrough,
    hasMore,
    degradation: null,
  };
}

function harness(remoteHwm = 0n) {
  const order: string[] = [];
  const state = { startChangeId: 0n, remoteHwm };
  const execute = vi.fn().mockResolvedValue({ rows: [{ locked: true }] });
  const limit = vi.fn(async () => [
    {
      peerDomain: 'peer.test',
      startChangeId: state.startChangeId,
      remoteHwm: state.remoteHwm,
      updatedAt: new Date(),
    },
  ]);
  const whereSelect = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: whereSelect }));
  const select = vi.fn(() => ({ from }));
  let nextUpdate: { startChangeId?: bigint; remoteHwm?: bigint } = {};
  const whereUpdate = vi.fn(async () => {
    if (nextUpdate.startChangeId !== undefined)
      state.startChangeId = nextUpdate.startChangeId;
    if (nextUpdate.remoteHwm !== undefined)
      state.remoteHwm = nextUpdate.remoteHwm;
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
          findFirst: vi.fn(async () => ({ remoteHwm: state.remoteHwm })),
        },
      },
    },
  };
  return {
    service: new FederationMessageFeedPullService(database as never),
    order,
    whereUpdate,
    state,
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

  it('atomically adopts a monotonic remote retention floor and continues draining', async () => {
    const { service, state } = harness();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new RemoteMessageFeedCursorResetError(5n, 5n, 8n))
      .mockResolvedValueOnce(page('8'))
      .mockResolvedValueOnce(page('8'));
    const apply = vi.fn();
    const afterCommit = vi.fn();

    await service.run('peer.test', { fetch, apply, afterCommit });

    expect(fetch.mock.calls.map(([after]) => after)).toEqual([0n, 5n, 8n]);
    expect(state).toEqual({ startChangeId: 5n, remoteHwm: 8n });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(afterCommit).toHaveBeenCalledTimes(2);
  });

  it('rejects a degradation marker beyond the advertised allocation', async () => {
    const { service, whereUpdate } = harness();
    const degraded = page('3');
    degraded.degradation = {
      kind: 'HISTORY_TRUNCATED',
      truncatedThrough: '4',
      since: 1,
    };

    await expect(
      service.run('peer.test', {
        fetch: async () => degraded,
        apply: async () => undefined,
      }),
    ).rejects.toThrow('invalid message-feed degradation');
    expect(whereUpdate).not.toHaveBeenCalled();
  });
});
