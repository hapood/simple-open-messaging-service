import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { ContentType } from '../src/database/enums.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { DeletedMessageService } from '../src/message/deleted-message.service.js';
import { FederationInboundMessagePageService } from '../src/federation/federation-inbound-message-page.service.js';
import { FederationInboundMessageStoreService } from '../src/federation/federation-inbound-message-store.service.js';
import { FederationInboundMessageRouteService } from '../src/federation/federation-inbound-message-route.service.js';
import { FederationInboundMessageValidatorService } from '../src/federation/federation-inbound-message-validator.service.js';
import { FederationNamespaceService } from '../src/federation/federation-namespace.service.js';
import { FederationThreadAccessService } from '../src/federation/federation-thread-access.service.js';
import { ProfileNamespaceFeedService } from '../src/federation/profile-namespace-feed.service.js';
import { ProfileNamespaceChangeStore } from '../src/federation/profile-namespace-change-store.service.js';
import { ProfileNamespaceService } from '../src/federation/profile-namespace.service.js';
import { KeypairService } from '../src/federation/keypair.service.js';
import { SseService } from '../src/gateway/sse.service.js';
import { CallStateRegistry } from '../src/gateway/call-state.registry.js';
import { wirePayloadDigest } from '../src/federation/federated-message-content.js';
import type { FederationMessageFeedMessage } from '../src/federation/federation-message-feed.service.js';
import { requireThreadContentLockInTx } from '../src/common/locks/thread-content-lock.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { truncateTablesForTest } from './support/truncate';
import { FederationMessageFeedService } from '../src/federation/federation-message-feed.service.js';
import {
  assertFederationMessageWire,
  assertFederationWireSchema,
} from './support/federation-wire-schema.js';

