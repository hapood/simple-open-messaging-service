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
  identityNamespace,
  messageThread,
  peerStateFeed,
} from '../src/database/schema.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';
import { RelationshipIntentService } from '../src/relationship/relationship-intent.service.js';
import { fakeRootPublicKey } from './seed.js';

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
        rootPublicKey: fakeRootPublicKey(domain),
        identityPinnedAt: new Date(),
        active: true,
        trustLevel: 'available',
      })
      .returning({ id: identityNamespace.id });
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

  async function deactivatePeer(domain: string): Promise<void> {
    await database.db
      .update(identityNamespace)
      .set({ active: false })
      .where(eq(identityNamespace.domain, domain));
  }

  afterAll(async () => {
    await deactivatePeer(DOMAINS[0]);
    await deactivatePeer(DOMAINS[1]);
    await mod.close();
  });

  it('indexes Group Meta and content as one complete thread head', async () => {
    const peerDomain = 'fresh-snapshot.test';
    await seedPeer(peerDomain);
    const peerNamespaceId = namespaceId(peerDomain);
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
      targetNamespaceId: peerNamespaceId,
    });
    // A Group thread head has no directional subject: the peer is the key.
    const key = {
      namespaceId: peerNamespaceId,
      account,
      subjectAccount: '',
      subjectNamespaceId: 0,
    };
    await database.db.transaction(async (tx) => {
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
      await tx.insert(message).values({
        threadId: thread.id,
        seq: 1,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'snapshot' }),
        creatorAccount: 'snapshot-author',
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
          eq(peerStateFeed.namespaceId, peerNamespaceId),
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
          subjectNamespaceId: peerNamespaceId,
          body: {
            status: 'REQUESTED',
            namespaceId: peerNamespaceId,
            profileRev: 0,
          },
        },
      ]),
    );
    const unchanged = await database.db.query.peerStateFeed.findFirst({
      where: and(
        eq(peerStateFeed.account, account),
        eq(peerStateFeed.namespaceId, peerNamespaceId),
        eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
      ),
    });
    expect(unchanged?.feedId).toBe(head.feedId);
    await deactivatePeer(peerDomain);
  });

  it('compacts a key and does not allocate a feed ID for identical writes', async () => {
    await database.db.transaction(async (tx) => {
      await feed.writeManyInTx(tx, [
        {
          namespaceId: namespaceId(DOMAINS[0]),
          account: '!group-a',
          eventType: 'THREAD_CONTENT_HEAD',
          subjectAccount: '',
          subjectNamespaceId: 0,
          body: {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            groupMetaFeedEndId: 1,
          },
        },
      ]);
      await feed.writeManyInTx(tx, [
        {
          namespaceId: namespaceId(DOMAINS[0]),
          account: '!group-a',
          eventType: 'THREAD_CONTENT_HEAD',
          subjectAccount: '',
          subjectNamespaceId: 0,
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
          namespaceId: namespaceId(DOMAINS[0]),
          account: '!group-a',
          eventType: 'THREAD_CONTENT_HEAD',
          subjectAccount: '',
          subjectNamespaceId: 0,
          body: {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            groupMetaFeedEndId: 2,
            updatedAt: wireTime,
          },
        },
      ]);
    });
    const page = await feed.serve(namespaceId(DOMAINS[0]), 0n);
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
        namespaceId: testNamespaceId,
        profileRev: 3,
        note: '',
        requestedAt: wireTime,
        expiresAt: null,
      };
      await database.db.transaction(async (tx) => {
        await feed.writeManyInTx(tx, [
          {
            namespaceId: testNamespaceId,
            account: 'alice',
            subjectAccount: 'bob',
            subjectNamespaceId: testNamespaceId,
            eventType: 'RELATIONSHIP_INTENT',
            body,
          },
        ]);
        await feed.writeAcceptanceConfirmationsInTx(tx, [
          {
            namespaceId: testNamespaceId,
            account: 'alice',
            subjectAccount: 'bob',
            subjectNamespaceId: testNamespaceId,
            eventType: 'RELATIONSHIP_INTENT',
            body,
          },
        ]);
      });

      const page = await feed.serve(testNamespaceId, 0n);
      expect(page.stateFeedEndId).toBe('2');
      expect(page.items).toEqual([
        {
          account: 'alice',
          eventType: 'RELATIONSHIP_INTENT',
          peerAccount: 'bob',
          feedId: '2',
          body: {
            status: 'ACCEPTED',
            namespaceId: testNamespaceId,
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
      await deactivatePeer(domain);
    }
  });

  it('keeps multiple P2P subjects and peers independent', async () => {
    await database.db.transaction(async (tx) => {
      await feed.writeManyInTx(tx, [
        {
          namespaceId: namespaceId(DOMAINS[0]),
          account: 'alice',
          subjectAccount: 'bob',
          subjectNamespaceId: namespaceId(DOMAINS[0]),
          eventType: 'RELATIONSHIP_INTENT',
          body: {
            status: 'ACCEPTED',
            namespaceId: namespaceId(DOMAINS[0]),
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            profileRev: 3,
            note: '',
            requestedAt: wireTime,
            expiresAt: null,
          },
        },
        {
          namespaceId: namespaceId(DOMAINS[0]),
          account: 'alice',
          subjectAccount: 'carol',
          subjectNamespaceId: namespaceId(DOMAINS[0]),
          eventType: 'RELATIONSHIP_INTENT',
          body: {
            status: 'REVOKED',
            namespaceId: namespaceId(DOMAINS[0]),
            profileRev: 5,
            note: '',
            requestedAt: null,
            expiresAt: null,
          },
        },
        {
          namespaceId: namespaceId(DOMAINS[1]),
          account: '!private-to-b',
          eventType: 'THREAD_CONTENT_HEAD',
          subjectAccount: '',
          subjectNamespaceId: 0,
          body: {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            groupMetaFeedEndId: 1,
          },
        },
      ]);
    });
    const a = await feed.serve(namespaceId(DOMAINS[0]), 2n);
    const b = await feed.serve(namespaceId(DOMAINS[1]), 0n);
    expect(a.items.map((x) => x.peerAccount)).toEqual(['bob', 'carol']);
    expect(b.items).toHaveLength(1);
    expect(b.items[0].body).toMatchObject({ groupMetaFeedEndId: 1 });
  });

  it('serves an older after without maintaining a source-side peer cursor', async () => {
    const later = await feed.serve(namespaceId(DOMAINS[0]), 4n);
    const replay = await feed.serve(namespaceId(DOMAINS[0]), 0n);
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
            namespaceId: namespaceId(DOMAINS[1]),
            account: '!rollback',
            eventType: 'THREAD_CONTENT_HEAD',
            subjectAccount: '',
            subjectNamespaceId: 0,
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

  it('retains the namespace feed when the peer is deactivated', async () => {
    const domain = 'state-feed-cascade.test';
    const testNamespaceId = await seedPeer(domain);
    await database.db.transaction((tx) =>
      feed.writeManyInTx(tx, [
        {
          namespaceId: testNamespaceId,
          account: '!group-cascade',
          eventType: 'THREAD_CONTENT_HEAD',
          subjectAccount: '',
          subjectNamespaceId: 0,
          body: {
            messageEndSeq: 0,
            tombstoneEndSeq: 0,
            groupMetaFeedEndId: 1,
          },
        },
      ]),
    );
    // Feed rows pin the namespace row (FK RESTRICT), so a departed peer is
    // deactivated rather than deleted; its served coordinates must survive.
    await deactivatePeer(domain);
    expect(await feed.readFeedEndId(testNamespaceId)).toBe(1n);
  });
});
