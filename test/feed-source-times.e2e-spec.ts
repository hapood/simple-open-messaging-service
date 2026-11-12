import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federationFeedState,
  identityNamespace,
  profileNamespace,
  profileNamespaceFeed,
} from '../src/database/schema.js';
import { PeerStateFeedPullService } from '../src/federation/peer-state-feed-pull.service.js';
import { ProfileNamespaceFeedPullService } from '../src/federation/profile-namespace-feed-pull.service.js';
import { ProfileNamespaceFeedService } from '../src/federation/profile-namespace-feed.service.js';
import { ProfileNamespaceChangeStore } from '../src/federation/profile-namespace-change-store.service.js';
import { seedFederatedPeerNamespace } from './seed.js';

const effect = (namespaceId: number, feedId: string) => ({
  publisherNamespaceId: namespaceId,
  profileNamespaceId: 0,
  triggerFeedId: BigInt(feedId),
  expiredLocalRows: false,
  clientChangeId: 0n,
});

describe('persisted feed item source times', () => {
  let database: DatabaseService;
  beforeAll(() => {
    database = new DatabaseService();
  });
  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it.each(['state', 'namespace'] as const)(
    '%s commits item times, not head times, atomically with progress',
    async (kind) => {
      const domain = `source-time-${kind}.test`;
      const id = await seedFederatedPeerNamespace(database.db, domain);
      await database.db
        .update(federationFeedState)
        .set({ inboundStateFeedPulledThrough: 0n })
        .where(eq(federationFeedState.namespaceId, id));
      const state = new PeerStateFeedPullService(database);
      const namespace = new ProfileNamespaceFeedPullService(database);
      const read = () =>
        database.db.query.federationFeedState.findFirst({
          where: eq(federationFeedState.namespaceId, id),
        });
      const assertProgress = async (cursor: bigint, time: number) => {
        const row = (await read())!;
        expect(
          kind === 'state'
            ? row.inboundStateFeedPulledThrough
            : row.inboundProfileNamespaceFeedPulledThrough,
        ).toBe(cursor);
        expect(
          kind === 'state'
            ? row.stateFeedSourceGeneratedAt
            : row.profileNamespaceFeedSourceGeneratedAt,
        ).toBe(time);
      };
      const run = async (
        items: Array<{ feedId: string; generatedAt: number }>,
        end: string,
        fail = false,
      ) => {
        if (kind === 'state') {
          return state.run(domain, id, {
            fetch: async () => ({
              items: items.map((item) => ({
                ...item,
                account: '!group',
                eventType: 'THREAD_CONTENT_HEAD' as const,
                body: {},
              })),
              scannedThrough: end,
              stateFeedEndId: end,
              profileNamespaceFeedEndId: '0',
              hasMore: false,
            }),
            apply: async () => {
              if (fail) throw new Error('apply failed');
            },
          });
        }
        return namespace.run(domain, id, {
          fetch: async () => ({
            items: items.map((item) => ({ ...item, namespaceId: 1 })),
            scannedThrough: end,
            feedEndId: end,
            hasMore: false,
          }),
          apply: async (_tx, item) => {
            if (fail) throw new Error('apply failed');
            return effect(id, item.feedId);
          },
        });
      };
      await assertProgress(0n, 0);
      await run([{ feedId: '1', generatedAt: 2000 }], '3');
      await assertProgress(3n, 2000);
      await expect(
        run([{ feedId: '4', generatedAt: 3000 }], '5', true),
      ).rejects.toThrow('apply failed');
      await assertProgress(3n, 2000);
      // A source clock rollback is valid: the latest processed id owns the time.
      await run([{ feedId: '4', generatedAt: 1000 }], '5');
      await assertProgress(5n, 1000);
      await run([], '9');
      await run([], '9');
      await assertProgress(9n, 1000);
      await expect(
        run([{ feedId: '10', generatedAt: -1 }], '10'),
      ).rejects.toThrow();
      await assertProgress(9n, 1000);
    },
  );

  it('enforces non-null source times and safe millisecond bounds', async () => {
    const id = await seedFederatedPeerNamespace(
      database.db,
      'source-constraints.test',
    );
    const [cached] = await database.db
      .insert(profileNamespace)
      .values({ publisherNamespaceId: id, profileNamespaceId: 1 })
      .returning();
    expect(cached.sourceGeneratedAt).toBe(0);
    for (const [table, column, key] of [
      ['FederationFeedState', 'stateFeedSourceGeneratedAt', 'namespaceId'],
      [
        'FederationFeedState',
        'profileNamespaceFeedSourceGeneratedAt',
        'namespaceId',
      ],
      ['ProfileNamespace', 'sourceGeneratedAt', 'publisherNamespaceId'],
    ]) {
      for (const value of [null, -1, '9007199254740992']) {
        await expect(
          database.pool.query(
            `UPDATE "${table}" SET "${column}" = $1 WHERE "${key}" = $2`,
            [value, id],
          ),
        ).rejects.toMatchObject({ code: value === null ? '23502' : '23514' });
      }
    }
  });

  it('serves binding content, feed id and time from one snapshot during a concurrent change', async () => {
    const id = await seedFederatedPeerNamespace(
      database.db,
      'source-snapshot.test',
    );
    const changes = new ProfileNamespaceChangeStore(database);
    await database.db.transaction((tx) =>
      changes.recordNamespaceChangeInTx(tx, id),
    );
    await database.db
      .update(profileNamespaceFeed)
      .set({ updatedAt: new Date(1000) })
      .where(eq(profileNamespaceFeed.namespaceId, id));
    const before = (await database.db.query.profileNamespaceFeed.findFirst({
      where: eq(profileNamespaceFeed.namespaceId, id),
    }))!;
    let changed = false;
    // Pause after the reader establishes its snapshot, then commit a binding
    // mutation through a separate connection before the reader reads the data.
    const wrapped = {
      db: {
        transaction: (
          body: (tx: unknown) => Promise<unknown>,
          config: unknown,
        ) =>
          database.db.transaction(async (tx) => {
            await tx.select().from(profileNamespaceFeed).limit(1);
            await database.db.transaction(async (writer) => {
              await writer
                .update(identityNamespace)
                .set({ domain: 'source-renamed.test' })
                .where(eq(identityNamespace.id, id));
              await changes.recordNamespaceChangeInTx(writer, id);
            });
            changed = true;
            return body(tx);
          }, config as never),
      },
    };
    const feed = new ProfileNamespaceFeedService(wrapped as never, changes);
    const binding = await feed.resolveBindings(id);
    expect(changed).toBe(true);
    expect(binding).toMatchObject({
      domain: 'source-snapshot.test',
      generatedAt: 1000,
      profileNamespaceFeedEndId: before.feedId.toString(),
    });
    const current = await new ProfileNamespaceFeedService(
      database,
      changes,
    ).resolveBindings(id);
    expect(current.domain).toBe('source-renamed.test');
    expect(BigInt(current.profileNamespaceFeedEndId)).toBeGreaterThan(
      before.feedId,
    );
    expect(current.generatedAt).not.toBe(1000);
  });
});
