import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withMessageDigest } from './support/message-fixture.js';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageDeleteType } from '../src/database/enums.js';
import {
  deletedMessage,
  accountThreadState,
  federatedMessageTombstone,
  fileSyncProgress,
  identityNamespace,
  message,
  messageThread,
  pendingMedia,
  account as user,
  relationshipPair,
} from '../src/database/schema.js';
import { DeletedMessageService } from '../src/message/deleted-message.service.js';
import { ThreadPreviewModule } from '../src/message/thread-preview.module.js';
import { ThreadPreviewService } from '../src/message/thread-preview.service.js';
import { ThreadFeedHeadWriter } from '../src/message/thread-feed-head.writer.js';
import { requireThreadContentLockInTx } from '../src/common/locks/thread-content-lock.js';
import { wirePayloadDigest } from '../src/federation/federated-message-content.js';
import type { FederationMessageFeedMessage } from '../src/federation/federation-message-feed.service.js';
import { FederationInboundMessageValidatorService } from '../src/federation/federation-inbound-message-validator.service.js';
import type { ThreadFanoutTarget } from '../src/message/thread-fanout-task.js';
import { MessageService } from '../src/message/message.service.js';
import { FederationInboundMessageStoreService } from '../src/federation/federation-inbound-message-store.service.js';
import { businessAccountScopeKey } from '../src/common/locks/account-business-lock.js';
import { truncateTablesForTest } from './support/truncate';

