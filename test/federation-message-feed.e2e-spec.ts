import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  mediaAsset,
  message,
  messageAsset,
  messageThread,
  threadAudience,
  threadParticipant,
  user,
} from '../src/database/schema.js';
import { FederationCursorService } from '../src/federation/federation-cursor.service.js';
import { FederationMessageFeedIndexerService } from '../src/federation/federation-message-feed-indexer.service.js';
import { FederationMessageFeedService } from '../src/federation/federation-message-feed.service.js';

describe('FederationMessageFeedService compacted feed', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let indexer: FederationMessageFeedIndexerService;
  let service: FederationMessageFeedService;
  const peerDomain = 'message-feed-peer.test';

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "User", "FederatedPeer" RESTART IDENTITY CASCADE',
    );
    indexer = new FederationMessageFeedIndexerService(database);
    service = new FederationMessageFeedService(database, indexer);
  });

  afterAll(async () => mod.close());

  async function seed() {
    const now = new Date('2026-08-12T01:02:03.000Z');
    await database.db.insert(federatedPeer).values({
      domain: peerDomain,
      trustLevel: 'available',
    });
    const [alice, bob] = await database.db
      .insert(user)
      .values([
        {
          account: 'alice',
          name: 'Alice',
          isForeigner: false,
          domain: 'local',
          updatedAt: now,
        },
        {
          account: 'bob',
          name: 'Bob',
          isForeigner: true,
          domain: peerDomain,
          updatedAt: now,
        },
      ])
      .returning();
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', curSeq: 0, updatedAt: now })
      .returning();
    await database.db.insert(threadParticipant).values([
      { userId: alice.id, threadId: thread.id, joinedAt: now, updatedAt: now },
      { userId: bob.id, threadId: thread.id, joinedAt: now, updatedAt: now },
    ]);
    await database.db.insert(threadAudience).values({
      targetDomain: peerDomain,
      threadId: thread.id,
      messageScannedThroughSeq: 0,
    });
    await new FederationCursorService(database).initializePeer(peerDomain, 0n);
    return { alice, thread };
  }

  async function append(threadId: number, creator: number, seq: number) {
    const now = new Date();
    await database.db.insert(message).values({
      seq,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: `message-${seq}` }),
      threadId,
      creator,
      updatedAt: now,
    });
    await database.db
      .update(messageThread)
      .set({ curSeq: seq })
      .where(eq(messageThread.id, threadId));
    await indexer.fill(peerDomain);
  }

  it('uses 0 as both feed and message-query bootstrap', async () => {
    await seed();
    await expect(service.rejectMissingAfter(peerDomain)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      status: 200,
      data: { resumeAfter: '0' },
    });
    await expect(
      service.rejectMissingQueryAfter(peerDomain, {
        type: 'P2P',
        account: 'alice',
        peerAccount: 'bob',
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      status: 200,
      data: { resumeAfter: '0' },
    });
  });

  it('serves only a compacted thread/end index and queries seq 1 separately', async () => {
    const { alice, thread } = await seed();
    await append(thread.id, alice.id, 1);

    const feed = await service.serve(peerDomain, 0n);
    expect(feed).toMatchObject({
      scannedThrough: '1',
      messageFeedEndId: '1',
      hasMore: false,
      items: [{ feedId: '1', messageEndSeq: '1' }],
    });
    expect(feed).not.toHaveProperty('messages');

    const page = await service.query(
      peerDomain,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      1,
    );
    expect(page).toMatchObject({
      scannedThrough: '1',
      hasMore: false,
      messages: [{ seq: 1, content: JSON.stringify({ text: 'message-1' }) }],
    });
  });

  it('replaces the per-thread index while keeping feed IDs increasing', async () => {
    const { alice, thread } = await seed();
    await append(thread.id, alice.id, 1);
    await append(thread.id, alice.id, 2);

    const page = await service.serve(peerDomain, 0n);
    expect(page.items).toMatchObject([{ feedId: '2', messageEndSeq: '2' }]);
    expect(page.scannedThrough).toBe('2');
    expect(page.messageFeedEndId).toBe('2');

    await expect(service.serve(peerDomain, 99n)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      data: { resumeAfter: '0' },
    });
  });

  it('does not describe sender-local LINK artwork removed from wire content', async () => {
    const { alice, thread } = await seed();
    const digest = 'a'.repeat(64);
    const [link] = await database.db
      .insert(message)
      .values({
        seq: 1,
        contentType: 'LINK',
        content: JSON.stringify({
          url: 'https://example.test/article',
          title: 'Example',
          description: 'Description',
          image: `/uploads/msg-assets/aa/aa/${digest}`,
        }),
        threadId: thread.id,
        creator: alice.id,
        updatedAt: new Date(),
      })
      .returning();
    await database.db.insert(mediaAsset).values({
      digest,
      bytes: 123n,
      isDeleted: false,
    });
    await database.db.insert(messageAsset).values({
      messageId: link.id,
      threadId: thread.id,
      digest,
    });
    await database.db
      .update(messageThread)
      .set({ curSeq: 1 })
      .where(eq(messageThread.id, thread.id));
    await indexer.fill(peerDomain);

    const page = await service.query(
      peerDomain,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      1,
    );

    expect(page.messages).toHaveLength(1);
    expect(JSON.parse(page.messages[0].content)).toEqual({
      url: 'https://example.test/article',
      title: 'Example',
      description: 'Description',
    });
    expect(page.messages[0].assets).toEqual([]);
  });

  it('revokes history access when the current audience closes', async () => {
    const { alice, thread } = await seed();
    await append(thread.id, alice.id, 1);
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.targetDomain, peerDomain));

    await expect(
      service.query(
        peerDomain,
        { type: 'P2P', account: 'alice', peerAccount: 'bob' },
        0,
      ),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FORBIDDEN,
    });
  });
});
