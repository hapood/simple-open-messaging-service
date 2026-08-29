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
  user,
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
      'TRUNCATE TABLE "PeerStateFeed", "User", "Account", "FederatedPeer" RESTART IDENTITY CASCADE',
    );
    service = new FederationMessageTombstoneFeedService(database);
  });

  afterAll(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "PeerStateFeed", "User", "Account", "FederatedPeer" RESTART IDENTITY CASCADE',
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
    const [alice, bob] = await database.db
      .insert(user)
      .values([
        {
          account: 'alice',
          name: 'Alice',
          domain: 'local',
          updatedAt: now,
        },
        {
          account: 'bob',
          name: 'Bob',
          domain: peerDomain,
          sourceDomain: peerDomain,
          namespaceId,
          updatedAt: now,
        },
      ])
      .returning();
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        curSeq: 0,
        deletionSeqAllocatedThrough: 1,
        updatedAt: now,
      })
      .returning();
    await seedAcceptedRelationship(database.db, alice.id, bob.id, thread.id);
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
    const { deletion } = await seedDeletion();

    const page = await service.query(
      peerDomain,
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
    const { deletion, namespaceId } = await seedDeletion();
    const page = await service.query(
      peerDomain,
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
      .where(eq(message.seq, 1));
    const filtered = await service.query(
      peerDomain,
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

  it('scans past tombstones above the fixed maxMessageSeq boundary', async () => {
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
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      laterDeletion.deletionSeq,
      true,
      2,
    );

    expect(page).toMatchObject({
      tombstones: [{ deletionSeq: deletion.deletionSeq, messageSeq: 1 }],
      scannedThrough: laterDeletion.deletionSeq,
      hasMore: false,
    });
  });

  it('rejects tombstone queries after current audience closes', async () => {
    const { thread } = await seedDeletion();
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.threadId, thread.id));

    await expect(
      service.query(
        peerDomain,
        { type: 'P2P', account: 'alice', peerAccount: 'bob' },
        0,
      ),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FORBIDDEN });
  });

  it('exposes pre-floor tombstones inside a filtered reauthorization drain', async () => {
    const { deletion, thread } = await seedDeletion();
    await database.db
      .update(threadAudience)
      .set({ messageAccessAfterSeq: 1 })
      .where(eq(threadAudience.threadId, thread.id));

    const page = await service.query(
      peerDomain,
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
    await seedDeletion();
    await expect(
      service.rejectMissingQueryAfter(peerDomain, {
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
