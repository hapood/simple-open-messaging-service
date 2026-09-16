import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageThreadType } from '../src/database/enums.js';
import {
  deletedMessage,
  groupAccount,
  message,
  threadAudience,
  federatedPeer,
  identityNamespace,
  messageThread,
  relationshipIntent,
  relationshipPair,
  peerStateFeed,
  account as user,
} from '../src/database/schema.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { RelationshipIntentService } from '../src/relationship/business/relationship-intent.service.js';

const DOMAINS = ['state-feed-a.test', 'state-feed-b.test'];

describe('per-peer state feed', () => {
  const wireTime = new Date('2026-08-09T00:00:00.123Z');
  let mod: TestingModule;
  let database: DatabaseService;
  let feed: PeerStateFeedService;
  const namespaceIds = new Map<string, number>();

  async function seedPeer(domain: string): Promise<number> {
    const [namespace] = await database.db
      .insert(identityNamespace)
      .values({
        domain,
        rootKeyFingerprint: `sha256:${domain}`,
        rootPublicKey: Buffer.alloc(32, domain.length).toString('base64'),
        identityPinnedAt: new Date(),
      })
      .returning({ id: identityNamespace.id });
    await database.db.insert(federatedPeer).values({
      domain,
      activeNamespaceId: namespace.id,
      trustLevel: 'available',
    });
    namespaceIds.set(domain, namespace.id);
    return namespace.id;
  }

  function namespaceId(domain: string): number {
    const value = namespaceIds.get(domain);
    if (value === undefined)
      throw new Error(`missing test namespace for ${domain}`);
    return value;
  }

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [PeerStateFeedService, RelationshipIntentService],
    }).compile();
    database = mod.get(DatabaseService);
    feed = mod.get(PeerStateFeedService);
    for (const domain of DOMAINS) await seedPeer(domain);
  });

  afterAll(async () => {
    await database.db
      .delete(federatedPeer)
      .where(eq(federatedPeer.domain, DOMAINS[0]));
    await database.db
      .delete(federatedPeer)
      .where(eq(federatedPeer.domain, DOMAINS[1]));
    await mod.close();
  });

  it('indexes Group Meta and content as one complete thread head', async () => {
    const peerDomain = 'fresh-snapshot.test';
    await seedPeer(peerDomain);
    const account = '!fresh-snapshot';
    const [group] = await database.db
      .insert(groupAccount)
      .values({ account })
      .returning();
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: MessageThreadType.GROUP,
        groupAccount: account,
        groupAccountId: group.id,
        updatedAt: new Date(),
        groupDomain: 'local',
        authorityNamespaceId: 0,
      })
      .returning();
    await database.db.insert(threadAudience).values({
      threadId: thread.id,
      targetDomain: peerDomain,
      targetNamespaceId: namespaceId(peerDomain),
    });
    const key = {
      peerDomain: peerDomain,
      namespaceId: namespaceId(peerDomain),
      account,
      domain: 'local.test',
      subjectAccount: '',
      subjectDomain: 'local',
    };
    await database.db.transaction(async (tx) => {
      await feed.writeManyInTx(tx, [
        {
          ...key,
          eventType: 'THREAD_CONTENT_HEAD',
          body: {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            groupMetaFeedEndId: 0,
          },
        },
      ]);
      await tx.insert(message).values({
        threadId: thread.id,
        seq: 1,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'snapshot' }),
        creatorAccount: 'snapshot-author',
        creatorDomain: 'local',
        updatedAt: new Date(),
      });
      await tx.insert(deletedMessage).values({
        threadId: thread.id,
        messageSeq: 1,
        deletionSeq: 1,
        type: 'USER_RETRACTION',
      });
      await feed.writeManyInTx(tx, [
        {
          ...key,
          eventType: 'THREAD_CONTENT_HEAD',
          body: {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            groupMetaFeedEndId: 1,
          },
        },
      ]);
    });
    const rows = await database.db
      .select()
      .from(peerStateFeed)
      .where(
        and(
          eq(peerStateFeed.account, account),
          eq(peerStateFeed.namespaceId, namespaceId(peerDomain)),
        ),
    );
    const head = rows.find((row) => row.eventType === 'THREAD_CONTENT_HEAD')!;
    expect(rows).toHaveLength(1);
    expect(head.body).toMatchObject({
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      groupMetaFeedEndId: 1,
    });
    await database.db.transaction((tx) =>
      feed.writeManyInTx(tx, [
        {
          ...key,
          eventType: 'RELATIONSHIP_INTENT',
          subjectAccount: 'remote-member',
          subjectDomain: peerDomain,
          body: { status: 'REQUESTED', profileRev: 0 },
        },
      ]),
    );
    const unchanged = await database.db.query.peerStateFeed.findFirst({
      where: and(
        eq(peerStateFeed.account, account),
        eq(peerStateFeed.namespaceId, namespaceId(peerDomain)),
        eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
      ),
    });
    expect(unchanged?.feedId).toBe(head.feedId);
    await database.db
      .delete(federatedPeer)
      .where(eq(federatedPeer.domain, peerDomain));
  });

  it('compacts a key and does not allocate a feed ID for identical writes', async () => {
    await database.db.transaction(async (tx) => {
      await feed.writeManyInTx(tx, [
        {
          peerDomain: DOMAINS[0],
          namespaceId: namespaceId(DOMAINS[0]),
          account: '!group-a',
          domain: 'local.test',
          eventType: 'THREAD_CONTENT_HEAD',
          subjectAccount: '',
          subjectDomain: 'local',
          body: {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            groupMetaFeedEndId: 1,
          },
        },
      ]);
      await feed.writeManyInTx(tx, [
        {
          peerDomain: DOMAINS[0],
          namespaceId: namespaceId(DOMAINS[0]),
          account: '!group-a',
          domain: 'local.test',
          eventType: 'THREAD_CONTENT_HEAD',
          subjectAccount: '',
          subjectDomain: 'local',
          body: {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            groupMetaFeedEndId: 2,
            updatedAt: wireTime,
          },
        },
      ]);
      await feed.writeManyInTx(tx, [
        {
          peerDomain: DOMAINS[0],
          namespaceId: namespaceId(DOMAINS[0]),
          account: '!group-a',
          domain: 'local.test',
          eventType: 'THREAD_CONTENT_HEAD',
          subjectAccount: '',
          subjectDomain: 'local',
          body: {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            groupMetaFeedEndId: 2,
            updatedAt: wireTime,
          },
        },
      ]);
    });
    const page = await feed.serve(DOMAINS[0], namespaceId(DOMAINS[0]), 0n);
    expect(page.stateFeedEndId).toBe('2');
    expect(page.scannedThrough).toBe('2');
    expect(page.items).toMatchObject([
      {
        feedId: '2',
        body: {
          groupMetaFeedEndId: 2,
          updatedAt: wireTime.getTime(),
        },
      },
    ]);
  });

  it('reindexes an unchanged confirmation when explicitly required', async () => {
    const domain = 'state-feed-confirmation.test';
    const testNamespaceId = await seedPeer(domain);
    try {
      const body = {
        status: 'ACCEPTED',
        profileRev: 3,
        note: '',
        requestedAt: wireTime,
        expiresAt: null,
      };
      await database.db.transaction(async (tx) => {
        await feed.writeManyInTx(tx, [
          {
            peerDomain: domain,
            namespaceId: testNamespaceId,
            account: 'alice',
            domain: 'local.test',
            subjectAccount: 'bob',
            subjectDomain: domain,
            eventType: 'RELATIONSHIP_INTENT',
            body,
          },
        ]);
        await feed.writeAcceptanceConfirmationsInTx(tx, [
          {
            peerDomain: domain,
            namespaceId: testNamespaceId,
            account: 'alice',
            domain: 'local.test',
            subjectAccount: 'bob',
            subjectDomain: domain,
            eventType: 'RELATIONSHIP_INTENT',
            body,
          },
        ]);
      });

      const page = await feed.serve(domain, testNamespaceId, 0n);
      expect(page.stateFeedEndId).toBe('2');
      expect(page.items).toEqual([
        {
          account: 'alice',
          eventType: 'RELATIONSHIP_INTENT',
          peerAccount: 'bob',
          feedId: '2',
          body: {
            status: 'ACCEPTED',
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            profileRev: 3,
            note: '',
            requestedAt: wireTime.getTime(),
            expiresAt: null,
          },
        },
      ]);
    } finally {
      await database.db
        .delete(federatedPeer)
        .where(eq(federatedPeer.domain, domain));
    }
  });

  it('keeps multiple P2P subjects and peers independent', async () => {
    await database.db.transaction(async (tx) => {
      await feed.writeManyInTx(tx, [
        {
          peerDomain: DOMAINS[0],
          namespaceId: namespaceId(DOMAINS[0]),
          account: 'alice',
          domain: 'local.test',
          subjectAccount: 'bob',
          subjectDomain: DOMAINS[0],
          eventType: 'RELATIONSHIP_INTENT',
          body: {
            status: 'ACCEPTED',
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            profileRev: 3,
            note: '',
            requestedAt: wireTime,
            expiresAt: null,
          },
        },
        {
          peerDomain: DOMAINS[0],
          namespaceId: namespaceId(DOMAINS[0]),
          account: 'alice',
          domain: 'local.test',
          subjectAccount: 'carol',
          subjectDomain: DOMAINS[0],
          eventType: 'RELATIONSHIP_INTENT',
          body: {
            status: 'REVOKED',
            profileRev: 5,
            note: '',
            requestedAt: null,
            expiresAt: null,
          },
        },
        {
          peerDomain: DOMAINS[1],
          namespaceId: namespaceId(DOMAINS[1]),
          account: '!private-to-b',
          domain: 'local.test',
          eventType: 'THREAD_CONTENT_HEAD',
          subjectAccount: '',
          subjectDomain: 'local',
          body: {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            groupMetaFeedEndId: 1,
          },
        },
      ]);
    });
    const a = await feed.serve(DOMAINS[0], namespaceId(DOMAINS[0]), 2n);
    const b = await feed.serve(DOMAINS[1], namespaceId(DOMAINS[1]), 0n);
    expect(a.items.map((x) => x.peerAccount)).toEqual(['bob', 'carol']);
    expect(b.items).toHaveLength(1);
    expect(b.items[0].body).toMatchObject({ groupMetaFeedEndId: 1 });
  });

  it('serves an older after without maintaining a source-side peer cursor', async () => {
    const later = await feed.serve(DOMAINS[0], namespaceId(DOMAINS[0]), 4n);
    const replay = await feed.serve(DOMAINS[0], namespaceId(DOMAINS[0]), 0n);
    expect(BigInt(replay.scannedThrough)).toBeGreaterThanOrEqual(
      BigInt(later.scannedThrough),
    );
    expect(replay.items.length).toBeGreaterThan(0);
  });

  it('rolls allocation and item back atomically', async () => {
    await expect(
      database.db.transaction(async (tx) => {
        await feed.writeManyInTx(tx, [
          {
            peerDomain: DOMAINS[1],
            namespaceId: namespaceId(DOMAINS[1]),
            account: '!rollback',
            domain: 'local.test',
            eventType: 'THREAD_CONTENT_HEAD',
            subjectAccount: '',
            subjectDomain: 'local',
            body: {
              messageEndSeq: 0,
              tombstoneEndSeq: 0,
              groupMetaFeedEndId: 1,
            },
          },
        ]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const [target] = await database.db
      .select()
      .from(identityNamespace)
      .where(eq(identityNamespace.domain, DOMAINS[1]));
    const rows = await database.db
      .select()
      .from(peerStateFeed)
      .where(eq(peerStateFeed.account, '!rollback'));
    expect(target.stateFeedEndId).toBe(1n);
    expect(rows).toHaveLength(0);
  });

  it('retains the namespace feed when the peer control row is deleted', async () => {
    const domain = 'state-feed-cascade.test';
    const testNamespaceId = await seedPeer(domain);
    await database.db.transaction((tx) =>
      feed.writeManyInTx(tx, [
        {
          peerDomain: domain,
          namespaceId: testNamespaceId,
          account: '!group-cascade',
          domain: 'local.test',
          eventType: 'THREAD_CONTENT_HEAD',
          subjectAccount: '',
          subjectDomain: 'local',
          body: {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            groupMetaFeedEndId: 1,
          },
        },
      ]),
    );
    await database.db
      .delete(federatedPeer)
      .where(eq(federatedPeer.domain, domain));
    expect(await feed.readFeedEndId(testNamespaceId)).toBe(1n);
  });

});
