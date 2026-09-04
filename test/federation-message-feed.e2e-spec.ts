import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  identityNamespace,
  mediaAsset,
  message,
  messageAsset,
  messageThread,
  peerStateFeed,
  relationshipIntent,
  threadAudience,
  user,
} from '../src/database/schema.js';
import { FederationMessageFeedService } from '../src/federation/federation-message-feed.service.js';
import {
  closeFederatedAudienceInTx,
  openFederatedAudienceInTx,
} from '../src/federation/federation-audience.js';
import { seedAcceptedRelationship } from './seed.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';

describe('FederationMessageFeedService thread query', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let service: FederationMessageFeedService;
  const peerDomain = 'message-feed-peer.test';
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
    service = new FederationMessageFeedService(database);
  });

  afterAll(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "PeerStateFeed", "User", "Account", "FederatedPeer" RESTART IDENTITY CASCADE',
    );
    await mod.close();
  });

  async function seed() {
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
            rootKeyFingerprint: 'sha256:message-feed-test',
            rootPublicKey: Buffer.alloc(32, 3).toString('base64'),
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
          namespaceId,
          updatedAt: now,
        },
      ])
      .returning();
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', curSeq: 0, updatedAt: now })
      .returning();
    await seedAcceptedRelationship(database.db, alice.id, bob.id, thread.id);
    await database.db.insert(threadAudience).values({
      targetDomain: peerDomain,
      targetNamespaceId: namespaceId,
      threadId: thread.id,
      messageAccessAfterSeq: 0,
    });
    return { alice, namespaceId, thread };
  }

  async function append(
    threadId: number,
    creator: { account: string; domain: string },
    seq: number,
    namespaceId: number,
  ) {
    const now = new Date();
    await database.db.insert(message).values({
      seq,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: `message-${seq}` }),
      threadId,
      creatorAccount: creator.account,
      creatorDomain: creator.domain,
      updatedAt: now,
    });
    await database.db
      .update(messageThread)
      .set({ curSeq: seq })
      .where(eq(messageThread.id, threadId));
    await database.db
      .insert(peerStateFeed)
      .values({
        peerDomain,
        namespaceId,
        account: creator.account,
        domain: localDomain,
        eventType: 'THREAD_CONTENT_HEAD',
        subjectAccount: 'bob',
        subjectDomain: peerDomain,
        feedId: BigInt(seq),
        body: { messageEndSeq: seq, tombstoneEndSeq: 0 },
      })
      .onConflictDoUpdate({
        target: [
          peerStateFeed.namespaceId,
          peerStateFeed.account,
          peerStateFeed.domain,
          peerStateFeed.eventType,
          peerStateFeed.subjectAccount,
          peerStateFeed.subjectDomain,
        ],
        set: {
          feedId: BigInt(seq),
          body: { messageEndSeq: seq, tombstoneEndSeq: 0 },
          updatedAt: new Date(),
        },
      });
  }

  it('uses 0 as the message-query bootstrap', async () => {
    const { namespaceId } = await seed();
    await expect(
      service.rejectMissingQueryAfter(peerDomain, namespaceId, {
        type: 'P2P',
        account: 'alice',
        peerAccount: 'bob',
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      status: 200,
      data: { resumeAfter: 0, resumeBefore: 1 },
    });
  });

  it('queries the thread sequence advertised by State Feed', async () => {
    const { alice, namespaceId, thread } = await seed();
    await append(thread.id, alice, 1, namespaceId);

    const page = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      1,
    );
    expect(page).toMatchObject({
      scannedThrough: 1,
      hasMore: false,
      messages: [{ seq: 1, content: JSON.stringify({ text: 'message-1' }) }],
    });
  });

  it('accepts a take above the local page capacity and caps it', async () => {
    const { alice, namespaceId, thread } = await seed();
    await append(thread.id, alice, 1, namespaceId);

    await expect(
      service.query(
        peerDomain,
        namespaceId,
        { type: 'P2P', account: 'alice', peerAccount: 'bob' },
        0,
        Number.MAX_SAFE_INTEGER,
        1,
      ),
    ).resolves.toMatchObject({
      messages: [{ seq: 1 }],
      scannedThrough: 1,
      hasMore: false,
    });
  });

  it('uses the latest compacted State Feed head as the query end', async () => {
    const { alice, namespaceId, thread } = await seed();
    await append(thread.id, alice, 1, namespaceId);
    await append(thread.id, alice, 2, namespaceId);

    const [head] = await database.db
      .select()
      .from(peerStateFeed)
      .where(eq(peerStateFeed.namespaceId, namespaceId));
    expect(head).toMatchObject({
      feedId: 2n,
      body: { messageEndSeq: 2, tombstoneEndSeq: 0 },
    });

    await expect(
      service.query(
        peerDomain,
        namespaceId,
        { type: 'P2P', account: 'alice', peerAccount: 'bob' },
        99,
      ),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
      data: { resumeAfter: 0, resumeBefore: 3 },
    });
  });

  it('queries retained messages backwards with an exclusive before cursor', async () => {
    const { alice, namespaceId, thread } = await seed();
    await append(thread.id, alice, 1, namespaceId);
    await append(thread.id, alice, 2, namespaceId);

    const first = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      undefined,
      1,
      undefined,
      true,
      3,
    );
    expect(first).toMatchObject({
      messages: [{ seq: 2 }],
      scannedThrough: 2,
      hasMore: true,
    });

    const second = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      undefined,
      1,
      undefined,
      true,
      2,
    );
    expect(second).toMatchObject({
      messages: [{ seq: 1 }],
      scannedThrough: 1,
      hasMore: false,
    });
  });

  it('describes optional LINK artwork referenced by wire content', async () => {
    const { alice, namespaceId, thread } = await seed();
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
        creatorAccount: alice.account,
        creatorDomain: alice.domain,
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
    await database.db.insert(peerStateFeed).values({
      peerDomain,
      namespaceId,
      account: alice.account,
      domain: localDomain,
      eventType: 'THREAD_CONTENT_HEAD',
      subjectAccount: 'bob',
      subjectDomain: peerDomain,
      feedId: 1n,
      body: { messageEndSeq: 1, tombstoneEndSeq: 0 },
    });

    const page = await service.query(
      peerDomain,
      namespaceId,
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
      icon: digest,
    });
    expect(page.messages[0].assets).toEqual([{ digest, bytes: 123 }]);
  });

  it('revokes query authorization when the relationship intents close', async () => {
    const { alice, namespaceId, thread } = await seed();
    await append(thread.id, alice, 1, namespaceId);
    await database.db
      .update(relationshipIntent)
      .set({ status: 'REVOKED', expiresAt: null, updatedAt: new Date() });

    await expect(
      service.query(
        peerDomain,
        namespaceId,
        { type: 'P2P', account: 'alice', peerAccount: 'bob' },
        0,
      ),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FORBIDDEN,
    });
  });

  it('reauthorizes the stable thread without hiding retained history', async () => {
    const { alice, namespaceId, thread } = await seed();
    await append(thread.id, alice, 1, namespaceId);
    await database.db.transaction(async (tx) => {
      await closeFederatedAudienceInTx(tx, peerDomain, thread.id);
      await openFederatedAudienceInTx(tx, peerDomain, thread.id);
    });
    // Audience close removes the compacted head. The normal membership finalizer republishes it
    // after reopening; reproduce that post-commit projection step in this service-level fixture.
    await database.db.insert(peerStateFeed).values({
      peerDomain,
      namespaceId,
      account: alice.account,
      domain: localDomain,
      eventType: 'THREAD_CONTENT_HEAD',
      subjectAccount: 'bob',
      subjectDomain: peerDomain,
      feedId: 2n,
      body: { messageEndSeq: 1, tombstoneEndSeq: 0 },
    });

    await expect(
      service.query(
        peerDomain,
        namespaceId,
        { type: 'P2P', account: 'alice', peerAccount: 'bob' },
        0,
      ),
    ).resolves.toMatchObject({
      messages: [{ seq: 1 }],
      scannedThrough: 1,
      hasMore: false,
    });

    await append(thread.id, alice, 2, namespaceId);
    const page = await service.query(
      peerDomain,
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      1,
    );
    expect(page).toMatchObject({
      messages: [{ seq: 2 }],
      scannedThrough: 2,
      hasMore: false,
    });
  });
});
