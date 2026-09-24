import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageDeleteType } from '../src/database/enums.js';
import * as tables from '../src/database/schema.js';
import { FederationInboundMessageCommitService } from '../src/federation/federation-inbound-message-commit.service.js';
import { FederationInboundMessageRouteService } from '../src/federation/federation-inbound-message-route.service.js';
import { FederationNamespaceService } from '../src/federation/federation-namespace.service.js';
import { FederationThreadAccessService } from '../src/federation/federation-thread-access.service.js';
import { DeletedMessageService } from '../src/message/deleted-message.service.js';
import { MessageService } from '../src/message/message.service.js';
import { ThreadPreviewModule } from '../src/message/thread-preview.module.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { truncateTablesForTest } from './support/truncate';

describe('member-home tombstone authority', () => {
  const peerDomain = 'member-tombstone.test';
  const groupAccount = '!tombstonegroup';
  let module: TestingModule;
  let database: DatabaseService;
  let commit: FederationInboundMessageCommitService;
  let namespaces: FederationNamespaceService;
  let threadId: number;
  let namespaceId: number;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule, ThreadPreviewModule],
      providers: [
        DeletedMessageService,
        { provide: MessageService, useValue: {} },
      ],
    }).compile();
    database = module.get(DatabaseService);
    namespaces = new FederationNamespaceService(database);
    commit = new FederationInboundMessageCommitService(
      database,
      new FederationThreadAccessService(database, namespaces),
      undefined as never,
      new FederationInboundMessageRouteService(),
      module.get(DeletedMessageService),
      undefined as never,
    );
  });

  afterAll(async () => module.close());

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread", "FederatedPeer", "DurableTask" RESTART IDENTITY CASCADE',
    );
    namespaceId = await seedFederatedPeerNamespace(database.db, peerDomain);
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
        updatedAt: new Date(),
      })
      .returning();
    threadId = thread.id;
    await database.db.insert(tables.relationshipPair).values({
      kind: 'GROUP_MEMBER',
      endpointAType: 'GROUP',
      endpointAAccount: groupAccount,
      endpointADomain: 'local',
      endpointANamespaceId: namespaceId,
      endpointBType: 'USER',
      endpointBAccount: 'alice',
      endpointBDomain: peerDomain,
      endpointBNamespaceId: namespaceId,
      threadId,
      active: true,
    });
    await database.db.insert(tables.message).values({
      threadId,
      seq: 42,
      originSeq: 7,
      originServerTime: new Date(),
      sourceNamespaceId: namespaceId,
      creatorAccount: 'alice',
      creatorDomain: peerDomain,
      creatorNamespaceId: namespaceId,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'member submission' }),
      updatedAt: new Date(),
    });
  });

  async function apply(type: MessageDeleteType) {
    const peerToken = await namespaces.captureActive(peerDomain);
    return database.db.transaction((tx) =>
      commit.applyTombstonesInTransaction(tx, {
        response: {
          threadId,
          peerDomain,
          peerToken,
          federationVersion: 0,
          data: {
            tombstones: [
              {
                thread: { account: groupAccount },
                deletionSeq: 3,
                messageSeq: 7,
                type,
                deletedAt: 1700000000000,
              },
            ],
            scannedThrough: 3,
            hasMore: false,
          },
        },
        frozenTargetSeq: 3,
      }),
    );
  }

  it.each([
    MessageDeleteType.USER_RETRACTION,
    MessageDeleteType.MODERATION_REMOVAL,
  ])(
    'accepts %s for the member home and translates it into one origin fact',
    async (type) => {
      const first = await apply(type);
      expect(first.deletions).toEqual([{ messageSeq: 42, deletionSeq: 1 }]);
      const replay = await apply(type);
      expect(replay.deletions).toEqual([]);
      const target = await database.db.query.message.findFirst({
        where: and(
          eq(tables.message.threadId, threadId),
          eq(tables.message.seq, 42),
        ),
      });
      expect(target?.isDeleted).toBe(true);
      const facts = await database.db.query.deletedMessage.findMany({
        where: eq(tables.deletedMessage.threadId, threadId),
      });
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        messageSeq: 42,
        sourceNamespaceId: 0,
        type,
      });
    },
  );

  it.each([
    MessageDeleteType.USER_RETRACTION,
    MessageDeleteType.MODERATION_REMOVAL,
  ])(
    'ignores a group-origin retraction of a local author but accepts origin moderation',
    async (type) => {
      await database.db
        .update(tables.messageThread)
        .set({
          groupDomain: peerDomain,
          authorityNamespaceId: namespaceId,
          groupAccountId: null,
        })
        .where(eq(tables.messageThread.id, threadId));
      const [local] = await database.db
        .update(tables.message)
        .set({
          sourceNamespaceId: 0,
          creatorDomain: 'local',
          creatorNamespaceId: 0,
          originSeq: null,
        })
        .where(eq(tables.message.threadId, threadId))
        .returning({ id: tables.message.id });
      await database.db.insert(tables.federationMessageReceipt).values({
        threadId,
        namespaceId,
        peerSeq: 7,
        messageId: local.id,
      });
      const first = await apply(type);
      const row = await database.db.query.message.findFirst({
        where: eq(tables.message.threadId, threadId),
      });
      const facts = await database.db.query.deletedMessage.findMany();
      if (type === MessageDeleteType.USER_RETRACTION) {
        expect(first.deletions).toEqual([]);
        expect(row?.isDeleted).toBe(false);
        expect(facts).toEqual([]);
      } else {
        expect(first.deletions).toEqual([{ messageSeq: 42, deletionSeq: 1 }]);
        expect(row?.isDeleted).toBe(true);
        expect(facts).toMatchObject([
          { messageSeq: 42, type, sourceNamespaceId: namespaceId },
        ]);
        expect((await apply(type)).deletions).toEqual([]);
      }
      expect(
        await database.db.query.federatedMessageTombstone.findMany(),
      ).toEqual([]);
    },
  );

  it('keeps the first local deletion type when origin moderation arrives later', async () => {
    await database.db
      .update(tables.messageThread)
      .set({
        groupDomain: peerDomain,
        authorityNamespaceId: namespaceId,
        groupAccountId: null,
        tombstoneEndSeq: 1,
      })
      .where(eq(tables.messageThread.id, threadId));
    const [local] = await database.db
      .update(tables.message)
      .set({
        sourceNamespaceId: 0,
        creatorDomain: 'local',
        creatorNamespaceId: 0,
        originSeq: null,
        isDeleted: true,
      })
      .where(eq(tables.message.threadId, threadId))
      .returning({ id: tables.message.id });
    await database.db.insert(tables.federationMessageReceipt).values({
      threadId,
      namespaceId,
      peerSeq: 7,
      messageId: local.id,
    });
    await database.db.insert(tables.deletedMessage).values({
      threadId,
      messageSeq: 42,
      deletionSeq: 1,
      type: MessageDeleteType.USER_RETRACTION,
      sourceNamespaceId: 0,
      updatedAt: new Date(),
    });
    expect(
      (await apply(MessageDeleteType.MODERATION_REMOVAL)).deletions,
    ).toEqual([]);
    expect(await database.db.query.deletedMessage.findMany()).toMatchObject([
      {
        messageSeq: 42,
        type: MessageDeleteType.USER_RETRACTION,
        sourceNamespaceId: 0,
      },
    ]);
    expect(
      await database.db.query.federatedMessageTombstone.findMany(),
    ).toEqual([]);
  });

  it.each([
    MessageDeleteType.USER_RETRACTION,
    MessageDeleteType.MODERATION_REMOVAL,
  ])(
    'resolves pending origin %s when the local-author receipt arrives later',
    async (type) => {
      await database.db
        .update(tables.messageThread)
        .set({
          groupDomain: peerDomain,
          authorityNamespaceId: namespaceId,
          groupAccountId: null,
        })
        .where(eq(tables.messageThread.id, threadId));
      const [local] = await database.db
        .update(tables.message)
        .set({
          sourceNamespaceId: 0,
          creatorDomain: 'local',
          creatorNamespaceId: 0,
          originSeq: null,
        })
        .where(eq(tables.message.threadId, threadId))
        .returning({ id: tables.message.id });
      expect((await apply(type)).deletions).toEqual([]);
      expect(
        await database.db.query.federatedMessageTombstone.findMany(),
      ).toHaveLength(1);
      await database.db.transaction(async (tx) => {
        await tx.insert(tables.federationMessageReceipt).values({
          threadId,
          namespaceId,
          peerSeq: 7,
          messageId: local.id,
        });
        await module.get(DeletedMessageService).applyPendingReceiptInTx(tx, {
          threadId,
          peerSeq: 7,
          peerDomain,
          namespaceId,
          authority: 'GROUP_ORIGIN',
          expectedFederationVersion: 0,
        });
      });
      expect(
        await database.db.query.message.findFirst({
          where: eq(tables.message.threadId, threadId),
        }),
      ).toMatchObject({
        isDeleted: type === MessageDeleteType.MODERATION_REMOVAL,
        seq: 42,
      });
      expect(
        await database.db.query.federatedMessageTombstone.findMany(),
      ).toEqual([]);
      const facts = await database.db.query.deletedMessage.findMany();
      if (type === MessageDeleteType.USER_RETRACTION) {
        expect(facts).toEqual([]);
      } else {
        expect(facts).toMatchObject([
          { messageSeq: 42, type, sourceNamespaceId: namespaceId },
        ]);
      }
    },
  );

  it.each([
    MessageDeleteType.USER_RETRACTION,
    MessageDeleteType.MODERATION_REMOVAL,
  ])(
    'rejects %s for a foreign author even at a known source coordinate',
    async (type) => {
      await database.db
        .update(tables.message)
        .set({ creatorDomain: 'local', creatorNamespaceId: 0 })
        .where(eq(tables.message.threadId, threadId));
      await expect(apply(type)).rejects.toThrow(
        'tombstone has no retained local group thread',
      );
      const facts = await database.db.query.deletedMessage.findMany({
        where: eq(tables.deletedMessage.threadId, threadId),
      });
      expect(facts).toEqual([]);
      const target = await database.db.query.message.findFirst({
        where: eq(tables.message.threadId, threadId),
      });
      expect(target?.isDeleted).toBe(false);
    },
  );
});
