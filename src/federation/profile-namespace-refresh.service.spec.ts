import { describe, expect, it, vi } from 'vitest';
import { ProfileNamespaceRefreshService } from './profile-namespace-refresh.service.js';

interface InsertValues {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  domain: string | null;
  rootPublicKey: string | null;
  updateFeedId: bigint;
  expired: boolean;
}

function harness(options?: {
  directRow?: Record<string, unknown> | null;
  bindings?: Array<Record<string, unknown>>;
  /** Parks the first peer fetch until the promise resolves (lets a test
   *  deliver a second trigger while a refresh is in flight). */
  parkFirstGet?: Promise<unknown>;
}) {
  const upserts: InsertValues[] = [];
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        // fetchBindings' publisher-domain lookup: every select answers the
        // directRow shape, whose `domain` drives the peer token capture.
        limit: async () =>
          options?.directRow === undefined ? [] : [options.directRow],
      }),
    }),
  }));
  const insert = vi.fn(() => ({
    values: (value: InsertValues) => ({
      onConflictDoUpdate: () => {
        upserts.push(value);
        return Promise.resolve(undefined);
      },
    }),
  }));
  const database = { db: { select, insert } };
  const peerHttp = {
    get: vi.fn(async () => {
      if (options?.parkFirstGet) {
        const gate = options.parkFirstGet;
        options.parkFirstGet = undefined;
        await gate;
      }
      return options?.bindings?.shift();
    }),
  };
  const trustedPeers = { run: (_d: string, op: () => unknown) => op() };
  const threadAccess = {
    capturePeerResponseToken: async (domain: string) => ({
      domain,
      namespaceId: 12,
    }),
  };
  const service = new ProfileNamespaceRefreshService(
    database as never,
    peerHttp as never,
    trustedPeers as never,
    threadAccess as never,
  );
  return { service, select, peerHttp, upserts };
}

describe('ProfileNamespaceRefreshService stale-response guard', () => {
  it('discards answers behind the trigger and persists only a current one', async () => {
    const { service, peerHttp, upserts } = harness({
      directRow: {
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        retiredAt: null,
        pulledThrough: 0n,
      },
      bindings: [
        {
          domain: 'c.test',
          rootPublicKey: 'c'.repeat(44),
          profileNamespaceFeedEndId: '2',
        },
        {
          domain: 'c2.test',
          rootPublicKey: 'd'.repeat(44),
          profileNamespaceFeedEndId: '7',
        },
      ],
    });
    service.scheduleRefresh(
      { publisherNamespaceId: 12, profileNamespaceId: 9 },
      5n,
    );
    await vi.waitFor(() => expect(upserts).toHaveLength(1));
    expect(peerHttp.get).toHaveBeenCalledTimes(2);
    expect(upserts[0]).toMatchObject({
      publisherNamespaceId: 12,
      profileNamespaceId: 9,
      domain: 'c2.test',
      updateFeedId: 7n,
      expired: false,
    });
  });
});

describe('ProfileNamespaceRefreshService.scheduleRefresh coalescing', () => {
  it('runs one trailing refresh with the max trigger counter when a higher trigger lands mid-refresh', async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { service, peerHttp, upserts } = harness({
      directRow: {
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        retiredAt: null,
        pulledThrough: 4n,
      },
      parkFirstGet: gate,
      bindings: [
        {
          domain: 'c1.test',
          rootPublicKey: 'a'.repeat(44),
          profileNamespaceFeedEndId: '5',
        },
        {
          domain: 'c2.test',
          rootPublicKey: 'b'.repeat(44),
          profileNamespaceFeedEndId: '9',
        },
      ],
    });
    const pair = { publisherNamespaceId: 12, profileNamespaceId: 9 };
    service.scheduleRefresh(pair, 5n);
    await vi.waitFor(() => expect(peerHttp.get).toHaveBeenCalled());
    // A higher counter lands while the refresh is still parked: it must not
    // be dropped (old behavior) nor fork a parallel refresh — one trailing
    // round with the merged max counter observes it.
    service.scheduleRefresh(pair, 9n);
    release(undefined);
    await vi.waitFor(() => expect(upserts).toHaveLength(2));
    expect(upserts[0]).toMatchObject({
      domain: 'c1.test',
      updateFeedId: 5n,
      expired: false,
    });
    expect(upserts[1]).toMatchObject({
      domain: 'c2.test',
      updateFeedId: 9n,
      expired: false,
    });
  });
});