describe('group origin rejects mirror copies as processing receipts', () => {
  const authorDomain = 'author-a.test';
  const mirrorDomain = 'mirror-b.test';
  const groupAccount = '!receiptgroup';
  const createdAt = new Date('2026-09-16T00:00:00.000Z');
  let module: TestingModule;
  let database: DatabaseService;
  let pages: FederationInboundMessagePageService;
  let store: FederationInboundMessageStoreService;
  let namespaces: FederationNamespaceService;
  let threadId: number;
  let messageId: bigint;
  let authorNamespace: number;
  let mirrorNamespace: number;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [
        FederationNamespaceService,
        ProfileNamespaceFeedService,
        ProfileNamespaceChangeStore,
        ProfileNamespaceService,
        KeypairService,
        SseService,
        CallStateRegistry,
      ],
    }).compile();
    database = module.get(DatabaseService);
    namespaces = module.get(FederationNamespaceService);
    const threadAccess = new FederationThreadAccessService(
      database,
      namespaces,
    );
    store = new FederationInboundMessageStoreService(
      threadAccess,
      undefined as never,
      undefined as never,
      new DeletedMessageService(database),
    );
    vi.spyOn(store, 'applyProcessingReceipt');
    vi.spyOn(store, 'store');
    pages = new FederationInboundMessagePageService(
      threadAccess,
      new FederationInboundMessageValidatorService(),
      new FederationInboundMessageRouteService(),
      store,
    );
  });
  afterAll(async () => module.close());

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread", "DurableTask", "RelationshipIntent", "PeerStateFeed" RESTART IDENTITY CASCADE',
    );
    authorNamespace = await seedFederatedPeerNamespace(
      database.db,
      authorDomain,
    );
    mirrorNamespace = await seedFederatedPeerNamespace(
      database.db,
      mirrorDomain,
    );
    const [group] = await database.db
      .insert(tables.groupAccount)
      .values({ account: groupAccount })
      .returning();
    const [thread] = await database.db
      .insert(tables.messageThread)
      .values({
        type: 'GROUP',
        groupAccount,
        groupAccountId: group.id,
        curSeq: 42,
        updatedAt: createdAt,
      })
      .returning();
    threadId = thread.id;
    // Bob is a valid member at this home. That does not authorize its mirror
    // to submit Alice's origin-distributed copy as a processing receipt.
    await database.db.insert(tables.relationshipPair).values({
      kind: 'GROUP_MEMBER',
      endpointAType: 'GROUP',
      endpointAAccount: groupAccount,
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: 'bob',
      endpointBNamespaceId: mirrorNamespace,
      threadId,
      active: true,
    });
    const [message] = await database.db
      .insert(tables.message)
      .values({
        threadId,
        seq: 42,
        originSeq: 7,
        originServerTime: new Date(createdAt.getTime() - 1000),
        publisherNamespaceId: authorNamespace,
        creatorAccount: 'alice',
        profileNamespaceId: 0,
        profileRev: 3,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'from Alice' }),
        payloadDigest: wirePayloadDigest(
          ContentType.PURE_TEXT,
          JSON.stringify({ text: 'from Alice' }),
        ),
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    messageId = message.id;
  });

  function receipt(): Extract<
    FederationMessageFeedMessage,
    { author: { account: string } }
  > {
    return {
      thread: { account: groupAccount },
      author: { account: 'alice', namespaceId: authorNamespace },
      seq: 99,
      originSeq: 42,
      originCreatedAt: createdAt.getTime(),
      createdAt: createdAt.getTime() + 1000,
      profileRev: 3,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'from Alice' }),
      assets: [],
    };
  }

  async function apply(item = receipt(), reverse = false) {
    const token = await namespaces.captureActive(mirrorDomain);
    return database.db.transaction(async (tx) => {
      const threadLock = await requireThreadContentLockInTx(tx, threadId);
      return pages.apply(tx, mirrorDomain, [item], token, {
        expectedThreadId: threadId,
        threadLock,
        isolateMissingContext: true,
        ...(reverse
          ? {
              sequencePolicy: {
                kind: 'MAP_ORIGIN' as const,
                beforeSeq: 100,
                throughSeq: 40,
                messageSeqOffset: 0,
              },
            }
          : {}),
      });
    });
  }

  async function expectOriginalUnchanged() {
    const messages = await database.db.query.message.findMany({
      where: eq(tables.message.threadId, threadId),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: messageId,
      seq: 42,
      originSeq: 7,
      creatorAccount: 'alice',
      publisherNamespaceId: authorNamespace,
      profileNamespaceId: 0,
      content: JSON.stringify({ text: 'from Alice' }),
      updatedAt: createdAt,
      federationPayloadVerification: 'UNVERIFIED',
    });
    expect(store.applyProcessingReceipt).not.toHaveBeenCalled();
    expect(store.store).not.toHaveBeenCalled();
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, threadId),
    });
    expect(thread?.curSeq).toBe(42);
    expect(await database.db.query.durableTask.findMany()).toEqual([]);
    expect(await database.db.query.peerStateFeed.findMany()).toEqual([]);
  }

  it.each([false, true])(
    'filters publisher-relative zero on mirror publication in both cursor directions (reverse=%s)',
    async (reverse) => {
      const [member] = await database.db
        .insert(tables.account)
        .values({ account: 'localmember' })
        .returning();
      const [mirror] = await database.db
        .insert(tables.messageThread)
        .values({
          type: 'GROUP',
          groupAccount,
          authorityNamespaceId: authorNamespace,
          curSeq: 5,
          updatedAt: createdAt,
        })
        .returning();
      await database.db
        .insert(tables.accountThreadState)
        .values({ accountId: member.id, threadId: mirror.id, role: 'MEMBER' });
      await database.db.insert(tables.relationshipPair).values({
        kind: 'GROUP_MEMBER',
        threadId: mirror.id,
        active: true,
        endpointAType: 'USER',
        endpointAAccount: member.account,
        endpointANamespaceId: 0,
        endpointBType: 'GROUP',
        endpointBAccount: groupAccount,
        endpointBNamespaceId: authorNamespace,
      });
      await database.db.insert(tables.relationshipIntent).values({
        authorAccount: groupAccount,
        authorNamespaceId: authorNamespace,
        receiverAccount: member.account,
        receiverNamespaceId: 0,
        profileNamespaceId: 0,
        status: 'ACCEPTED',
        profileRev: 0,
        messageEndSeq: 5,
        tombstoneEndSeq: 0,
        statusChangedAt: createdAt,
      });
      await database.db.insert(tables.peerStateFeed).values({
        namespaceId: authorNamespace,
        account: groupAccount,
        eventType: 'THREAD_CONTENT_HEAD',
        feedId: 1n,
        body: { messageEndSeq: 5, tombstoneEndSeq: 0 },
      });
      for (const seq of [1, 2, 3, 4, 5]) {
        const local = seq === 2 || seq === 4;
        const content = JSON.stringify({ text: `mirror-${seq}` });
        await database.db.insert(tables.message).values({
          threadId: mirror.id,
          seq,
          creatorAccount: local || seq === 5 ? member.account : 'other',
          publisherNamespaceId: local ? 0 : authorNamespace,
          profileNamespaceId: seq === 3 ? mirrorNamespace : 0,
          originSeq: seq === 2 ? null : seq + 10,
          originServerTime: seq === 2 ? null : createdAt,
          contentType: 'PURE_TEXT',
          content,
          payloadDigest: wirePayloadDigest(ContentType.PURE_TEXT, content),
          updatedAt: createdAt,
        });
      }
      const feed = new FederationMessageFeedService(database);
      const first = await feed.query(
        authorNamespace,
        { type: 'GROUP', account: groupAccount },
        reverse ? undefined : 0,
        1,
        reverse ? 1 : 5,
        false,
        reverse ? 6 : undefined,
      );
      assertFederationWireSchema('urn:somfp:v1:message-query', first);
      expect(first.messages.map((item) => item.seq)).toEqual([reverse ? 4 : 2]);
      expect(first.hasMore).toBe(true);
      const second = await feed.query(
        authorNamespace,
        { type: 'GROUP', account: groupAccount },
        reverse ? undefined : first.scannedThrough,
        1,
        reverse ? 1 : 5,
        false,
        reverse ? first.scannedThrough : undefined,
      );
      assertFederationWireSchema('urn:somfp:v1:message-query', second);
      expect(second.messages.map((item) => item.seq)).toEqual([
        reverse ? 2 : 4,
      ]);
      expect(second.scannedThrough).toBe(reverse ? 1 : 5);
      expect(second.hasMore).toBe(false);
      for (const item of [...first.messages, ...second.messages]) {
        assertFederationMessageWire(item);
        expect(item.author).toEqual({
          account: member.account,
          namespaceId: 0,
        });
      }
    },
  );

  it.each([false, true])(
    'skips a mirror copy and its replay without verifying or changing the original (reverse=%s)',
    async (reverse) => {
      expect(await apply(receipt(), reverse)).toEqual([]);
      expect(await apply(receipt(), reverse)).toEqual([]);
      expect(
        await database.db.query.message.findMany({
          where: eq(tables.message.id, messageId),
          columns: { federationPayloadVerification: true },
        }),
      ).toMatchObject([{ federationPayloadVerification: 'UNVERIFIED' }]);
      await expectOriginalUnchanged();
    },
  );

  it.each([
    'author',
    'coordinate',
    'time',
    'audience',
    'new-submission',
  ] as const)(
    'rejects an invalid %s binding without inserting a receipt or message',
    async (invalid) => {
      const item = receipt();
      if (invalid === 'author' && 'author' in item)
        item.author.account = 'mallory';
      if (invalid === 'coordinate') item.originSeq = 41;
      if (invalid === 'time') item.originCreatedAt = createdAt.getTime() - 1;
      if (invalid === 'new-submission') {
        item.originSeq = null;
        item.originCreatedAt = null;
      }
      if (invalid === 'audience')
        await database.db
          .update(tables.relationshipPair)
          .set({ active: false })
          .where(eq(tables.relationshipPair.threadId, threadId));
      expect(await apply(item)).toEqual([]);
      expect(
        await database.db.query.message.findMany({
          where: eq(tables.message.id, messageId),
          columns: { federationPayloadVerification: true },
        }),
      ).toEqual([{ federationPayloadVerification: 'UNVERIFIED' }]);
      await expectOriginalUnchanged();
    },
  );
});
