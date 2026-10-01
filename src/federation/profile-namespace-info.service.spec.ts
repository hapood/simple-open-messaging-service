import { describe, expect, it, vi } from 'vitest';
import { ProfileNamespaceInfoService } from './profile-namespace-info.service.js';

interface InsertValues {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  domain: string | null;
  rootPublicKey: string | null;
  updateFeedId: bigint;
  expired: boolean;
}

function harness(options?: {
  cacheRows?: Array<Record<string, unknown>>;
  directRow?: Record<string, unknown> | null;
  bindings?: Array<Record<string, unknown>>;
  /** Parks the first peer fetch until the promise resolves (lets a test
   *  deliver a second trigger while a refresh is in flight). */
  parkFirstGet?: Promise<unknown>;
}) {
  const upserts: InsertValues[] = [];
  let selectCalls = 0;
  const selectPlan = [
    // resolveBatch direct row / refresh publisher row / refresh direct row
    () => (options?.directRow === undefined ? [] : [options.directRow]),
    () => (options?.directRow === undefined ? [] : [options.directRow]),
    () => (options?.directRow === undefined ? [] : [options.directRow]),
  ];
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          const plan = selectPlan[Math.min(selectCalls, 2)]();
          selectCalls += 1;
          return plan;
        },
      }),
    }),
  }));
  const insert = vi.fn(() => ({
    values: (value: InsertValues) => ({
      // drizzle builders chain synchronously; only the terminal call awaits.
      onConflictDoNothing: () => ({
        returning: async () => [{ ...value }],
      }),
      onConflictDoUpdate: () => {
        upserts.push(value);
        return Promise.resolve(undefined);
      },
    }),
  }));
  const execute = vi.fn(async () => ({
    rows: options?.cacheRows ?? [],
  }));
  const database = { db: { select, insert, execute } };
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
  const service = new ProfileNamespaceInfoService(
    database as never,
    peerHttp as never,
    trustedPeers as never,
    threadAccess as never,
  );
  return { service, execute, insert, select, peerHttp, upserts };
}

describe('ProfileNamespaceInfoService.resolveBatch', () => {
  it('answers direct rows synchronously from the authoritative namespace row', async () => {
    const { service, execute } = harness({
      directRow: {
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        retiredAt: null,
        pulledThrough: 4n,
      },
    });
    await expect(
      service.resolveBatch([
        { publisherNamespaceId: 12, profileNamespaceId: 0 },
      ]),
    ).resolves.toEqual([
      {
        publisherNamespaceId: 12,
        profileNamespaceId: 0,
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        updateFeedId: 4,
        expired: false,
      },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers cached rows and schedules refreshes only for expired entries', async () => {
    const { service } = harness({
      cacheRows: [
        {
          publisherNamespaceId: 12,
          profileNamespaceId: 5,
          domain: 'c.test',
          rootPublicKey: 'c'.repeat(44),
          updateFeedId: 3n,
          expired: false,
        },
        {
          publisherNamespaceId: 12,
          profileNamespaceId: 6,
          domain: null,
          rootPublicKey: null,
          updateFeedId: 2n,
          expired: true,
        },
      ],
      directRow: null,
    });
    const entries = await service.resolveBatch([
      { publisherNamespaceId: 12, profileNamespaceId: 5 },
      { publisherNamespaceId: 12, profileNamespaceId: 6 },
    ]);
    expect(entries).toEqual([
      {
        publisherNamespaceId: 12,
        profileNamespaceId: 5,
        domain: 'c.test',
        rootPublicKey: 'c'.repeat(44),
        updateFeedId: 3,
        expired: false,
      },
      {
        publisherNamespaceId: 12,
        profileNamespaceId: 6,
        domain: null,
        rootPublicKey: null,
        updateFeedId: 2,
        expired: true,
      },
    ]);
  });

  it('demand-fills unknown third-party pairs with visible tombs', async () => {
    const { service, insert } = harness({ cacheRows: [], directRow: null });
    const entries = await service.resolveBatch([
      { publisherNamespaceId: 12, profileNamespaceId: 9 },
    ]);
    expect(entries).toEqual([
      {
        publisherNamespaceId: 12,
        profileNamespaceId: 9,
        domain: null,
        rootPublicKey: null,
        updateFeedId: 0,
        expired: true,
      },
    ]);
    expect(insert).toHaveBeenCalledOnce();
  });
});

describe('ProfileNamespaceInfoService stale-response guard', () => {
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

describe('ProfileNamespaceInfoService.scheduleRefresh coalescing', () => {
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
