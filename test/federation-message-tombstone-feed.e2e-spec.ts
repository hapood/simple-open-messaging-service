import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageDeleteType } from '../src/database/enums.js';
import {
  deletedMessage,
  federatedPeer,
  identityNamespace,
  message,
  messageThread,
  peerStateFeed,
  threadAudience,
  account as user,
} from '../src/database/schema.js';
import { FederationMessageTombstoneFeedService } from '../src/federation/federation-message-tombstone-feed.service.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';
import { seedAcceptedRelationship } from './seed.js';

describe('FederationMessageTombstoneFeedService query', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let service: FederationMessageTombstoneFeedService;
  const peerDomain = 'tombstone-feed-peer.test';
  const localDomain = loadFederationConfig().domain;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "PeerStateFeed", "Account", "GroupAccount", "Profile", "MessageThread", "FederatedPeer" RESTART IDENTITY CASCADE',
    );
    service = new FederationMessageTombstoneFeedService(database);
  });

  afterAll(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "PeerStateFeed", "Account", "GroupAccount", "Profile", "MessageThread", "FederatedPeer" RESTART IDENTITY CASCADE',
    );
    await mod.close();
  });

  async function seedDeletion() {
    const now = new Date('2026-08-12T01:02:03.000Z');
    const [existingNamespace] = await database.db
      .select({ id: identityNamespace.id })
      .from(identityNamespace)
      .where(
        and(
          eq(identityNamespace.domain, peerDomain),
          isNull(identityNamespace.retiredAt),
        ),
      )
      .limit(1);
    const namespaceId =
      existingNamespace?.id ??
      (
        await database.db
          .insert(identityNamespace)
          .values({
            domain: peerDomain,
            rootKeyFingerprint: 'sha256:tombstone-feed-test',
            rootPublicKey: Buffer.alloc(32, 1).toString('base64'),
            identityPinnedAt: now,
          })
          .returning({ id: identityNamespace.id })
      )[0].id;
    await database.db.insert(federatedPeer).values({
      domain: peerDomain,
      activeNamespaceId: namespaceId,
      trustLevel: 'available',
    });
    const [alice] = await database.db
      .insert(user)
      .values({
        account: 'alice',
        domain: 'local',
        updatedAt: now,
      })
      .returning();
    const bob = { account: 'bob', domain: peerDomain, namespaceId };
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        curSeq: 0,
        deletionSeqAllocatedThrough: 1,
        updatedAt: now,
      })
      .returning();
    await seedAcceptedRelationship(database.db, alice.id, bob, thread.id);
    await database.db.insert(threadAudience).values({
      targetDomain: peerDomain,
      targetNamespaceId: namespaceId,
      threadId: thread.id,
      messageAccessAfterSeq: 0,
    });
    const [target] = await database.db
      .insert(message)
      .values({
        seq: 1,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'deleted' }),
        threadId: thread.id,
        creatorAccount: alice.account,
        creatorDomain: alice.domain,
        isDeleted: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [deletion] = await database.db
      .insert(deletedMessage)
      .values({
        threadId: thread.id,
        deletionSeq: 1,
        messageSeq: 1,
        type: MessageDeleteType.USER_RETRACTION,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await database.db.insert(peerStateFeed).values({
      peerDomain,
      namespaceId,
      account: alice.account,
      domain: localDomain,
      eventType: 'THREAD_CONTENT_HEAD',
      subjectAccount: bob.account,
      subjectDomain: peerDomain,
      feedId: 1n,
      body: { messageEndSeq: 1, tombstoneEndSeq: deletion.deletionSeq },
    });
    return { deletion, namespaceId, target, thread };
  }

  it('queries deletion facts through the advertised State Feed head', async () => {
    const { deletion, namespaceId, thread } = await seedDeletion();

    const page = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      deletion.deletionSeq,
    );
    expect(page).toMatchObject({
      scannedThrough: deletion.deletionSeq,
      hasMore: false,
      tombstones: [
        {
          deletionSeq: deletion.deletionSeq,
          type: MessageDeleteType.USER_RETRACTION,
          messageSeq: 1,
        },
      ],
    });
  });

  it('omits requester-authored tombstones when includeSelf is false', async () => {
    const { deletion, namespaceId, thread } = await seedDeletion();
    const page = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      deletion.deletionSeq,
      false,
    );
    expect(page.tombstones).toHaveLength(1);

    await database.db
      .update(message)
      .set({ creatorDomain: peerDomain, creatorNamespaceId: namespaceId })
      .where(and(eq(message.threadId, thread.id), eq(message.seq, 1)));
    const filtered = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      deletion.deletionSeq,
      false,
    );
    expect(filtered).toMatchObject({
      tombstones: [],
      scannedThrough: deletion.deletionSeq,
      hasMore: false,
    });
  });

  it('uses the current publisher coordinate for tombstones and maxMessageSeq', async () => {
    const { deletion, namespaceId, thread } = await seedDeletion();
    const now = new Date('2026-08-12T01:03:03.000Z');
    await database.db.insert(message).values({
      seq: 2,
      originSeq: 5,
      originServerTime: now,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({
        text: 'deleted later in publisher coordinates',
      }),
      threadId: thread.id,
      creatorAccount: 'alice',
      creatorDomain: 'local',
      isDeleted: true,
      createdAt: now,
      updatedAt: now,
    });
    const [laterDeletion] = await database.db
      .insert(deletedMessage)
      .values({
        threadId: thread.id,
        deletionSeq: 2,
        messageSeq: 2,
        type: MessageDeleteType.USER_RETRACTION,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await database.db
      .update(messageThread)
      .set({ deletionSeqAllocatedThrough: 2 })
      .where(eq(messageThread.id, thread.id));
    await database.db
      .update(peerStateFeed)
      .set({
        body: { messageEndSeq: 2, tombstoneEndSeq: laterDeletion.deletionSeq },
      })
      .where(eq(peerStateFeed.namespaceId, namespaceId));

    const page = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      laterDeletion.deletionSeq,
      true,
      2,
    );

    expect(page).toMatchObject({
      tombstones: [
        { deletionSeq: deletion.deletionSeq, messageSeq: 1 },
        { deletionSeq: laterDeletion.deletionSeq, messageSeq: 2 },
      ],
      scannedThrough: laterDeletion.deletionSeq,
      hasMore: false,
    });
  });

  it('advances a bounded multi-page scan across filtered deletion coordinates', async () => {
    const { deletion, namespaceId, thread } = await seedDeletion();
    const now = new Date('2026-08-12T01:04:03.000Z');
    await database.db.insert(message).values(
      [
        { seq: 2, originSeq: 10, text: 'filtered-one' },
        { seq: 3, originSeq: 2, text: 'eligible-two' },
        { seq: 4, originSeq: 11, text: 'filtered-two' },
      ].map(({ seq, originSeq, text }) => ({
        seq,
        originSeq,
        originServerTime: now,
        contentType: 'PURE_TEXT' as const,
        content: JSON.stringify({ text }),
        threadId: thread.id,
        creatorAccount: 'alice',
        creatorDomain: 'local',
        isDeleted: true,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await database.db.insert(deletedMessage).values(
      [2, 3, 4].map((deletionSeq) => ({
        threadId: thread.id,
        deletionSeq,
        messageSeq: deletionSeq,
        type: MessageDeleteType.USER_RETRACTION,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await database.db
      .update(messageThread)
      .set({ deletionSeqAllocatedThrough: 4 })
      .where(eq(messageThread.id, thread.id));
    await database.db
      .update(peerStateFeed)
      .set({ body: { messageEndSeq: 4, tombstoneEndSeq: 4 } })
      .where(eq(peerStateFeed.namespaceId, namespaceId));

    const first = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      1,
      4,
      true,
      3,
    );
    const second = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      first.scannedThrough,
      1,
      4,
      true,
      3,
    );
    const third = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      second.scannedThrough,
      1,
      4,
      true,
      3,
    );

    expect(first).toMatchObject({
      tombstones: [{ deletionSeq: deletion.deletionSeq, messageSeq: 1 }],
      scannedThrough: 1,
      hasMore: true,
    });
    expect(second).toMatchObject({
      tombstones: [{ deletionSeq: 2, messageSeq: 2 }],
      scannedThrough: 2,
      hasMore: true,
    });
    expect(third).toMatchObject({
      tombstones: [{ deletionSeq: 3, messageSeq: 3 }],
      scannedThrough: 4,
      hasMore: false,
    });
  });

  it('accepts a take above the local page capacity and caps it', async () => {
    const { deletion, namespaceId } = await seedDeletion();
    await expect(
      service.query(
        peerDomain,
        namespaceId,
        { type: 'P2P', account: 'alice', peerAccount: 'bob' },
        0,
        Number.MAX_SAFE_INTEGER,
        deletion.deletionSeq,
      ),
    ).resolves.toMatchObject({
      tombstones: [{ messageSeq: 1 }],
      scannedThrough: deletion.deletionSeq,
      hasMore: false,
    });
  });

  it('keeps P2P tombstone queries authorized by the relationship intent after audience closes', async () => {
    const { namespaceId, thread } = await seedDeletion();
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.threadId, thread.id));

    await expect(
      service.query(
        peerDomain,
        namespaceId,
        { type: 'P2P', account: 'alice', peerAccount: 'bob' },
        0,
      ),
    ).resolves.toMatchObject({ tombstones: [{ messageSeq: 1 }] });
  });

  it('exposes pre-floor tombstones inside a filtered reauthorization drain', async () => {
    const { deletion, namespaceId, thread } = await seedDeletion();
    await database.db
      .update(threadAudience)
      .set({ messageAccessAfterSeq: 1 })
      .where(eq(threadAudience.threadId, thread.id));

    const page = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      deletion.deletionSeq,
      true,
      1,
    );
    expect(page.tombstones).toEqual([
      expect.objectContaining({
        deletionSeq: deletion.deletionSeq,
        messageSeq: 1,
      }),
    ]);
    expect(page.scannedThrough).toBe(deletion.deletionSeq);
  });

  it('uses 0 as the missing-after bootstrap for the thread query', async () => {
    const { namespaceId } = await seedDeletion();
    await expect(
      service.rejectMissingQueryAfter(peerDomain, namespaceId, {
        type: 'P2P',
        account: 'alice',
        peerAccount: 'bob',
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      data: {
        resumeAfter: 0,
        resumeBefore: 2,
      },
    });
  });
});