describe('federated message deletion transaction ordering', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let deletions: DeletedMessageService;
  let threadId: number;
  let namespaceId: number;

  const peerDomain = 'peer.test';

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule, ThreadPreviewModule],
      providers: [
        DeletedMessageService,
        {
          provide: MessageService,
          useValue: {
            writeSystemMessageInTx: () => ({ message: {} }),
          },
        },
      ],
    }).compile();
    database = mod.get(DatabaseService);
    deletions = mod.get(DeletedMessageService);
  });

  afterAll(async () => mod.close());

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread", "DurableTask" RESTART IDENTITY CASCADE',
    );
    const now = new Date();
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
    namespaceId =
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
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        authorityNamespaceId: namespaceId,
        updatedAt: now,
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
  });

  async function apply(remoteDeletionSeq: number) {
    return deletions.applyFederated({
      threadId,
      messageSeq: 7,
      sourceDomain: peerDomain,
      publisherNamespaceId: namespaceId,
      remoteDeletionSeq,
      type: MessageDeleteType.USER_RETRACTION,
      authority: 'P2P_HOME',
    });
  }

  it.each(['forward', 'reverse', 'media'])(
    'materializes a pending tomb with its message before fanout (%s)',
    async (mode) => {
      const reverse = mode === 'reverse';
      if (reverse)
        await database.db
          .update(messageThread)
          .set({ curSeq: 8 })
          .where(eq(messageThread.id, threadId));
      const [reader] = await database.db
        .insert(user)
        .values({ account: 'page-reader' })
        .returning();
      await database.db.insert(accountThreadState).values({
        accountId: reader.id,
        threadId,
        lastReadSeq: reverse ? 8 : 0,
        updatedAt: new Date(),
      });
      const previews = mod.get(ThreadPreviewService);
      await apply(9);
      expect(
        await database.db.query.durableTask.findMany({
          where: (task, { eq }) => eq(task.taskType, 'FAN_OUT_THREAD_CONTENT'),
        }),
      ).toHaveLength(0);
      const store = new FederationInboundMessageStoreService(
        { assertResponseWritable: async () => undefined } as never,
        {} as never,
        { tickLax: async () => undefined } as never,
        undefined as never, // receipt path unused in this spec
      );
      await database.db.transaction(async (tx) => {
        const results = [];
        for (const originSeq of [7, 8]) {
          const media = mode === 'media' && originSeq === 8;
          const contentType = media ? 'FILE' : 'PURE_TEXT';
          const content = media
            ? JSON.stringify({
                url: `/uploads/msg-assets/aa/aa/${'a'.repeat(64)}`,
                name: 'file.txt',
                size: 1,
                mimeType: 'text/plain',
              })
            : '{"text":"incoming"}';
          const item: FederationMessageFeedMessage = {
            thread: { account: 'bob', peerAccount: reader.account },
            author: { ref: 'THREAD_ACCOUNT', namespaceId: 0 },
            seq: originSeq,
            profileRev: 0,
            originSeq: null,
            originCreatedAt: null,
            createdAt: Date.now(),
            contentType,
            content,
            assets: media ? [{ digest: 'a'.repeat(64), bytes: 1 }] : [],
          };
          const result = await store.store(tx, {
            threadId,
            creator: { account: 'bob', namespaceId: item.author.namespaceId },
            fetchedFromDomain: peerDomain,
            namespaceId,
            profileNamespaceId: item.author.namespaceId,
            message: {
              originSeq,
              profileRev: 0,
              contentType: media ? 'FILE' : 'PURE_TEXT',
              content,
              ts: item.createdAt,
            },
            incomingText: { text: 'incoming' },
            originTime: new Date(item.createdAt),
            payloadDigest: wirePayloadDigest(contentType, content, item.assets),
            federationEnvelopeDigest:
              new FederationInboundMessageValidatorService().immutableEnvelopeDigest(
                item,
              ),
            ...(reverse
              ? {
                  sequencePolicy: {
                    kind: 'MAP_ORIGIN' as const,
                    beforeSeq: 9,
                    throughSeq: 7,
                    messageSeqOffset: 0,
                  },
                }
              : {}),
          });
          expect(result.kind).toBe(media ? 'pending' : 'message');
          const seq =
            result.kind === 'message' ? result.message.seq : result.seq;
          expect(
            await tx.query.message.findFirst({
              where: and(eq(message.threadId, threadId), eq(message.seq, seq)),
            }),
          ).toMatchObject({
            creatorAccount: 'bob',
            publisherNamespaceId: namespaceId,
            profileNamespaceId: 0,
          });
          results.push(seq);
        }
        return results;
      });
      if (!reverse)
        await database.db.transaction(async (tx) => {
          await requireThreadContentLockInTx(tx, threadId);
          const head = await tx.query.messageThread.findFirst({
            where: eq(messageThread.id, threadId),
          });
          await ThreadFeedHeadWriter.advanceInTx(tx, reader.id, {
            threadId,
            messageEndSeq: head!.curSeq,
            tombstoneEndSeq: head!.tombstoneEndSeq,
          });
        });
      const stored = await database.db.transaction((tx) =>
        previews.readInTx(tx, reader.id, threadId, 5),
      );
      expect(stored.map((item) => item.seq)).toEqual(reverse ? [] : [1, 2]);
      if (!reverse) {
        expect(stored[0].deletionType).toBe('USER_RETRACTION');
        expect(stored[0].content).toBeNull();
      }
      expect(
        await database.db.query.federatedMessageTombstone.findMany(),
      ).toHaveLength(0);
      expect(
        (await database.db.query.accountThreadState.findFirst())?.unreadCount,
      ).toBe(reverse ? 0 : 2);
      const queued = await database.db.query.durableTask.findMany({
        where: (task, { eq }) => eq(task.taskType, 'FAN_OUT_THREAD_CONTENT'),
      });
      expect(queued).toHaveLength(reverse ? 0 : 1);
      if (!reverse)
        expect(queued[0].payload).toEqual({
          threadId,
          messageEndSeq: reverse ? 8 : 2,
          tombstoneEndSeq: 1,
        } satisfies ThreadFanoutTarget);
    },
  );

  it('applies group-origin moderation to a peer-confirmed local author without touching another peer copy', async () => {
    await database.db
      .update(messageThread)
      .set({ curSeq: 14 })
      .where(eq(messageThread.id, threadId));
    await database.db.insert(message).values(
      withMessageDigest([
        {
          threadId,
          seq: 14,
          originSeq: 14,
          originServerTime: new Date('2026-09-03T00:00:00.000Z'),
          publisherNamespaceId: 0,
          creatorAccount: 'alice',
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'home original' }),
          payloadDigest: wirePayloadDigest(
            'PURE_TEXT',
            JSON.stringify({ text: 'home original' }),
          ),
          updatedAt: new Date(),
        },
        {
          threadId,
          seq: 13,
          originSeq: 13,
          publisherNamespaceId: namespaceId,
          creatorAccount: 'bob',
          profileNamespaceId: namespaceId,
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'peer copy' }),
          payloadDigest: wirePayloadDigest(
            'PURE_TEXT',
            JSON.stringify({ text: 'peer copy' }),
          ),
          updatedAt: new Date(),
        },
      ]),
    );

    const params = {
      threadId,
      messageSeq: 14,
      sourceDomain: peerDomain,
      publisherNamespaceId: namespaceId,
      remoteDeletionSeq: 2,
      type: MessageDeleteType.MODERATION_REMOVAL,
      authority: 'GROUP_ORIGIN' as const,
    };
    expect(await deletions.applyFederated(params)).toEqual({
      messageSeq: 14,
      deletionSeq: 1,
    });
    expect(await deletions.applyFederated(params)).toBeNull();
    const rows = await database.db.query.message.findMany({
      where: eq(message.threadId, threadId),
    });
    expect(rows.find((row) => row.seq === 14)?.isDeleted).toBe(true);
    expect(rows.find((row) => row.seq === 13)?.isDeleted).toBe(false);
    expect(await database.db.query.deletedMessage.findMany()).toMatchObject([
      {
        messageSeq: 14,
        publisherNamespaceId: namespaceId,
        type: MessageDeleteType.MODERATION_REMOVAL,
      },
    ]);
    expect(
      await database.db.query.federatedMessageTombstone.findMany(),
    ).toEqual([]);
    expect(
      (await database.db.query.durableTask.findMany())
        .map((task) => task.taskType)
        .sort(),
    ).toEqual(['FAN_OUT_FEDERATION_THREAD_CONTENT', 'FAN_OUT_THREAD_CONTENT']);
  });

  it('rejects a member-home submission when the matching copy has a local author', async () => {
    await insertIncoming();
    // A member home may retract only messages it published itself. A confirmed
    // local submission keeps the peer coordinate on a locally published row
    // (publisher 0 with the peer-confirmed originSeq), which the member-home
    // coordinate lookup must not address.
    await database.db
      .update(message)
      .set({
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        originServerTime: new Date('2026-09-03T00:00:00.000Z'),
      })
      .where(eq(message.threadId, threadId));
    await expect(
      deletions.applyFederated({
        threadId,
        messageSeq: 7,
        sourceDomain: peerDomain,
        publisherNamespaceId: namespaceId,
        remoteDeletionSeq: 2,
        type: MessageDeleteType.MODERATION_REMOVAL,
        authority: 'GROUP_MEMBER',
      }),
    ).rejects.toThrow(
      'group origin cannot accept a deletion for an unknown message',
    );
    expect((await database.db.query.message.findFirst())?.isDeleted).toBe(
      false,
    );
    expect(await database.db.query.deletedMessage.findMany()).toEqual([]);
  });

  it('ignores a P2P peer tombstone for a peer-confirmed local author message', async () => {
    await database.db
      .update(messageThread)
      .set({ curSeq: 1 })
      .where(eq(messageThread.id, threadId));
    await database.db.insert(message).values(
      withMessageDigest({
        threadId,
        seq: 1,
        originSeq: 7,
        originServerTime: new Date('2026-09-03T00:00:00.000Z'),
        publisherNamespaceId: 0,
        creatorAccount: 'alice',
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'home' }),
        payloadDigest: wirePayloadDigest(
          'PURE_TEXT',
          JSON.stringify({ text: 'home' }),
        ),
        updatedAt: new Date(),
      }),
    );
    expect(await apply(9)).toBeNull();
    expect(await database.db.query.message.findFirst()).toMatchObject({
      isDeleted: false,
    });
    expect(await database.db.query.deletedMessage.findMany()).toEqual([]);
    expect(
      await database.db.query.federatedMessageTombstone.findMany(),
    ).toEqual([]);
  });

  it('applies a federated tomb using local message coordinates and persists fanout', async () => {
    await insertIncoming();
    const stored = (await database.db.query.message.findMany())[0];
    expect(stored.seq).not.toBe(7);
    const result = await apply(9);
    expect(result?.messageSeq).toBe(stored.seq);
    expect((await database.db.query.deletedMessage.findFirst())?.type).toBe(
      'USER_RETRACTION',
    );
    const tasks = await database.db.query.durableTask.findMany();
    // Both fan-out channels are admitted: the client projection and the
    // federation one coalesce independently on the same thread scope.
    expect(tasks.map(({ taskType }) => taskType).sort()).toEqual([
      'FAN_OUT_FEDERATION_THREAD_CONTENT',
      'FAN_OUT_THREAD_CONTENT',
    ]);
    expect(
      tasks.find(({ taskType }) => taskType === 'FAN_OUT_THREAD_CONTENT')!
        .payload,
    ).toEqual({
      threadId,
      messageEndSeq: stored.seq,
      tombstoneEndSeq: result!.deletionSeq,
    });
    expect(await apply(9)).toBeNull();
    expect(await database.db.query.durableTask.findMany()).toHaveLength(2);
  });

  /** The transaction core used by inbound message storage for the stable identity race.
   * Optional gates let the test prove lock ordering without timing assumptions. */
  async function insertIncoming(gates?: {
    locked: () => void;
    release: Promise<void>;
  }) {
    return database.db.transaction(async (tx) => {
      await DeletedMessageService.lockFederatedIdentity(
        tx,
        threadId,
        peerDomain,
        namespaceId,
        7,
      );
      gates?.locked();
      if (gates) await gates.release;

      const tombstone = await tx.query.federatedMessageTombstone.findFirst({
        where: and(
          eq(federatedMessageTombstone.threadId, threadId),
          eq(federatedMessageTombstone.publisherNamespaceId, namespaceId),
          eq(federatedMessageTombstone.messageSeq, 7),
        ),
        columns: { type: true, publisherNamespaceId: true },
      });
      const [{ curSeq: seq }] = await tx
        .update(messageThread)
        .set({ curSeq: sql`${messageThread.curSeq} + 1` })
        .where(eq(messageThread.id, threadId))
        .returning({ curSeq: messageThread.curSeq });
      const [created] = await tx
        .insert(message)
        .values(
          withMessageDigest({
            threadId,
            creatorAccount: 'bob',
            profileNamespaceId: namespaceId,
            originSeq: 7,
            publisherNamespaceId: namespaceId,
            seq,
            contentType: 'PURE_TEXT',
            content: JSON.stringify({ text: 'federated' }),
            payloadDigest: wirePayloadDigest(
              'PURE_TEXT',
              JSON.stringify({ text: 'federated' }),
            ),
            isDeleted: tombstone !== undefined,
            updatedAt: new Date(),
          }),
        )
        .returning({ seq: message.seq, isDeleted: message.isDeleted });
      if (tombstone) {
        await DeletedMessageService.ensureFactInTx(tx, {
          threadId,
          messageSeq: seq,
          type: tombstone.type,
          publisherNamespaceId: tombstone.publisherNamespaceId,
          updatedAt: new Date(),
        });
        await tx
          .delete(federatedMessageTombstone)
          .where(
            and(
              eq(federatedMessageTombstone.threadId, threadId),
              eq(federatedMessageTombstone.publisherNamespaceId, namespaceId),
              eq(federatedMessageTombstone.messageSeq, 7),
            ),
          );
      }
      return created;
    });
  }

  async function persistedState() {
    const stored = await database.db.query.message.findFirst({
      where: and(
        eq(message.threadId, threadId),
        eq(message.creatorAccount, 'bob'),
        eq(message.publisherNamespaceId, namespaceId),
        eq(message.originSeq, 7),
      ),
      columns: { seq: true, isDeleted: true },
    });
    const tombstones = await database.db
      .select()
      .from(federatedMessageTombstone)
      .where(
        and(
          eq(federatedMessageTombstone.threadId, threadId),
          eq(federatedMessageTombstone.publisherNamespaceId, namespaceId),
        ),
      );
    const logs = await database.db
      .select()
      .from(deletedMessage)
      .where(
        and(
          eq(deletedMessage.threadId, threadId),
          eq(deletedMessage.publisherNamespaceId, namespaceId),
        ),
      );
    return { stored, tombstones, logs };
  }

  it('allocates deletion coordinates per thread without gaps on concurrent retries', async () => {
    const allocate = (targetMessageSeq: number) =>
      database.db.transaction((tx) =>
        DeletedMessageService.ensureFactInTx(tx, {
          threadId,
          messageSeq: targetMessageSeq,
          type: MessageDeleteType.USER_RETRACTION,
        }),
      );

    const retryResults = await Promise.all([allocate(7), allocate(7)]);
    expect(retryResults.map((result) => result.deletionSeq)).toEqual([1, 1]);
    expect(retryResults.map((result) => result.created).sort()).toEqual([
      false,
      true,
    ]);
    await expect(allocate(9)).resolves.toEqual({
      deletionSeq: 2,
      created: true,
    });

    const [otherThread] = await database.db
      .insert(messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning({ id: messageThread.id });
    await expect(
      database.db.transaction((tx) =>
        DeletedMessageService.ensureFactInTx(tx, {
          threadId: otherThread.id,
          messageSeq: 4,
          type: MessageDeleteType.MODERATION_REMOVAL,
        }),
      ),
    ).resolves.toEqual({ deletionSeq: 1, created: true });

    const [firstAllocator, secondAllocator] = await Promise.all([
      database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, threadId),
        columns: { tombstoneEndSeq: true },
      }),
      database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, otherThread.id),
        columns: { tombstoneEndSeq: true },
      }),
    ]);
    expect(firstAllocator?.tombstoneEndSeq).toBe(2);
    expect(secondAllocator?.tombstoneEndSeq).toBe(1);
  });

  it('stores local deletion facts in namespace zero', async () => {
    await database.db.transaction((tx) =>
      DeletedMessageService.ensureFactInTx(tx, {
        threadId,
        messageSeq: 7,
        type: MessageDeleteType.USER_RETRACTION,
      }),
    );

    const fact = await database.db.query.deletedMessage.findFirst({
      where: eq(deletedMessage.threadId, threadId),
      columns: { publisherNamespaceId: true },
    });
    expect(fact?.publisherNamespaceId).toBe(0);
  });

  it('allows a newly sent local message without an origin sequence', async () => {
    await expect(
      database.db.insert(message).values(
        withMessageDigest({
          threadId,
          seq: 1,
          creatorAccount: 'alice',
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'local provisional coordinate' }),
          payloadDigest: wirePayloadDigest(
            'PURE_TEXT',
            JSON.stringify({ text: 'local provisional coordinate' }),
          ),
          updatedAt: new Date(),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('commits withdrawal facts and fanout atomically, including rollback', async () => {
    const [author] = await database.db
      .insert(user)
      .values({ account: 'withdraw-author' })
      .returning();
    await database.db
      .update(messageThread)
      .set({ curSeq: 1 })
      .where(eq(messageThread.id, threadId));
    await database.db.insert(message).values(
      withMessageDigest({
        threadId,
        seq: 1,
        creatorAccount: author.account,
        contentType: 'PURE_TEXT',
        content: '{"text":"withdraw"}',
        payloadDigest: wirePayloadDigest('PURE_TEXT', '{"text":"withdraw"}'),
        updatedAt: new Date(),
      }),
    );
    await expect(
      deletions.withdraw(author.id, threadId, 1, async () => {
        throw new Error('quota rollback');
      }),
    ).rejects.toThrow('quota rollback');
    expect((await database.db.query.message.findFirst())?.isDeleted).toBe(
      false,
    );
    expect(await database.db.query.durableTask.findMany()).toHaveLength(0);
    expect(await database.db.query.deletedMessage.findMany()).toHaveLength(0);

    await deletions.withdraw(author.id, threadId, 1);
    expect((await database.db.query.message.findFirst())?.isDeleted).toBe(true);
    expect((await database.db.query.deletedMessage.findFirst())?.type).toBe(
      'USER_RETRACTION',
    );
    const tasks = await database.db.query.durableTask.findMany();
    expect(tasks.map(({ taskType }) => taskType).sort()).toEqual([
      'FAN_OUT_FEDERATION_THREAD_CONTENT',
      'FAN_OUT_THREAD_CONTENT',
    ]);
    expect(
      tasks.find(({ taskType }) => taskType === 'FAN_OUT_THREAD_CONTENT')!
        .payload,
    ).toEqual({
      threadId,
      messageEndSeq: 1,
      tombstoneEndSeq: 1,
    });
    await deletions.withdraw(author.id, threadId, 1);
    expect(await database.db.query.durableTask.findMany()).toHaveLength(2);
    expect(await database.db.query.deletedMessage.findMany()).toHaveLength(1);
  });

  it.each(['GROUP', 'P2P'] as const)(
    '%s withdrawal waits for the business scope before locking content',
    async (kind) => {
      const [author] = await database.db
        .insert(user)
        .values({
          account: 'alice',
          namespaceId: 0,
          updatedAt: new Date(),
        })
        .returning();
      // lockThreadContentInTx keys the business scope by profileNamespaceId
      // (GROUP: authorityNamespaceId, P2P: the pair endpoint namespaceId), so
      // the held advisory lock must use the same coordinate to actually block
      // the withdrawal before it reaches the thread/message row locks.
      let scope = { account: author.account, profileNamespaceId: 0 };
      if (kind === 'GROUP') {
        await database.db
          .update(messageThread)
          .set({
            type: 'GROUP',
            groupAccount: '!lock-parent',
          })
          .where(eq(messageThread.id, threadId));
        scope = { account: '!lock-parent', profileNamespaceId: namespaceId };
      } else {
        await database.db.insert(relationshipPair).values({
          kind: 'P2P',
          threadId,
          active: true,
          endpointAType: 'USER',
          endpointAAccount: author.account,
          endpointANamespaceId: 0,
          endpointBType: 'USER',
          endpointBAccount: 'bob',
          endpointBNamespaceId: namespaceId,
        });
      }
      await database.db.insert(message).values(
        withMessageDigest({
          threadId,
          seq: 1,
          creatorAccount: author.account,
          contentType: 'PURE_TEXT',
          content: '{"text":"business ordering"}',
          payloadDigest: wirePayloadDigest(
            'PURE_TEXT',
            '{"text":"business ordering"}',
          ),
          updatedAt: new Date(),
        }),
      );
      const blocker = await database.pool.connect();
      let result: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        const {
          rows: [session],
        } = await blocker.query('SELECT pg_backend_pid() AS pid');
        await blocker.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [businessAccountScopeKey(scope)],
        );
        result = deletions.withdraw(author.id, threadId, 1).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const deadline = Date.now() + 5000;
        for (;;) {
          const { rows } = await database.pool.query(
            'SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
            [session.pid],
          );
          if (rows.length) break;
          if (Date.now() >= deadline)
            throw new Error('withdrawal bypassed the business scope');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // The blocked withdrawal must not have acquired the thread or message yet.
        await blocker.query(
          'SELECT id FROM "MessageThread" WHERE id=$1 FOR UPDATE NOWAIT',
          [threadId],
        );
        await blocker.query(
          'SELECT id FROM "Message" WHERE "threadId"=$1 FOR UPDATE NOWAIT',
          [threadId],
        );
        await blocker.query('COMMIT');
        expect(await result).toMatchObject({
          value: { deletionSeq: 1, messageSeq: 1 },
        });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await result;
      }
    },
  );

  it.each(['withdrawal', 'moderation'] as const)(
    'orders %s behind a receipt transaction without locking its message first',
    async (mode) => {
      await database.db
        .update(messageThread)
        .set({ curSeq: 1 })
        .where(eq(messageThread.id, threadId));
      const [author] = await database.db
        .insert(user)
        .values({
          account: 'alice',
          namespaceId: 0,
          updatedAt: new Date(),
        })
        .returning();
      const [sent] = await database.db
        .insert(message)
        .values(
          withMessageDigest({
            threadId,
            seq: 1,
            creatorAccount: author.account,
            contentType: 'PURE_TEXT',
            content: '{"text":"withdraw concurrently"}',
            originSeq: 1,
            payloadDigest: wirePayloadDigest(
              'PURE_TEXT',
              '{"text":"withdraw concurrently"}',
            ),
            updatedAt: new Date(),
          }),
        )
        .returning();
      const receipt = await database.pool.connect();
      let withdrawing: Promise<unknown> | undefined;
      try {
        await receipt.query('BEGIN');
        await receipt.query("SET LOCAL lock_timeout = '5s'");
        const {
          rows: [session],
        } = await receipt.query('SELECT pg_backend_pid() AS pid');
        await receipt.query(
          'SELECT id FROM "MessageThread" WHERE id = $1 FOR UPDATE',
          [threadId],
        );
        // Observe the actual lock wait before inserting the receipt. This forces the
        // inversion on the old implementation without relying on scheduler timing.
        const deleting =
          mode === 'withdrawal'
            ? deletions.withdraw(author.id, threadId, 1)
            : database.db.transaction(async (tx) => ({
                deletionSeq: await deletions.deleteByModerationInTx(
                  tx,
                  threadId,
                  1,
                ),
                messageSeq: 1,
              }));
        withdrawing = deleting.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const deadline = Date.now() + 5000;
        for (;;) {
          const { rows } = await database.pool.query(
            'SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
            [session.pid],
          );
          if (rows.length) break;
          if (Date.now() >= deadline)
            throw new Error('withdrawal did not wait for the thread lock');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await receipt.query('SELECT 1');
        await receipt.query('COMMIT');
        expect(await withdrawing).toMatchObject({
          value: { deletionSeq: 1, messageSeq: 1 },
        });
        const threadAfterDeletion =
          await database.db.query.messageThread.findFirst({
            where: eq(messageThread.id, threadId),
          });
        expect(threadAfterDeletion?.curSeq).toBe(1);
        const remainingRows = await database.db.query.message.findMany({
          where: eq(message.threadId, threadId),
        });
        expect(remainingRows).toHaveLength(1);
        expect(
          await database.db.query.message.findFirst({
            where: eq(message.id, sent.id),
          }),
        ).toMatchObject({
          isDeleted: true,
          originSeq: 1,
          originServerTime: null,
        });
        if (mode === 'withdrawal')
          expect(
            await deletions.withdraw(author.id, threadId, 1),
          ).toMatchObject({ deletionSeq: 1 });
      } finally {
        await receipt.query('ROLLBACK');
        receipt.release();
        await withdrawing;
      }
    },
  );

  it('rejects a remote message without an origin sequence', async () => {
    await expect(
      database.db.insert(message).values(
        withMessageDigest({
          threadId,
          seq: 1,
          creatorAccount: 'bob',
          profileNamespaceId: namespaceId,
          publisherNamespaceId: namespaceId,
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'missing coordinate' }),
          payloadDigest: wirePayloadDigest(
            'PURE_TEXT',
            JSON.stringify({ text: 'missing coordinate' }),
          ),
          updatedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('keeps a later-arriving message deleted when the tombstone committed first', async () => {
    expect(await apply(10)).toBeNull();
    expect(await insertIncoming()).toMatchObject({ isDeleted: true });

    const state = await persistedState();
    expect(state.stored?.isDeleted).toBe(true);
    expect(state.tombstones).toHaveLength(0);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.messageSeq).toBe(state.stored?.seq);
    expect(state.logs[0]?.deletionSeq).toBe(1);
  });

  it('serializes a deletion behind an in-progress message insert and converges to deleted', async () => {
    let announceLocked!: () => void;
    let releaseInsert!: () => void;
    const locked = new Promise<void>((resolve) => (announceLocked = resolve));
    const release = new Promise<void>((resolve) => (releaseInsert = resolve));

    const inserting = insertIncoming({ locked: announceLocked, release });
    await locked;
    const deleting = apply(11);
    // The delete is now allowed to contend for the same advisory lock; releasing the holder establishes
    // the message-before-delete order without relying on a sleep or scheduler timing.
    releaseInsert();
    await expect(inserting).resolves.toMatchObject({ isDeleted: false });
    await expect(deleting).resolves.toMatchObject({
      deletionSeq: 1,
      messageSeq: 1,
    });

    const state = await persistedState();
    expect(state.stored?.isDeleted).toBe(true);
    expect(state.tombstones).toHaveLength(0);
    expect(state.logs).toHaveLength(1);
  });

  it('is idempotent when an older tombstone arrives after a newer one', async () => {
    await insertIncoming();
    await apply(12);
    await apply(11);

    const state = await persistedState();
    expect(state.stored?.isDeleted).toBe(true);
    expect(state.tombstones).toHaveLength(0);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.deletionSeq).toBe(1);
  });

  it('turns a tombstoned STUB into a formal deletion and cancels its download', async () => {
    const [stub] = await database.db
      .insert(message)
      .values(
        withMessageDigest({
          threadId,
          seq: 1,
          creatorAccount: 'bob',
          profileNamespaceId: namespaceId,
          contentType: 'IMAGE',
          content: JSON.stringify({
            url: `/uploads/msg-assets/aa/aa/${'a'.repeat(64)}`,
            name: 'pending.png',
            w: 1,
            h: 1,
          }),
          originSeq: 7,
          publisherNamespaceId: namespaceId,
          localState: 'STUB',
          updatedAt: new Date(),
        }),
      )
      .returning({ id: message.id });
    const [pending] = await database.db
      .insert(pendingMedia)
      .values({
        messageId: stub.id,
        direction: 'INBOUND',
        fileCnt: 1,
        originDomain: peerDomain,
        publisherNamespaceId: namespaceId,
        expectedAuthorizationEpoch: 0,
        updatedAt: new Date(),
      })
      .returning({ batchId: pendingMedia.batchId });
    await database.db.insert(fileSyncProgress).values({
      batchId: pending.batchId,
      digest: 'a'.repeat(64),
      kind: 'IMAGE',
      status: 'DOWNLOADING',
      bytesTotal: 100n,
      bytesReceived: 40n,
      originDomain: peerDomain,
      publisherNamespaceId: namespaceId,
    });

    await apply(13);

    const retained = await database.db.query.pendingMedia.findFirst({
      where: eq(pendingMedia.batchId, pending.batchId),
    });
    const progress = await database.db
      .select()
      .from(fileSyncProgress)
      .where(eq(fileSyncProgress.batchId, pending.batchId));
    expect(retained).toBeUndefined();
    expect(progress).toEqual([]);
    await expect(
      database.db.query.message.findFirst({
        where: eq(message.id, stub.id),
      }),
    ).resolves.toMatchObject({
      localState: 'STUB',
      isDeleted: true,
    });
    const facts = await database.db
      .select()
      .from(deletedMessage)
      .where(eq(deletedMessage.threadId, threadId));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ messageSeq: 1, deletionSeq: 1 });
  });
});
