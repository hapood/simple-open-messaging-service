import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MessageDeleteType } from '../src/database/enums.js';
import {
  deletedMessage,
  accountThreadState,
  federatedMessageTombstone,
  federatedPeer,
  federationDeletedCursor,
  federationMessageReceipt,
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
import { requireThreadContentLockInTx } from '../src/relationship/thread-content-lock.js';
import { MessageService } from '../src/message/message.service.js';
import { FederationInboundMessageStoreService } from '../src/federation/federation-inbound-message-store.service.js';
import { businessAccountScopeKey } from '../src/relationship/business-scope-lock.js';

describe('federated message deletion transaction ordering', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let deletions: DeletedMessageService;
  let threadId: number;
  let namespaceId: number;

  const peerDomain = 'peer.test';
  const cursor = () => ({
    peerDomain,
    namespaceId,
    streamAccount: 'bob',
    streamKind: 'p2p-author',
  });

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
    await database.pool.query(
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread", "FederatedPeer", "DurableTask" RESTART IDENTITY CASCADE',
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
            rootKeyFingerprint: 'sha256:deleted-message-test',
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
      sourceNamespaceId: namespaceId,
      remoteDeletionSeq,
      type: MessageDeleteType.USER_RETRACTION,
      cursor: cursor(),
      expectedFederationVersion: 0,
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
      );
      await database.db.transaction(async (tx) => {
        const results = [];
        for (const originSeq of [7, 8]) {
          const media = mode === 'media' && originSeq === 8;
          const result = await store.store(tx, {
            threadId,
            creator: { account: 'bob', domain: peerDomain },
            fetchedFromDomain: peerDomain,
            namespaceId,
            message: {
              originSeq,
              profileRev: 0,
              clientMessageId: null,
              contentType: media ? 'FILE' : 'PURE_TEXT',
              content: media
                ? JSON.stringify({
                    url: `/uploads/msg-assets/aa/aa/${'a'.repeat(64)}`,
                    name: 'file.txt',
                    size: 1,
                    mimeType: 'text/plain',
                  })
                : '{"text":"incoming"}',
              ts: Date.now(),
            },
            incomingText: { text: 'incoming' },
            expectedFederationVersion: 0,
            originTime: new Date(),
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
          results.push(
            result.kind === 'message' ? result.message.seq : result.seq,
          );
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
            tombstoneEndSeq: head!.deletionSeqAllocatedThrough,
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
        });
    },
  );

  it('applies a federated tomb using local message coordinates and persists fanout with its cursor', async () => {
    await insertIncoming();
    const stored = (await database.db.query.message.findMany())[0];
    expect(stored.seq).not.toBe(7);
    const result = await apply(9);
    expect(result?.messageSeq).toBe(stored.seq);
    expect((await database.db.query.deletedMessage.findFirst())?.type).toBe(
      'USER_RETRACTION',
    );
    const tasks = await database.db.query.durableTask.findMany();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload).toEqual({
      threadId,
      messageEndSeq: stored.seq,
      tombstoneEndSeq: result!.deletionSeq,
    });
    const cursors = await database.db.query.federationDeletedCursor.findMany();
    expect(cursors[0].committedThrough).toBe(9);
    expect(await apply(9)).toBeNull();
    expect(await database.db.query.durableTask.findMany()).toHaveLength(1);
  });

  /** The transaction core used by FederationService.storePulledMessage for the stable identity race.
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
          eq(federatedMessageTombstone.sourceNamespaceId, namespaceId),
          eq(federatedMessageTombstone.messageSeq, 7),
        ),
        columns: { type: true, sourceNamespaceId: true },
      });
      const [{ curSeq: seq }] = await tx
        .update(messageThread)
        .set({ curSeq: sql`${messageThread.curSeq} + 1` })
        .where(eq(messageThread.id, threadId))
        .returning({ curSeq: messageThread.curSeq });
      const [created] = await tx
        .insert(message)
        .values({
          threadId,
          creatorAccount: 'bob',
          creatorDomain: peerDomain,
          creatorNamespaceId: namespaceId,
          originSeq: 7,
          sourceNamespaceId: namespaceId,
          seq,
          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'federated' }),
          isDeleted: tombstone !== undefined,
          updatedAt: new Date(),
        })
        .returning({ seq: message.seq, isDeleted: message.isDeleted });
      if (tombstone) {
        await DeletedMessageService.ensureFactInTx(tx, {
          threadId,
          messageSeq: seq,
          type: tombstone.type,
          sourceNamespaceId: tombstone.sourceNamespaceId,
          updatedAt: new Date(),
        });
        await tx
          .delete(federatedMessageTombstone)
          .where(
            and(
              eq(federatedMessageTombstone.threadId, threadId),
              eq(federatedMessageTombstone.sourceNamespaceId, namespaceId),
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
        eq(message.creatorDomain, peerDomain),
        eq(message.sourceNamespaceId, namespaceId),
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
          eq(federatedMessageTombstone.sourceNamespaceId, namespaceId),
        ),
      );
    const logs = await database.db
      .select()
      .from(deletedMessage)
      .where(
        and(
          eq(deletedMessage.threadId, threadId),
          eq(deletedMessage.sourceNamespaceId, namespaceId),
        ),
      );
    const storedCursor =
      await database.db.query.federationDeletedCursor.findFirst({
        where: and(
          eq(federationDeletedCursor.threadId, threadId),
          eq(federationDeletedCursor.namespaceId, namespaceId),
        ),
        columns: { committedThrough: true },
      });
    return { stored, tombstones, logs, cursor: storedCursor };
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
        columns: { deletionSeqAllocatedThrough: true },
      }),
      database.db.query.messageThread.findFirst({
        where: eq(messageThread.id, otherThread.id),
        columns: { deletionSeqAllocatedThrough: true },
      }),
    ]);
    expect(firstAllocator?.deletionSeqAllocatedThrough).toBe(2);
    expect(secondAllocator?.deletionSeqAllocatedThrough).toBe(1);
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
      columns: { sourceNamespaceId: true },
    });
    expect(fact?.sourceNamespaceId).toBe(0);
  });

  it('allows a newly sent local message without an origin sequence', async () => {
    await expect(
      database.db.insert(message).values({
        threadId,
        seq: 1,
        creatorAccount: 'alice',
        creatorDomain: 'local',
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'local provisional coordinate' }),
        updatedAt: new Date(),
      }),
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
    await database.db.insert(message).values({
      threadId,
      seq: 1,
      creatorAccount: author.account,
      creatorDomain: 'local',
      contentType: 'PURE_TEXT',
      content: '{"text":"withdraw"}',
      updatedAt: new Date(),
    });
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
    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload).toEqual({
      threadId,
      messageEndSeq: 1,
      tombstoneEndSeq: 1,
    });
    await deletions.withdraw(author.id, threadId, 1);
    expect(await database.db.query.durableTask.findMany()).toHaveLength(1);
    expect(await database.db.query.deletedMessage.findMany()).toHaveLength(1);
  });

  it.each(['GROUP', 'P2P'] as const)(
    '%s withdrawal waits for the business scope before locking content',
    async (kind) => {
      const [author] = await database.db
        .insert(user)
        .values({
          account: 'alice',
          domain: 'local',
          namespaceId: 0,
          updatedAt: new Date(),
        })
        .returning();
      let scope = { account: author.account, domain: author.domain };
      if (kind === 'GROUP') {
        await database.db
          .update(messageThread)
          .set({
            type: 'GROUP',
            groupAccount: '!lock-parent',
            groupDomain: peerDomain,
          })
          .where(eq(messageThread.id, threadId));
        scope = { account: '!lock-parent', domain: peerDomain };
      } else {
        await database.db.insert(relationshipPair).values({
          kind: 'P2P',
          threadId,
          active: true,
          endpointAType: 'USER',
          endpointAAccount: author.account,
          endpointADomain: 'local',
          endpointANamespaceId: namespaceId,
          endpointBType: 'USER',
          endpointBAccount: 'bob',
          endpointBDomain: peerDomain,
          endpointBNamespaceId: namespaceId,
        });
      }
      await database.db.insert(message).values({
        threadId,
        seq: 1,
        creatorAccount: author.account,
        creatorDomain: 'local',
        contentType: 'PURE_TEXT',
        content: '{"text":"business ordering"}',
        updatedAt: new Date(),
      });
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
          domain: 'local',
          namespaceId: 0,
          updatedAt: new Date(),
        })
        .returning();
      const [sent] = await database.db
        .insert(message)
        .values({
          threadId,
          seq: 1,
          creatorAccount: author.account,
          creatorDomain: 'local',
          contentType: 'PURE_TEXT',
          content: '{"text":"withdraw concurrently"}',
          updatedAt: new Date(),
        })
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
        await receipt.query(
          'INSERT INTO "FederationMessageReceipt" ("namespaceId", "threadId", "peerSeq", "messageId") VALUES ($1, $2, $3, $4)',
          [namespaceId, threadId, 7, sent.id.toString()],
        );
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
        ).toMatchObject({ isDeleted: true });
        expect(
          await database.db
            .select()
            .from(federationMessageReceipt)
            .where(eq(federationMessageReceipt.messageId, sent.id)),
        ).toHaveLength(1);
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
      database.db.insert(message).values({
        threadId,
        seq: 1,
        creatorAccount: 'bob',
        creatorDomain: peerDomain,
        creatorNamespaceId: namespaceId,
        sourceNamespaceId: namespaceId,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'missing coordinate' }),
        updatedAt: new Date(),
      }),
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
    expect(state.cursor?.committedThrough).toBe(10);
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
    expect(state.cursor?.committedThrough).toBe(11);
  });

  it('is idempotent and never regresses the remote deletion HWM', async () => {
    await insertIncoming();
    await apply(12);
    await apply(11);

    const state = await persistedState();
    expect(state.stored?.isDeleted).toBe(true);
    expect(state.tombstones).toHaveLength(0);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.deletionSeq).toBe(1);
    expect(state.cursor?.committedThrough).toBe(12);
  });

  it('turns a tombstoned STUB into a formal deletion and cancels its download', async () => {
    const [stub] = await database.db
      .insert(message)
      .values({
        threadId,
        seq: 1,
        creatorAccount: 'bob',
        creatorDomain: peerDomain,
        creatorNamespaceId: namespaceId,
        contentType: 'IMAGE',
        content: JSON.stringify({ digest: 'a'.repeat(64) }),
        originSeq: 7,
        sourceNamespaceId: namespaceId,
        localState: 'STUB',
        updatedAt: new Date(),
      })
      .returning({ id: message.id });
    const [pending] = await database.db
      .insert(pendingMedia)
      .values({
        messageId: stub.id,
        direction: 'INBOUND',
        fileCnt: 1,
        originDomain: peerDomain,
        expectedAuthorizationEpoch: 0,
        updatedAt: new Date(),
      })
      .returning({ batchId: pendingMedia.batchId });
    await database.db.insert(fileSyncProgress).values({
      batchId: pending.batchId,
      digest: 'a'.repeat(64),
      direction: 'INBOUND',
      kind: 'IMAGE',
      status: 'DOWNLOADING',
      bytesTotal: 100n,
      bytesReceived: 40n,
      originDomain: peerDomain,
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
