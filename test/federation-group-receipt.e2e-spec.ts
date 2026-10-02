import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
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
import type { FederationMessageFeedMessage } from '../src/federation/federation-message-feed.service.js';
import { requireThreadContentLockInTx } from '../src/common/locks/thread-content-lock.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { truncateTablesForTest } from './support/truncate';

describe('third-party group message processing receipts', () => {
  const authorDomain = 'author-a.test';
  const mirrorDomain = 'mirror-b.test';
  const groupAccount = '!receiptgroup';
  const createdAt = new Date('2026-09-16T00:00:00.000Z');
  let module: TestingModule;
  let database: DatabaseService;
  let pages: FederationInboundMessagePageService;
  let namespaces: FederationNamespaceService;
  let threadId: number;
  let messageId: bigint;
  let authorNamespace: number;
  let mirrorNamespace: number;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = module.get(DatabaseService);
    namespaces = new FederationNamespaceService(database);
    const threadAccess = new FederationThreadAccessService(database, namespaces);
    pages = new FederationInboundMessagePageService(
      threadAccess,
      new FederationInboundMessageValidatorService(),
      new FederationInboundMessageRouteService(),
      // The receipt path delegates to the store; construct a real one so applyProcessingReceipt
      // runs against the actual tables (insert paths need forwardBundles/quota and stay unused).
      new FederationInboundMessageStoreService(
        threadAccess,
        undefined as never,
        undefined as never,
        new DeletedMessageService(database),
      ),
    );
  });
  afterAll(async () => module.close());

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread", "DurableTask" RESTART IDENTITY CASCADE',
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
        groupDomain: 'local',
        groupAccountId: group.id,
        curSeq: 42,
        updatedAt: createdAt,
      })
      .returning();
    threadId = thread.id;
    // The receipt sender's member is Bob; the original author Alice need not
    // still be a member for Bob's mirror to acknowledge a previously published copy.
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
        sourceNamespaceId: authorNamespace,
        creatorAccount: 'alice',
        creatorDomain: authorDomain,
        profileNamespaceId: authorNamespace,
        profileRev: 3,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'from Alice' }),
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    messageId = message.id;
  });

  function receipt(): FederationMessageFeedMessage {
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
      profileNamespaceId: authorNamespace,
      content: JSON.stringify({ text: 'from Alice' }),
      updatedAt: createdAt,
    });
    const thread = await database.db.query.messageThread.findFirst({
      where: eq(tables.messageThread.id, threadId),
    });
    expect(thread?.curSeq).toBe(42);
    expect(await database.db.query.durableTask.findMany()).toEqual([]);
    expect(await database.db.query.peerStateFeed.findMany()).toEqual([]);
  }

  it.each([false, true])(
    'associates and replays a receipt without creating another message or publication (reverse=%s)',
    async (reverse) => {
      expect(await apply(receipt(), reverse)).toEqual([]);
      expect(await apply(receipt(), reverse)).toEqual([]);
      expect(
        await database.db.query.federationMessageReceipt.findMany(),
      ).toMatchObject([
        { namespaceId: mirrorNamespace, threadId, peerSeq: 99, messageId },
      ]);
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
        await database.db.query.federationMessageReceipt.findMany(),
      ).toEqual([]);
      await expectOriginalUnchanged();
    },
  );
});
