import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SystemMessageInput } from '../src/message/system-message.js';
import type { AccountSubjectAddress } from '../src/user/account-address.js';
import { withMessageDigest } from './support/message-fixture.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { BusinessCode } from '../src/common/business-code.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  identityNamespace,
  mediaAsset,
  message,
  messageAsset,
  messageThread,
  peerStateFeed,
  relationshipIntent,
  threadAudience,
  account as user,
} from '../src/database/schema.js';
import { FederationMessageFeedService } from '../src/federation/federation-message-feed.service.js';
import {
  closeFederatedAudienceInTx,
  openFederatedAudienceInTx,
} from '../src/federation/federation-audience.js';
import { seedAcceptedRelationship } from './seed.js';
import { truncateTablesForTest } from './support/truncate';
import {
  assertFederationMessageWire,
  assertFederationWireSchema,
} from './support/federation-wire-schema.js';

function assertMessagePage(
  page: Awaited<ReturnType<FederationMessageFeedService['query']>>,
): void {
  assertFederationWireSchema('urn:somfp:v1:message-query', page);
  page.messages.forEach(assertFederationMessageWire);
}

describe('FederationMessageFeedService thread query', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let service: FederationMessageFeedService;
  const peerDomain = 'message-feed-peer.test';

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "PeerStateFeed", "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
    );
    service = new FederationMessageFeedService(database);
  });

  afterAll(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "PeerStateFeed", "Account", "GroupAccount", "Profile", "MessageThread" RESTART IDENTITY CASCADE',
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
            rootPublicKey: Buffer.alloc(32, 3).toString('base64'),
            identityPinnedAt: now,
            active: true,
            trustLevel: 'available',
          })
          .returning({ id: identityNamespace.id })
      )[0].id;
    await database.db
      .update(identityNamespace)
      .set({ active: true, trustLevel: 'available' })
      .where(eq(identityNamespace.id, namespaceId));
    const [alice] = await database.db
      .insert(user)
      .values({
        account: 'alice',
        updatedAt: now,
      })
      .returning();
    const bob: AccountSubjectAddress = { account: 'bob', namespaceId };
    const [thread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', curSeq: 0, updatedAt: now })
      .returning();
    await seedAcceptedRelationship(database.db, alice.id, bob, thread.id);
    await database.db.insert(threadAudience).values({
      targetNamespaceId: namespaceId,
      threadId: thread.id,
      messageAccessAfterSeq: 0,
    });
    return { alice, namespaceId, thread };
  }

  async function append(
    threadId: number,
    creator: Pick<typeof user.$inferSelect, 'account'>,
    seq: number,
    namespaceId: number,
  ) {
    const now = new Date();
    await database.db.insert(message).values(
      withMessageDigest({
        seq,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: `message-${seq}` }),
        threadId,
        creatorAccount: creator.account,
        updatedAt: now,
      }),
    );
    await database.db
      .update(messageThread)
      .set({ curSeq: seq })
      .where(eq(messageThread.id, threadId));
    await database.db
      .insert(peerStateFeed)
      .values({
        namespaceId,
        account: creator.account,
        eventType: 'THREAD_CONTENT_HEAD',
        subjectAccount: 'bob',
        subjectNamespaceId: namespaceId,
        feedId: BigInt(seq),
        body: { messageEndSeq: seq, tombstoneEndSeq: 0 },
      })
      .onConflictDoUpdate({
        target: [
          peerStateFeed.namespaceId,
          peerStateFeed.account,
          peerStateFeed.eventType,
          peerStateFeed.subjectAccount,
          peerStateFeed.subjectNamespaceId,
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
      service.rejectMissingQueryAfter(namespaceId, {
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

  it.each([
    {
      name: 'trailing system rows after a full page',
      systemSeqs: [2, 3, 4, 5],
      expected: [1],
    },
    {
      name: 'leading system rows in reverse traversal',
      systemSeqs: [1, 2, 3, 4],
      expected: [5],
    },
    {
      name: 'interleaved system rows',
      systemSeqs: [1, 3, 5],
      expected: [2, 4],
    },
    { name: 'only system rows', systemSeqs: [1, 2, 3, 4, 5], expected: [] },
  ])(
    'paginates $name without false hasMore in either direction',
    async ({ systemSeqs, expected }) => {
      const { alice, namespaceId, thread } = await seed();
      for (let seq = 1; seq <= 5; seq++) {
        await append(thread.id, alice, seq, namespaceId);
        if (systemSeqs.includes(seq))
          await database.db
            .update(message)
            .set({
              contentType: 'SYSTEM',
              content: JSON.stringify({
                type: 'FRIEND_ADDED',
                participants: [
                  {
                    account: alice.account,
                    publisherNamespaceId: 0,
                    profileNamespaceId: 0,
                    profileRev: 0,
                  },
                  {
                    account: 'bob',
                    publisherNamespaceId: 0,
                    profileNamespaceId: namespaceId,
                    profileRev: 0,
                  },
                ],
              } satisfies SystemMessageInput),
              creatorAccount: '$system',
              profileNamespaceId: 0,
              publisherNamespaceId: 0,
              profileRev: 0,
            })
            .where(and(eq(message.threadId, thread.id), eq(message.seq, seq)));
      }
      const selector = {
        type: 'P2P' as const,
        account: 'alice',
        peerAccount: 'bob',
      };
      for (const forward of [true, false]) {
        const ordered = forward ? expected : [...expected].reverse();
        let cursor = forward ? 0 : 6;
        for (let index = 0; index < Math.max(1, ordered.length); index++) {
          const page = await service.query(
            namespaceId,
            selector,
            forward ? cursor : undefined,
            1,
            forward ? 5 : 1,
            true,
            forward ? undefined : cursor,
          );
          assertMessagePage(page);
          expect(page.messages.map((row) => row.seq)).toEqual(
            ordered.length ? [ordered[index]] : [],
          );
          expect(
            page.messages.every((row) => row.contentType !== 'SYSTEM'),
          ).toBe(true);
          const more = index + 1 < ordered.length;
          expect(page.hasMore).toBe(more);
          expect(page.scannedThrough).toBe(
            more ? ordered[index] : forward ? 5 : 1,
          );
          cursor = page.scannedThrough;
        }
      }
    },
  );

  it('queries the thread sequence advertised by State Feed', async () => {
    const { alice, namespaceId, thread } = await seed();
    await append(thread.id, alice, 1, namespaceId);

    const page = await service.query(
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      1,
    );
    assertMessagePage(page);
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
      .values(
        withMessageDigest({
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
          updatedAt: new Date(),
        }),
      )
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
      namespaceId,
      account: alice.account,
      eventType: 'THREAD_CONTENT_HEAD',
      subjectAccount: 'bob',
      subjectNamespaceId: namespaceId,
      feedId: 1n,
      body: { messageEndSeq: 1, tombstoneEndSeq: 0 },
    });

    const page = await service.query(
      namespaceId,
      { type: 'P2P', account: 'alice', peerAccount: 'bob' },
      0,
      undefined,
      1,
    );

    assertMessagePage(page);
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
      await closeFederatedAudienceInTx(tx, namespaceId, thread.id);
      await openFederatedAudienceInTx(tx, namespaceId, thread.id);
    });
    // Audience close removes the compacted head. The normal membership finalizer republishes it
    // after reopening; reproduce that post-commit projection step in this service-level fixture.
    await database.db.insert(peerStateFeed).values({
      namespaceId,
      account: alice.account,
      eventType: 'THREAD_CONTENT_HEAD',
      subjectAccount: 'bob',
      subjectNamespaceId: namespaceId,
      feedId: 2n,
      body: { messageEndSeq: 1, tombstoneEndSeq: 0 },
    });

    await expect(
      service.query(
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
