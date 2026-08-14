import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageDeleteType } from '../src/database/enums.js';
import {
  deletedMessage,
  federatedPeer,
  federationMessageDelivery,
  federationTombstoneServeCursor,
  message,
  messageThread,
  threadAudience,
  threadParticipant,
  user,
} from '../src/database/schema.js';
import { FederationMessageTombstoneFeedService } from '../src/federation/federation-message-tombstone-feed.service.js';

describe('FederationMessageTombstoneFeedService compacted feed', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let service: FederationMessageTombstoneFeedService;
  const peerDomain = 'tombstone-feed-peer.test';

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
    service = new FederationMessageTombstoneFeedService(database);
  });

  afterAll(async () => mod.close());

  async function seedDeletion() {
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
    const [target] = await database.db
      .insert(message)
      .values({
        seq: 0,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'deleted' }),
        threadId: thread.id,
        creator: alice.id,
        isDeleted: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await database.db.insert(federationMessageDelivery).values({
      peerDomain,
      messageId: target.id,
    });
    const [deletion] = await database.db
      .insert(deletedMessage)
      .values({
        threadId: thread.id,
        seq: 0,
        type: MessageDeleteType.WITHDRAW,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await database.db
      .insert(federationTombstoneServeCursor)
      .values({ peerDomain });
    return { deletion, target, thread };
  }

  it('serves only a compacted thread/end index and queries the fact separately', async () => {
    const { deletion } = await seedDeletion();

    const feed = await service.serve(peerDomain, 0n);
    expect(feed).toMatchObject({
      scannedThrough: '1',
      tombstoneFeedEndId: '1',
      hasMore: false,
      items: [
        {
          feedId: '1',
          tombstoneEndSeq: deletion.id.toString(),
        },
      ],
    });
    expect(feed).not.toHaveProperty('tombstones');

    const page = await service.query(
      peerDomain,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0n,
      undefined,
      deletion.id,
    );
    expect(page).toMatchObject({
      scannedThrough: deletion.id.toString(),
      hasMore: false,
      tombstones: [
        {
          deletionSeq: deletion.id.toString(),
          type: MessageDeleteType.WITHDRAW,
          target: { originSeq: 0 },
        },
      ],
    });
  });

  it('keeps the compacted feed index and historical fact without source ACK cleanup', async () => {
    await seedDeletion();
    const first = await service.serve(peerDomain, 0n);
    const replay = await new FederationMessageTombstoneFeedService(
      database,
    ).serve(peerDomain, 0n);
    expect(replay).toEqual(first);
  });

  it('keeps a delivered tombstone queryable after current audience closes', async () => {
    const { thread } = await seedDeletion();
    await service.fill(peerDomain);
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.threadId, thread.id));

    await expect(
      service.query(
        peerDomain,
        { type: 'P2P', account: 'alice', peerAccount: 'bob' },
        0n,
      ),
    ).resolves.toMatchObject({
      scannedThrough: '1',
      tombstones: [{ deletionSeq: '1' }],
    });
    await expect(service.serve(peerDomain, 0n)).resolves.toMatchObject({
      items: [{ feedId: '1' }],
    });
  });

  it('does not publish a deletion without a permanent delivery proof', async () => {
    const { target } = await seedDeletion();
    await database.db
      .delete(federationMessageDelivery)
      .where(eq(federationMessageDelivery.messageId, target.id));

    await expect(service.serve(peerDomain, 0n)).resolves.toEqual({
      items: [],
      scannedThrough: '0',
      tombstoneFeedEndId: '0',
      hasMore: false,
    });
  });

  it('uses 0 as the missing-after bootstrap for feed and query', async () => {
    await seedDeletion();
    await expect(service.rejectMissingAfter(peerDomain)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
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
      data: { resumeAfter: '0' },
    });
  });
});
