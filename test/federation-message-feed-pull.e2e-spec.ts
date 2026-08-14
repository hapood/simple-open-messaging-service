import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { federatedPeer, federationPullCursor } from '../src/database/schema.js';
import {
  FederationMessageFeedPullService,
  type FederationMessageFeedPullCallbacks,
} from '../src/federation/federation-message-feed-pull.service.js';
import type { FederationMessageFeedPage } from '../src/federation/federation-message-feed.service.js';

describe('FederationMessageFeedPullService', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let service: FederationMessageFeedPullService;
  const peerDomain = 'pull-peer.test';

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [FederationMessageFeedPullService],
    }).compile();
    database = mod.get(DatabaseService);
    service = mod.get(FederationMessageFeedPullService);
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE "FederatedPeer" CASCADE');
    await database.db.insert(federatedPeer).values({
      domain: peerDomain,
      trustLevel: 'available',
    });
    // These tests exercise normal paging after the explicit no-after bootstrap has completed.
    await database.db
      .insert(federationPullCursor)
      .values({ peerDomain, initialized: true });
  });

  afterAll(async () => {
    await mod.close();
  });

  const page = (
    scannedThrough: bigint,
    feedIds: bigint[] = [],
    hasMore = false,
    messageFeedEndId = scannedThrough,
  ): FederationMessageFeedPage => ({
    items: feedIds.map((feedId) => ({
      feedId: feedId.toString(),
      thread: { type: 'P2P', participants: [] },
      messageEndSeq: feedId.toString(),
    })),
    scannedThrough: scannedThrough.toString(),
    messageFeedEndId: messageFeedEndId.toString(),
    hasMore,
  });

  it('stops at the final non-empty page without an acknowledgement request', async () => {
    const requested: Array<bigint | undefined> = [];
    const applied: string[][] = [];
    const callbacks: FederationMessageFeedPullCallbacks = {
      fetch: async (after) => {
        requested.push(after);
        if (after === 0n) return page(2n, [1n, 2n], true, 5n);
        if (after === 2n) return page(5n, [3n, 5n]);
        return page(5n);
      },
      apply: async (_tx, value) => {
        applied.push(value.items.map((item) => item.feedId));
      },
    };

    await service.run(peerDomain, callbacks);

    expect(requested).toEqual([0n, 2n]);
    expect(applied).toEqual([['1', '2'], ['3', '5']]);
    const cursor = await database.db.query.federationPullCursor.findFirst({
      where: eq(federationPullCursor.peerDomain, peerDomain),
    });
    expect(cursor).toMatchObject({ committedThrough: 5n });
  });

  it('observes a push arriving during the final request and continues', async () => {
    const requested: Array<bigint | undefined> = [];
    let pushed = false;
    let callbacks!: FederationMessageFeedPullCallbacks;
    callbacks = {
      fetch: async (after) => {
        requested.push(after);
        if (!pushed) {
          pushed = true;
          await service.advertise(peerDomain, 1n);
          void service.run(peerDomain, callbacks);
          return page(0n);
        }
        return after === 0n ? page(1n, [1n]) : page(1n);
      },
      apply: async () => undefined,
    };

    await service.run(peerDomain, callbacks);

    expect(requested).toEqual([0n, 0n]);
    const cursor = await database.db.query.federationPullCursor.findFirst({
      where: eq(federationPullCursor.peerDomain, peerDomain),
    });
    expect(cursor?.committedThrough).toBe(1n);
  });

  it('coalesces a burst of wake-ups and replays the highest HWM after the in-flight fetch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested: Array<bigint | undefined> = [];
    let activeFetches = 0;
    let maxActiveFetches = 0;
    let first = true;
    const callbacks: FederationMessageFeedPullCallbacks = {
      fetch: async (after) => {
        requested.push(after);
        activeFetches++;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        try {
          if (first) {
            first = false;
            await gate;
            return page(0n);
          }
          return page(100n);
        } finally {
          activeFetches--;
        }
      },
      apply: async () => undefined,
    };

    const initial = service.run(peerDomain, callbacks);
    await vi.waitFor(() => expect(requested).toEqual([0n]));
    const burst = Array.from({ length: 100 }, (_, index) => {
      service.advertise(peerDomain, BigInt(index + 1));
      return service.run(peerDomain, callbacks);
    });
    release();
    await Promise.all([initial, ...burst]);

    expect(maxActiveFetches).toBe(1);
    expect(requested).toEqual([0n, 0n]);
    const cursor = await database.db.query.federationPullCursor.findFirst({
      where: eq(federationPullCursor.peerDomain, peerDomain),
    });
    expect(cursor?.committedThrough).toBe(100n);
  });

  it('rolls back committedThrough when applying a page fails', async () => {
    await expect(
      service.run(peerDomain, {
        fetch: async () => page(1n, [1n]),
        apply: async () => {
          throw new Error('apply failed');
        },
      }),
    ).rejects.toThrow('apply failed');

    const cursor = await database.db.query.federationPullCursor.findFirst({
      where: eq(federationPullCursor.peerDomain, peerDomain),
    });
    expect(cursor?.committedThrough).toBe(0n);
  });
});
