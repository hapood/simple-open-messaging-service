import { describe, expect, it, vi } from 'vitest';
import { ProfileNamespaceRefreshService } from './profile-namespace-refresh.service.js';

interface InsertValues {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  domain: string | null;
  rootPublicKey: string | null;
  updateFeedId: bigint;
  expired: boolean;
  status: string;
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
  const transaction = vi.fn(async (body: (tx: unknown) => Promise<unknown>) =>
    body({ insert }),
  );
  const database = { db: { select, insert, transaction } };
  const recordClientChange = vi.fn(async (_tx: unknown, _pair: unknown) => 42n);
  const feed = { recordClientChangeInTx: recordClientChange };
  const notifyProfileNamespaceChange = vi.fn();
  const sse = { notifyProfileNamespaceChange };
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
    feed as never,
    sse as never,
  );
  return {
    service,
    select,
    peerHttp,
    upserts,
    recordClientChange,
    notifyProfileNamespaceChange,
  };
}

describe('ProfileNamespaceRefreshService stale-response guard', () => {
  it('discards answers behind the trigger and persists only a current one', async () => {
    const { service, peerHttp, upserts } = harness({
      directRow: {
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        retiredAt: null,
        active: true,
        pulledThrough: 0n,
      },
      bindings: [
        {
          domain: 'c.test',
          rootPublicKey: 'c'.repeat(44),
          profileNamespaceFeedEndId: '2',
          status: 'ACTIVE',
        },
        {
          domain: 'c2.test',
          rootPublicKey: 'd'.repeat(44),
          profileNamespaceFeedEndId: '7',
          status: 'ACTIVE',
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

  it('records a client change and wakes devices when a third-party refresh converges', async () => {
    const {
      service,
      upserts,
      recordClientChange,
      notifyProfileNamespaceChange,
    } = harness({
      directRow: {
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        retiredAt: null,
        active: true,
        pulledThrough: 0n,
      },
      bindings: [
        {
          domain: 'c.test',
          rootPublicKey: 'c'.repeat(44),
          profileNamespaceFeedEndId: '7',
          status: 'ACTIVE',
        },
      ],
    });
    const pair = { publisherNamespaceId: 12, profileNamespaceId: 9 };
    service.scheduleRefresh(pair, 5n);
    await vi.waitFor(() => expect(upserts).toHaveLength(1));
    // The converged upsert and the change entry share one transaction, and
    // the allocated change id drives the wake broadcast.
    expect(recordClientChange).toHaveBeenCalledTimes(1);
    expect(recordClientChange.mock.calls[0]?.[0]).toEqual(expect.anything());
    expect(recordClientChange.mock.calls[0]?.[1]).toEqual(pair);
    expect(notifyProfileNamespaceChange).toHaveBeenCalledWith(42n);
  });

  it('records no client change when every attempt stays behind the trigger', async () => {
    const {
      service,
      peerHttp,
      recordClientChange,
      notifyProfileNamespaceChange,
    } = harness({
      directRow: {
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        retiredAt: null,
        active: true,
        pulledThrough: 0n,
      },
      bindings: [
        {
          domain: 'c.test',
          rootPublicKey: 'c'.repeat(44),
          profileNamespaceFeedEndId: '1',
          status: 'ACTIVE',
        },
        {
          domain: 'c.test',
          rootPublicKey: 'c'.repeat(44),
          profileNamespaceFeedEndId: '2',
          status: 'ACTIVE',
        },
        {
          domain: 'c.test',
          rootPublicKey: 'c'.repeat(44),
          profileNamespaceFeedEndId: '3',
          status: 'ACTIVE',
        },
      ],
    });
    const pair = { publisherNamespaceId: 12, profileNamespaceId: 9 };
    service.scheduleRefresh(pair, 5n);
    // All three attempts answer behind the trigger: the guard discards each
    // one and the flight fails — no convergence, so no change entry and no
    // wake (scheduleRefresh logs and swallows the error).
    await vi.waitFor(() => expect(peerHttp.get).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recordClientChange).not.toHaveBeenCalled();
    expect(notifyProfileNamespaceChange).not.toHaveBeenCalled();
  });
});

describe('ProfileNamespaceRefreshService.scheduleRefresh coalescing', () => {
  it('runs one trailing refresh with the max trigger counter when a higher trigger lands mid-refresh', async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { service, peerHttp, upserts, recordClientChange } = harness({
      directRow: {
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        retiredAt: null,
        active: true,
        pulledThrough: 4n,
      },
      parkFirstGet: gate,
      bindings: [
        {
          domain: 'c1.test',
          rootPublicKey: 'a'.repeat(44),
          profileNamespaceFeedEndId: '5',
          status: 'ACTIVE',
        },
        {
          domain: 'c2.test',
          rootPublicKey: 'b'.repeat(44),
          profileNamespaceFeedEndId: '9',
          status: 'ACTIVE',
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
    // Coalesced rounds record exactly one change entry each.
    expect(recordClientChange).toHaveBeenCalledTimes(2);
  });
});

describe('ProfileNamespaceRefreshService lifecycle status', () => {
  it('persists the publisher-disclosed ARCHIVED status instead of assuming ACTIVE', async () => {
    const { service, upserts } = harness({
      directRow: {
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        retiredAt: null,
        active: true,
        pulledThrough: 0n,
      },
      bindings: [
        {
          domain: 'gone.test',
          rootPublicKey: 'g'.repeat(44),
          profileNamespaceFeedEndId: '7',
          status: 'ARCHIVED',
        },
      ],
    });
    service.scheduleRefresh(
      { publisherNamespaceId: 12, profileNamespaceId: 9 },
      5n,
    );
    await vi.waitFor(() => expect(upserts).toHaveLength(1));
    expect(upserts[0]).toMatchObject({
      domain: 'gone.test',
      status: 'ARCHIVED',
      expired: false,
    });
  });

  it('rejects a malformed status so it never reaches the database check', async () => {
    const { service, upserts, peerHttp } = harness({
      directRow: {
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        retiredAt: null,
        active: true,
        pulledThrough: 0n,
      },
      bindings: [
        {
          domain: 'c.test',
          rootPublicKey: 'c'.repeat(44),
          profileNamespaceFeedEndId: '7',
          status: 'ZOMBIE',
        },
      ],
    });
    service.scheduleRefresh(
      { publisherNamespaceId: 12, profileNamespaceId: 9 },
      5n,
    );
    // A malformed status fails the flight immediately — it is a protocol
    // violation, not a stale answer, so no retry is spent (scheduleRefresh
    // logs and swallows) and nothing reaches the database.
    await vi.waitFor(() => expect(peerHttp.get).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upserts).toHaveLength(0);
  });

  it('converges a reset-retired publisher self-row to ARCHIVED with its retained bindings', async () => {
    const { service, upserts, peerHttp } = harness({
      directRow: {
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        retiredAt: new Date(),
        active: false,
        pulledThrough: 4n,
      },
    });
    service.scheduleRefresh(
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
      3n,
    );
    await vi.waitFor(() => expect(upserts).toHaveLength(1));
    // The self-row answers locally from the registry: no s2s fetch, and the
    // retained bindings stay disclosed with the ARCHIVED lifecycle.
    expect(peerHttp.get).not.toHaveBeenCalled();
    expect(upserts[0]).toMatchObject({
      publisherNamespaceId: 12,
      profileNamespaceId: 0,
      domain: 'peer.test',
      rootPublicKey: 'r'.repeat(44),
      updateFeedId: 4n,
      expired: false,
      status: 'ARCHIVED',
    });
  });

  it('converges a live publisher self-row as ACTIVE', async () => {
    const { service, upserts } = harness({
      directRow: {
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        retiredAt: null,
        active: true,
        pulledThrough: 4n,
      },
    });
    service.scheduleRefresh(
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
      3n,
    );
    await vi.waitFor(() => expect(upserts).toHaveLength(1));
    expect(upserts[0]).toMatchObject({
      status: 'ACTIVE',
      expired: false,
    });
  });
});
