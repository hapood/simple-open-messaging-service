import { describe, expect, it, vi } from 'vitest';
import { ProfileNamespaceRefreshService } from './profile-namespace-refresh.service.js';

interface InsertValues {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  domain: string | null;
  rootPublicKey: string | null;
  updateFeedId: bigint;
  expired: boolean;
  status?: string;
}

function harness(options?: {
  directRow?: Record<string, unknown> | null;
  bindings?: Array<Record<string, unknown>>;
  /** Parks the first peer fetch until the promise resolves (lets a test
   *  deliver a second trigger while a refresh is in flight). */
  parkFirstGet?: Promise<unknown>;
}) {
  const upserts: InsertValues[] = [];
  const updates: Array<Record<string, unknown>> = [];
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
      onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
        updates.push(set);
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
    updates,
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
        },
        {
          domain: 'c.test',
          rootPublicKey: 'c'.repeat(44),
          profileNamespaceFeedEndId: '2',
        },
        {
          domain: 'c.test',
          rootPublicKey: 'c'.repeat(44),
          profileNamespaceFeedEndId: '3',
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
    // Coalesced rounds record exactly one change entry each.
    expect(recordClientChange).toHaveBeenCalledTimes(2);
  });
});

describe('ProfileNamespaceRefreshService client fetch', () => {
  it('joins an active prefetch without adding trailing rounds for repeated client demands', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, peerHttp, upserts } = harness({
      directRow: { domain: 'peer.test', pulledThrough: 5n },
      parkFirstGet: gate,
      bindings: [
        {
          domain: 'subject.test',
          rootPublicKey: 'root',
          profileNamespaceFeedEndId: '5',
        },
      ],
    });
    const pair = { publisherNamespaceId: 12, profileNamespaceId: 9 };
    service.scheduleRefresh(pair, 5n);
    await vi.waitFor(() => expect(peerHttp.get).toHaveBeenCalledOnce());
    await service.fetch(pair);
    await service.fetch(pair);
    release();
    await vi.waitFor(() => expect(upserts).toHaveLength(1));
    expect(peerHttp.get).toHaveBeenCalledOnce();
  });

  it('allows client demand to fetch again after a failed prefetch', async () => {
    const { service, peerHttp, upserts } = harness({
      directRow: { domain: 'peer.test', pulledThrough: 5n },
      bindings: [
        { profileNamespaceFeedEndId: 'invalid' },
        {
          domain: 'subject.test',
          rootPublicKey: 'root',
          profileNamespaceFeedEndId: '5',
        },
      ],
    });
    const pair = { publisherNamespaceId: 12, profileNamespaceId: 9 };
    service.scheduleRefresh(pair, 5n);
    await vi.waitFor(() => expect(peerHttp.get).toHaveBeenCalledOnce());
    await new Promise((resolve) => setImmediate(resolve));
    expect(upserts).toHaveLength(0);
    await service.fetch(pair);
    await vi.waitFor(() => expect(upserts).toHaveLength(1));
    expect(peerHttp.get).toHaveBeenCalledTimes(2);
  });

  it('uses the observed publisher cursor to reject stale answers after prefetch work was lost', async () => {
    const { service, peerHttp, upserts } = harness({
      directRow: { domain: 'peer.test', pulledThrough: 5n },
      bindings: [
        {
          domain: 'old.test',
          rootPublicKey: 'root',
          profileNamespaceFeedEndId: '4',
        },
        {
          domain: 'subject.test',
          rootPublicKey: 'root',
          profileNamespaceFeedEndId: '5',
        },
      ],
    });
    await service.fetch({ publisherNamespaceId: 12, profileNamespaceId: 9 });
    await vi.waitFor(() => expect(upserts).toHaveLength(1));
    expect(upserts[0]).toMatchObject({
      domain: 'subject.test',
      updateFeedId: 5n,
    });
    expect(peerHttp.get).toHaveBeenCalledTimes(2);
  });
});

describe('ProfileNamespaceRefreshService lifecycle status', () => {
  it('accepts bindings without a lifecycle and leaves local status out of inserts and updates', async () => {
    const { service, upserts, updates } = harness({
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
      expired: false,
    });
    expect(upserts[0]).not.toHaveProperty('status');
    expect(updates[0]).not.toHaveProperty('status');
  });

  it('does not copy an unrecognized response field into local lifecycle state', async () => {
    const { service, upserts, updates } = harness({
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
    await vi.waitFor(() => expect(upserts).toHaveLength(1));
    expect(upserts[0]).not.toHaveProperty('status');
    expect(updates[0]).not.toHaveProperty('status');
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
    // retained bindings keep the locally determined ARCHIVED lifecycle.
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
