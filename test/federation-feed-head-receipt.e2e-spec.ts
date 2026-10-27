import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federationFeedHeadReceipt,
  federationFeedState,
  identityNamespace,
  peerStateFeed,
  profileNamespaceFeed,
} from '../src/database/schema.js';
import { FederationFeedHeadReceiptService } from '../src/federation/federation-feed-head-receipt.service.js';
import { FederationStateFeedHeadClient } from '../src/federation/federation-state-feed-head-client.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { ProfileNamespaceChangeStore } from '../src/federation/profile-namespace-change-store.service.js';

describe('federation feed state and received observations', () => {
  let database: DatabaseService;
  let namespaceId: number;
  beforeAll(async () => {
    database = new DatabaseService();
    const [peer] = await database.db
      .insert(identityNamespace)
      .values({
        signingKeyCreatedAt: 1700000000000,
        domain: 'feed-receipt.test',
        rootPublicKey: Buffer.alloc(32, 77).toString('base64'),
        identityPinnedAt: new Date(),
        active: true,
      })
      .returning();
    namespaceId = peer.id;
  });

  it('initializes independent state and preserves the initial bootstrap marker', async () => {
    const state = await database.db.query.federationFeedState.findFirst({
      where: eq(federationFeedState.namespaceId, namespaceId),
    });
    expect(state).toMatchObject({
      outboundStateFeedEndId: 0n,
      inboundStateFeedPulledThrough: null,
      inboundProfileNamespaceFeedPulledThrough: 0n,
    });
    expect(state!.createdAt).toBeInstanceOf(Date);
    expect(state!.updatedAt).toBeInstanceOf(Date);
  });

  it('records whole reordered snapshots without changing synchronization coordinates', async () => {
    const receipts = new FederationFeedHeadReceiptService(database);
    const initial = {
      stateFeedEndId: '999999999999999999999999',
      profileNamespaceFeedEndId: '9',
      generatedAt: 2000,
      sentAt: 1000,
    };
    await receipts.record(namespaceId, initial);
    const first =
      (await database.db.query.federationFeedHeadReceipt.findFirst())!;
    const next = {
      stateFeedEndId: '2',
      profileNamespaceFeedEndId: '3',
      generatedAt: 500,
      sentAt: 600,
    };
    await receipts.record(namespaceId, next);
    const last =
      (await database.db.query.federationFeedHeadReceipt.findFirst())!;
    expect(last).toMatchObject(next);
    expect(last.createdAt).toEqual(first.createdAt);
    expect(last.updatedAt).toEqual(last.receivedAt);
    const state = (await database.db.query.federationFeedState.findFirst())!;
    expect(state.outboundStateFeedEndId).toBe(0n);
    expect(state.inboundStateFeedPulledThrough).toBeNull();
  });

  it('serializes simultaneous observations without mixing fields', async () => {
    const receipts = new FederationFeedHeadReceiptService(database);
    const snapshots = Array.from({ length: 8 }, (_, i) => ({
      stateFeedEndId: String(i),
      profileNamespaceFeedEndId: String(i + 10),
      generatedAt: i,
      sentAt: i + 100,
    }));
    await Promise.all(
      snapshots.map((snapshot) => receipts.record(namespaceId, snapshot)),
    );
    const row =
      (await database.db.query.federationFeedHeadReceipt.findFirst())!;
    expect(row.profileNamespaceFeedEndId).toBe(
      String(Number(row.stateFeedEndId) + 10),
    );
    expect(row.sentAt).toBe(row.generatedAt + 100);
  });

  it('uses persisted serving timestamps rather than send time or identity updates', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = new FederationStateFeedHeadClient(
      { capturePeerResponseToken: async () => ({ namespaceId }) } as never,
      database,
      {
        post: async (_path: string, body: string) => {
          bodies.push(JSON.parse(body));
        },
      } as never,
    );
    await client.send('feed-receipt.test');
    expect(bodies.at(-1)).toEqual({
      stateFeedEndId: '0',
      profileNamespaceFeedEndId: '0',
      generatedAt: 0,
    });
    await database.db.transaction(async (tx) => {
      await new PeerStateFeedService(database).writeManyInTx(tx, [
        {
          namespaceId,
          account: 'alice',
          subjectAccount: 'bob',
          subjectNamespaceId: namespaceId,
          eventType: 'RELATIONSHIP_INTENT',
          body: { status: 'REVOKED', namespaceId: 0, profileRev: 0 },
        },
      ]);
      await new ProfileNamespaceChangeStore(database).recordNamespaceChangeInTx(
        tx,
        namespaceId,
      );
      await tx.update(peerStateFeed).set({ updatedAt: new Date(1000) });
      await tx.update(profileNamespaceFeed).set({ updatedAt: new Date(2000) });
    });
    await client.send('feed-receipt.test');
    expect(bodies.at(-1)).toEqual({
      stateFeedEndId: '1',
      profileNamespaceFeedEndId: '1',
      generatedAt: 2000,
    });
    await database.db
      .update(identityNamespace)
      .set({ updatedAt: new Date(9000) })
      .where(eq(identityNamespace.id, namespaceId));
    await client.send('feed-receipt.test');
    expect(bodies.at(-1)).toEqual(bodies.at(-2));
  });

  it('rolls back allocator changes with the feed publication', async () => {
    const before = await database.db.query.federationFeedState.findFirst();
    await expect(
      database.db.transaction(async (tx) => {
        await tx
          .update(federationFeedState)
          .set({
            outboundStateFeedEndId: sql`${federationFeedState.outboundStateFeedEndId} + 1`,
          })
          .where(eq(federationFeedState.namespaceId, namespaceId));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      (await database.db.query.federationFeedState.findFirst())!
        .outboundStateFeedEndId,
    ).toBe(before!.outboundStateFeedEndId);
  });

  it('serializes concurrent outbound allocations without blocking foreign-key readers', async () => {
    const feed = new PeerStateFeedService(database);
    let unlock!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const holder = database.db.transaction(async (tx) => {
      await feed.lockOutboundStateFeedNamespacesInTx(tx, [{ namespaceId }]);
      locked();
      await gate;
    });
    await acquired;
    try {
      await database.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await tx.execute(
          sql`SELECT id FROM "IdentityNamespace" WHERE id = ${namespaceId} FOR KEY SHARE`,
        );
      });
    } finally {
      unlock();
      await holder;
    }
    const before = await feed.readFeedEndId(namespaceId);
    const allocations = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        database.db.transaction((tx) =>
          feed.writeManyInTx(tx, [
            {
              namespaceId,
              account: `concurrent${i}`,
              subjectAccount: 'bob',
              subjectNamespaceId: namespaceId,
              eventType: 'RELATIONSHIP_INTENT',
              body: { status: 'REVOKED', namespaceId: 0, profileRev: 0 },
            },
          ]),
        ),
      ),
    );
    expect(
      new Set(allocations.map((result) => result.get(namespaceId))).size,
    ).toBe(6);
    expect(await feed.readFeedEndId(namespaceId)).toBe(before + 6n);
  });

  it('creates only the final feed layout without identity-owned coordinates', async () => {
    const obsolete = await database.db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'IdentityNamespace'
      AND column_name IN ('stateFeedEndId', 'stateFeedPulledThrough', 'profileNamespaceFeedEndId', 'profileNamespaceFeedPulledThrough')
    `);
    expect(obsolete.rows).toEqual([]);
    const migrations = await database.db.execute(
      sql`SELECT version FROM schema_migrations ORDER BY version`,
    );
    expect(migrations.rows).toEqual([{ version: '0000_base' }]);
  });

  it('rejects invalid timestamps at the persistence boundary', async () => {
    await expect(
      database.db.update(federationFeedHeadReceipt).set({ sentAt: -1 }),
    ).rejects.toThrow();
  });
});
