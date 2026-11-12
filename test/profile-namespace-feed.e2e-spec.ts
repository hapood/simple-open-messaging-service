import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import { identityNamespace, profileNamespace } from '../src/database/schema.js';
import { ProfileNamespaceFeedService } from '../src/federation/profile-namespace-feed.service.js';
import { ProfileNamespaceChangeStore } from '../src/federation/profile-namespace-change-store.service.js';
import { ProfileNamespaceFeedConsumerService } from '../src/federation/profile-namespace-feed-consumer.service.js';

/**
 * Integration test for the Profile Namespace Feed convergence loop against a
 * real PostgreSQL database (migrated baseline). The unit specs mock the
 * drizzle surface; this spec exercises the actual tables, constraints, and
 * the row-0 allocator / single-row head that drive cursor semantics.
 *
 * Scope:
 *  - Consumer side: `applyItemInTx` expires a cached binding row and records
 *    a client changelog entry; `serveClientChanges` returns the merged,
 *    compacted changes with correct cursor/pagination.
 *  - Publisher side: `recordNamespaceChangeInTx` allocates a feed position
 *    from the row-0 sentinel and upserts the compacted s2s item; `serve`
 *    returns it.
 */
describe('profile namespace feed convergence', () => {
  const PUBLISHER_DOMAIN = 'pns-feed-publisher.test';
  let database: DatabaseService;
  let feed: ProfileNamespaceFeedService;
  let consumer: ProfileNamespaceFeedConsumerService;
  let publisherId: number;

  beforeAll(async () => {
    database = new DatabaseService();
    feed = new ProfileNamespaceFeedService(
      database,
      new ProfileNamespaceChangeStore(database),
    );
    consumer = new ProfileNamespaceFeedConsumerService(feed);

    const [publisher] = await database.db
      .insert(identityNamespace)
      .values({
        signingKeyCreatedAt: 1700000000000,
        domain: PUBLISHER_DOMAIN,
        rootPublicKey: Buffer.alloc(32, 9).toString('base64'),
        identityPinnedAt: new Date(),
        active: true,
        trustLevel: 'available',
        localServiceAvailable: true,
        peerAcceptanceConfirmed: true,
        remoteServiceReachable: true,
      })
      .returning({ id: identityNamespace.id });
    publisherId = publisher.id;

    // Seed a cached third-party binding that is current (not expired) so the
    // consumer can expire it.
    await database.db.insert(profileNamespace).values({
      publisherNamespaceId: publisherId,
      profileNamespaceId: 5,
      domain: 'third-party.test',
      rootPublicKey: Buffer.alloc(32, 5).toString('base64'),
      updateFeedId: 3n,
      expired: false,
    });
  });

  // resetE2EWorkerDatabase truncates every table and deletes non-sentinel
  // IdentityNamespace rows before the next spec, so no manual cleanup is
  // needed here.

  describe('consumer side: cache expiry + client changelog', () => {
    it('expires the matching cache row and records a client change', async () => {
      await database.db.transaction(async (tx) => {
        await consumer.applyItemInTx(tx, publisherId, {
          namespaceId: 5,
          feedId: 10n,
        });
      });

      const [cacheRow] = await database.db
        .select()
        .from(profileNamespace)
        .where(eq(profileNamespace.profileNamespaceId, 5));
      expect(cacheRow.expired).toBe(true);
      // The consumer does not touch updateFeedId; it only flips expired. The
      // refresh step (out of scope here) would advance updateFeedId later.
      expect(cacheRow.updateFeedId).toBe(3n);
    });

    it('serves the recorded change from the client changelog', async () => {
      const page = await feed.serveClientChanges();
      expect(page.endId).toBe(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        publisherNamespaceId: publisherId,
        profileNamespaceId: 5,
        changeId: 1,
      });
      expect(page.scannedThrough).toBe(1);
      expect(page.hasMore).toBe(false);
    });

    it('records a second change for a different namespace and serves both ordered', async () => {
      await database.db.transaction(async (tx) => {
        await consumer.applyItemInTx(tx, publisherId, {
          namespaceId: 6,
          feedId: 20n,
        });
      });

      const page = await feed.serveClientChanges();
      expect(page.endId).toBe(2);
      expect(page.items.map((item) => item.changeId)).toEqual([1, 2]);
      expect(page.items[1]).toMatchObject({ profileNamespaceId: 6 });
    });

    it('paginates with an after cursor', async () => {
      const page = await feed.serveClientChanges(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].changeId).toBe(2);
      expect(page.scannedThrough).toBe(2);
    });

    it('returns an empty page when the cursor is at the head', async () => {
      const page = await feed.serveClientChanges(2);
      expect(page.items).toEqual([]);
      expect(page.endId).toBe(2);
      expect(page.scannedThrough).toBe(2);
      expect(page.hasMore).toBe(false);
    });

    it('compacts a repeated namespace pair to its latest changeId', async () => {
      // A second mutation of namespace 5 allocates changeId 3 and upserts the
      // pair's row; the changelog keeps only the newest changeId per pair.
      await database.db.transaction(async (tx) => {
        await consumer.applyItemInTx(tx, publisherId, {
          namespaceId: 5,
          feedId: 30n,
        });
      });
      const page = await feed.serveClientChanges();
      const ns5 = page.items.find((item) => item.profileNamespaceId === 5);
      expect(ns5?.changeId).toBe(3);
      // Only two distinct pairs remain: (publisherId, 5) and (publisherId, 6).
      expect(page.items).toHaveLength(2);
    });
  });

  describe('publisher side: s2s compacted feed', () => {
    it('allocates a feed position and serves the compacted item', async () => {
      let feedId: bigint;
      await database.db.transaction(async (tx) => {
        feedId = await feed.recordNamespaceChangeInTx(tx, publisherId);
      });
      expect(feedId!).toBe(1n);

      const page = await feed.serve();
      expect(page.feedEndId).toBe('1');
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toEqual({
        namespaceId: publisherId,
        feedId: '1',
        generatedAt: expect.any(Number),
      });
      expect(page.scannedThrough).toBe('1');
      expect(page.hasMore).toBe(false);
    });

    it('upserts a repeated namespace at a greater feedId', async () => {
      await database.db.transaction(async (tx) => {
        await feed.recordNamespaceChangeInTx(tx, publisherId);
      });
      const page = await feed.serve();
      expect(page.feedEndId).toBe('2');
      // The compacted feed retains one item per namespace id.
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toEqual({
        namespaceId: publisherId,
        feedId: '2',
        generatedAt: expect.any(Number),
      });
    });
  });
});
