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
}) {
  let selectCalls = 0;
  const selectPlan = [
    // resolveBatch direct-row lookups
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
        return Promise.resolve(undefined);
      },
    }),
  }));
  const execute = vi.fn(async () => ({
    rows: options?.cacheRows ?? [],
  }));
  const database = { db: { select, insert, execute } };
  const service = new ProfileNamespaceInfoService(database as never);
  return { service, execute, insert, select };
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
    const { entries, pendingRefreshes } = await service.resolveBatch([
      { publisherNamespaceId: 12, profileNamespaceId: 0 },
    ]);
    expect(entries).toEqual([
      {
        publisherNamespaceId: 12,
        profileNamespaceId: 0,
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        updateFeedId: 4,
        expired: false,
      },
    ]);
    expect(pendingRefreshes).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers cached rows and reports refreshes only for expired entries', async () => {
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
    const { entries, pendingRefreshes } = await service.resolveBatch([
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
    expect(pendingRefreshes).toEqual([
      {
        pair: { publisherNamespaceId: 12, profileNamespaceId: 6 },
        triggerFeedId: 2n,
      },
    ]);
  });

  it('demand-fills unknown third-party pairs with visible tombs', async () => {
    const { service, insert } = harness({ cacheRows: [], directRow: null });
    const { entries, pendingRefreshes } = await service.resolveBatch([
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
    expect(pendingRefreshes).toEqual([
      {
        pair: { publisherNamespaceId: 12, profileNamespaceId: 9 },
        triggerFeedId: 0n,
      },
    ]);
    expect(insert).toHaveBeenCalledOnce();
  });
});
