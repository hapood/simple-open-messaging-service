import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileNamespaceFeedService } from './profile-namespace-feed.service.js';
import { ProfileNamespaceChangeStore } from './profile-namespace-change-store.service.js';
import { BusinessCode } from '../common/business-code.js';

const ROOT = Buffer.alloc(32, 7).toString('base64');

interface Harness {
  service: ProfileNamespaceFeedService;
  reads: Array<Record<string, unknown>[]>;
  setReturning: ReturnType<typeof vi.fn>;
  upsertValues: unknown[];
}

/**
 * The drizzle query-builder surface used by the service, in call order:
 * `select` first serves the row-0 head lookup, then the feed page or the
 * bindings row. `update`/`insert` back the write path.
 */
function harness(selectResults: Array<Record<string, unknown>[]>): Harness {
  const reads: Array<Record<string, unknown>[]> = [];
  const upsertValues: unknown[] = [];
  let selectCalls = 0;
  const selectChain = (rows: () => Record<string, unknown>[]) => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: async () => rows(),
        }),
        limit: async () => rows(),
      }),
    }),
  });
  const select = vi.fn(() => {
    const rows = selectResults[selectCalls] ?? [];
    selectCalls += 1;
    reads.push(rows);
    return selectChain(() => rows);
  });
  const setReturning = vi.fn(async () => [{ feedId: 5n }]);
  const txLike = {
    select,
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({ returning: setReturning }),
      }),
    })),
    insert: vi.fn(() => ({
      values: (value: unknown) => {
        upsertValues.push(value);
        return { onConflictDoUpdate: async () => undefined };
      },
    })),
  };
  const database = {
    db: {
      select,
      query: {
        identityNamespace: {
          findFirst: vi.fn().mockResolvedValue({ domain: 'soms.test' }),
        },
      },
      transaction: vi.fn(
        async (fn: (value: typeof txLike) => Promise<unknown>) => fn(txLike),
      ),
    },
  };
  const keypair = { getRootPublicKeyB64: () => ROOT };
  const changes = new ProfileNamespaceChangeStore(database as never);
  return {
    service: new ProfileNamespaceFeedService(
      database as never,
      keypair as never,
      changes,
    ),
    reads,
    setReturning,
    upsertValues,
  };
}

describe('ProfileNamespaceFeedService', () => {
  beforeEach(() => {
    process.env.SOMS_DOMAIN = 'soms.test';
  });
  afterEach(() => {
    delete process.env.SOMS_DOMAIN;
  });

  it('allocates from the row-0 allocator and upserts the nsid item in one transaction', async () => {
    const { service, setReturning, upsertValues } = harness([]);
    const tx = {
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({ returning: setReturning }),
        }),
      })),
      insert: vi.fn(() => ({
        values: (value: unknown) => {
          upsertValues.push(value);
          return { onConflictDoUpdate: async () => undefined };
        },
      })),
    };
    await expect(
      service.recordNamespaceChangeInTx(tx as never, 12),
    ).resolves.toBe(5n);
    expect(upsertValues).toEqual([{ namespaceId: 12, feedId: 5n }]);
  });

  it('rejects a negative or fractional namespace id', async () => {
    const { service } = harness([]);
    await expect(
      service.recordNamespaceChangeInTx({} as never, -1),
    ).rejects.toThrow('non-negative safe integer');
    await expect(
      service.recordNamespaceChangeInTx({} as never, 1.5),
    ).rejects.toThrow('non-negative safe integer');
  });

  it('reads the publisher-wide feed end from the sentinel row', async () => {
    const { service } = harness([[{ feedEndId: 9n }]]);
    await expect(service.readFeedEndId()).resolves.toBe(9n);
  });

  it('fails loudly when the sentinel row is missing', async () => {
    const { service } = harness([[]]);
    await expect(service.readFeedEndId()).rejects.toThrow(
      'local namespace sentinel row is missing',
    );
  });

  it('serves every compacted item from 0 when after is omitted', async () => {
    const { service } = harness([
      [{ feedEndId: 3n }],
      [
        { namespaceId: 1, feedId: 1n },
        { namespaceId: 2, feedId: 3n },
      ],
    ]);
    await expect(service.serve()).resolves.toEqual({
      items: [
        { namespaceId: 1, feedId: '1' },
        { namespaceId: 2, feedId: '3' },
      ],
      scannedThrough: '3',
      feedEndId: '3',
      hasMore: false,
    });
  });

  it('bounds pages by take and reports hasMore with the exact scan frontier', async () => {
    const { service } = harness([
      [{ feedEndId: 9n }],
      [
        { namespaceId: 1, feedId: 2n },
        { namespaceId: 2, feedId: 4n },
        { namespaceId: 3, feedId: 6n },
      ],
    ]);
    await expect(service.serve(1n, 2)).resolves.toEqual({
      items: [
        { namespaceId: 1, feedId: '2' },
        { namespaceId: 2, feedId: '4' },
      ],
      scannedThrough: '4',
      feedEndId: '9',
      hasMore: true,
    });
  });

  it('treats an after beyond the feed end as malformed', async () => {
    const { service } = harness([[{ feedEndId: 3n }]]);
    await expect(service.serve(4n)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
  });

  it('rejects through below after and an out-of-range take', async () => {
    const { service } = harness([[{ feedEndId: 3n }]]);
    await expect(service.serve(2n, undefined, 1n)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
    await expect(service.serve(0n, 0)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
    await expect(service.serve(0n, 201)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
  });

  it('answers nsid 0 from local authority', async () => {
    const { service } = harness([[{ feedEndId: 7n }]]);
    await expect(service.resolveBindings(0)).resolves.toEqual({
      domain: 'soms.test',
      rootPublicKey: ROOT,
      status: 'ACTIVE',
      profileNamespaceFeedEndId: '7',
    });
  });

  it('answers a bound positive nsid and reports never-handshaked ids as NOT_FOUND business outcomes', async () => {
    const { service } = harness([
      [{ feedEndId: 7n }],
      [
        {
          domain: 'peer.test',
          rootPublicKey: ROOT,
          retiredAt: null,
          active: true,
        },
      ],
    ]);
    await expect(service.resolveBindings(12)).resolves.toEqual({
      domain: 'peer.test',
      rootPublicKey: ROOT,
      status: 'ACTIVE',
      profileNamespaceFeedEndId: '7',
    });

    // A reset-retired id keeps answering with its last retained bindings so
    // historical references stay renderable — disclosed as ARCHIVED so the
    // puller caches the lifecycle instead of assuming ACTIVE.
    const retired = harness([
      [{ feedEndId: 7n }],
      [
        {
          domain: 'peer.test',
          rootPublicKey: ROOT,
          retiredAt: new Date(),
          active: false,
        },
      ],
    ]);
    await expect(retired.service.resolveBindings(12)).resolves.toMatchObject({
      domain: 'peer.test',
      rootPublicKey: ROOT,
      status: 'ARCHIVED',
    });

    const missing = harness([[{ feedEndId: 7n }], []]);
    await expect(missing.service.resolveBindings(12)).rejects.toMatchObject({
      bizCode: BusinessCode.NOT_FOUND,
      status: 200,
    });
  });
});
