import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileNamespaceService } from './profile-namespace.service.js';
import { identityNamespace, profileNamespace } from '../database/schema.js';

interface InsertValues {
  publisherNamespaceId: number;
  profileNamespaceId: number;
  domain: string | null;
  rootPublicKey: string | null;
  updateFeedId: bigint;
  expired: boolean;
  status: string;
}

const ROOT_KEY = 'k'.repeat(44);
const FEED_END = 7n;

function harness(options?: {
  cacheRow?: Record<string, unknown> | null;
  /** Registry rows answered for identityNamespace selects after the
   *  row-0 feed-end lookup, in call order. */
  registryRows?: Array<Record<string, unknown> | null>;
}) {
  // The service selects by table: identityNamespace serves the row-0
  // feed-end head first and then the registry row for the profile nsid;
  // profileNamespace serves the third-party cache lookup.
  const identityReads: Array<Record<string, unknown> | null> = [
    { feedEndId: FEED_END },
    ...(options?.registryRows ?? []),
  ];
  const select = vi.fn(() => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          if (table === identityNamespace)
            return [identityReads.shift() ?? null];
          if (table === profileNamespace)
            return options?.cacheRow === undefined ? [] : [options.cacheRow];
          throw new Error('unexpected table in select');
        },
      }),
    }),
  }));
  const insert = vi.fn(() => ({
    values: (value: InsertValues) => ({
      onConflictDoNothing: () => ({
        returning: async () => [{ ...value }],
      }),
      onConflictDoUpdate: () => Promise.resolve(undefined),
    }),
  }));
  const database = {
    db: {
      select,
      insert,
      query: {
        identityNamespace: {
          findFirst: vi.fn().mockResolvedValue({ domain: 'soms.test' }),
        },
      },
    },
  };
  const keypair = { getRootPublicKeyB64: () => ROOT_KEY };
  const service = new ProfileNamespaceService(
    database as never,
    keypair as never,
  );
  return { service, insert, select };
}

describe('ProfileNamespaceService.resolveOne', () => {
  beforeEach(() => {
    process.env.SOMS_DOMAIN = 'soms.test';
  });
  afterEach(() => {
    delete process.env.SOMS_DOMAIN;
  });

  it('answers (0, 0) from the keypair snapshot with the real domain, never the local sentinel', async () => {
    const { service, insert } = harness();
    const result = await service.resolveOne({
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
    });
    expect(result).toEqual({
      status: 'READY',
      entry: {
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        domain: 'soms.test',
        rootPublicKey: ROOT_KEY,
        updateFeedId: 7,
        expired: false,
        status: 'ACTIVE',
      },
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('answers (0, nsid) from the authoritative IdentityNamespace registry with the local feed end', async () => {
    const { service, insert } = harness({
      registryRows: [
        {
          domain: 'peer.test',
          rootPublicKey: 'r'.repeat(44),
          retiredAt: null,
          active: true,
        },
      ],
    });
    const result = await service.resolveOne({
      publisherNamespaceId: 0,
      profileNamespaceId: 12,
    });
    expect(result).toEqual({
      status: 'READY',
      entry: {
        publisherNamespaceId: 0,
        profileNamespaceId: 12,
        domain: 'peer.test',
        rootPublicKey: 'r'.repeat(44),
        updateFeedId: 7,
        expired: false,
        status: 'ACTIVE',
      },
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('marks a (0, nsid) row ARCHIVED and expired when the registry row is retired', async () => {
    const { service } = harness({
      registryRows: [
        {
          domain: 'peer.test',
          rootPublicKey: 'r'.repeat(44),
          retiredAt: new Date(),
          active: false,
        },
      ],
    });
    const result = await service.resolveOne({
      publisherNamespaceId: 0,
      profileNamespaceId: 12,
    });
    expect(result.status).toBe('READY');
    if (result.status === 'READY') {
      expect(result.entry.status).toBe('ARCHIVED');
      expect(result.entry.expired).toBe(true);
      expect(result.entry.domain).toBeNull();
    }
  });

  it('answers (publisher, 0) READY from the seeded cache row — the feed-converged self-binding', async () => {
    const { service, insert } = harness({
      cacheRow: {
        publisherNamespaceId: 12,
        profileNamespaceId: 0,
        domain: 'c.test',
        rootPublicKey: 'c'.repeat(44),
        updateFeedId: 3n,
        expired: false,
        status: 'ACTIVE',
      },
    });
    const result = await service.resolveOne({
      publisherNamespaceId: 12,
      profileNamespaceId: 0,
    });
    expect(result).toEqual({
      status: 'READY',
      entry: {
        publisherNamespaceId: 12,
        profileNamespaceId: 0,
        domain: 'c.test',
        rootPublicKey: 'c'.repeat(44),
        updateFeedId: 3,
        expired: false,
        status: 'ACTIVE',
      },
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('answers (publisher, 0) PENDING and plants a tomb when the cache row is absent', async () => {
    const { service, insert } = harness({ cacheRow: null });
    const result = await service.resolveOne({
      publisherNamespaceId: 12,
      profileNamespaceId: 0,
    });
    expect(result).toEqual({ status: 'PENDING' });
    expect(insert).toHaveBeenCalledOnce();
  });

  it('answers READY with the cached row (including status) when present', async () => {
    const { service, insert } = harness({
      cacheRow: {
        publisherNamespaceId: 12,
        profileNamespaceId: 5,
        domain: 'c.test',
        rootPublicKey: 'c'.repeat(44),
        updateFeedId: 3n,
        expired: false,
        status: 'ACTIVE',
      },
    });
    const result = await service.resolveOne({
      publisherNamespaceId: 12,
      profileNamespaceId: 5,
    });
    expect(result).toEqual({
      status: 'READY',
      entry: {
        publisherNamespaceId: 12,
        profileNamespaceId: 5,
        domain: 'c.test',
        rootPublicKey: 'c'.repeat(44),
        updateFeedId: 3,
        expired: false,
        status: 'ACTIVE',
      },
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('answers PENDING and plants a tomb for an unknown third-party pair', async () => {
    const { service, insert } = harness({ cacheRow: null });
    const result = await service.resolveOne({
      publisherNamespaceId: 12,
      profileNamespaceId: 9,
    });
    expect(result).toEqual({ status: 'PENDING' });
    expect(insert).toHaveBeenCalledOnce();
  });

  it('answers READY with an expired cached placeholder (no re-insert)', async () => {
    const { service, insert } = harness({
      cacheRow: {
        publisherNamespaceId: 12,
        profileNamespaceId: 6,
        domain: null,
        rootPublicKey: null,
        updateFeedId: 2n,
        expired: true,
        status: 'ACTIVE',
      },
    });
    const result = await service.resolveOne({
      publisherNamespaceId: 12,
      profileNamespaceId: 6,
    });
    expect(result.status).toBe('READY');
    if (result.status === 'READY') {
      expect(result.entry.expired).toBe(true);
      expect(result.entry.updateFeedId).toBe(2);
    }
    expect(insert).not.toHaveBeenCalled();
  });
});
