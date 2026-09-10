import { MessageVisibilityService } from '../src/message/message-visibility.service.js';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  accountThreadState,
  messageThread,
  message,
  durableTask,
  deletedMessage,
  relationshipPair,
} from '../src/database/schema.js';
import { ThreadFeedService } from '../src/message/thread-feed.service.js';
import { DurableTaskDispatcherService } from '../src/durable-task/durable-task-dispatcher.service.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { ThreadPreviewService } from '../src/message/thread-preview.service.js';
import { ThreadHistoryService } from '../src/message/thread-history.service.js';
import { ThreadFeedHeadWriter } from '../src/message/thread-feed-head.writer.js';
import { requireThreadContentLockInTx } from '../src/relationship/thread-content-lock.js';
import { ThreadFanoutProgressService } from '../src/message/thread-fanout-progress.service.js';
import { enqueueThreadFanoutInTx } from '../src/message/thread-fanout-task.js';

describe('transactional thread attention', () => {
  const db = new DatabaseService();
  const service = new ThreadFeedService(db, new DurableTaskDispatcherService());
  const tasks = new DurableTaskStoreService(db);
  let userId: number;
  let threadId: number;
  beforeAll(() => db.onModuleInit());
  afterAll(() => db.onApplicationShutdown());
  beforeEach(async () => {
    await db.pool.query(
      'TRUNCATE "Account", "MessageThread", "DurableTask" RESTART IDENTITY CASCADE',
    );
    const [owner] = await db.db
      .insert(account)
      .values({ account: 'reader' })
      .returning();
    userId = owner.id;
    const [thread] = await db.db
      .insert(messageThread)
      .values({ type: 'P2P', curSeq: 2000, updatedAt: new Date() })
      .returning();
    threadId = thread.id;
    await db.db.insert(relationshipPair).values({
      kind: 'P2P',
      active: true,
      threadId,
      endpointAType: 'USER',
      endpointAAccount: 'peer',
      endpointADomain: 'local',
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: 'reader',
      endpointBDomain: 'local',
      endpointBNamespaceId: 0,
      updatedAt: new Date(),
    });
    await db.db
      .insert(accountThreadState)
      .values({ accountId: userId, threadId, updatedAt: new Date() });
    const previews = new ThreadPreviewService(db);
    Object.assign(service, { previews });
  });
  const state = async () =>
    (await db.db.query.accountThreadState.findFirst({
      where: eq(accountThreadState.accountId, userId),
    }))!;

  it('skips blocked content heads while advancing fanout progress, then publishes after unblock', async () => {
    const target = { threadId, messageEndSeq: 10, tombstoneEndSeq: 2 };
    const taskId = await db.db.transaction(async (tx) => {
      const lock = await requireThreadContentLockInTx(tx, threadId);
      return enqueueThreadFanoutInTx(tx, lock, target);
    });
    await tasks.claim(taskId);
    // The recipient was selected before block committed. Projection must recheck
    // the current state even when that stale audience still includes the account.
    await db.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      await tx
        .update(accountThreadState)
        .set({ blocked: true })
        .where(eq(accountThreadState.accountId, userId));
    });
    const blocked = await state();
    const progress = new ThreadFanoutProgressService(
      db,
      new MessageVisibilityService(db),
    );
    await progress.projectBatch(taskId, target, [userId]);
    expect(await state()).toMatchObject({
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      threadFeedId: blocked.threadFeedId,
    });
    expect(await progress.read(taskId)).toEqual({
      phase: 'FEED',
      afterAccountId: userId,
    });
    await db.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      await tx
        .update(accountThreadState)
        .set({ blocked: false })
        .where(eq(accountThreadState.accountId, userId));
    });
    await progress.projectBatch(taskId, target, [userId]);
    expect(await state()).toMatchObject(target);
    expect((await state()).threadFeedId).toBeGreaterThan(blocked.threadFeedId);
  });

  it('publishes heads through the same feed even when unread stays zero', async () => {
    const before = await state();
    const target = { threadId, messageEndSeq: 10, tombstoneEndSeq: 2 };
    await db.db.transaction((tx) =>
      ThreadFeedHeadWriter.advanceInTx(tx, userId, target),
    );
    const published = await state();
    expect(published.unreadCount).toBe(0);
    expect(published.threadFeedId).toBeGreaterThan(before.threadFeedId);
    expect(published).toMatchObject(target);
    const page = await service.queryThreadFeedDelta(userId, {
      after: before.threadFeedId,
    });
    expect(page.items).toEqual([
      expect.objectContaining({ ...target, unreadCount: 0 }),
    ]);
    await db.db.transaction((tx) =>
      ThreadFeedHeadWriter.advanceInTx(tx, userId, target),
    );
    expect((await state()).threadFeedId).toBe(published.threadFeedId);
    const old = await db.pool.query(
      'SELECT count(*)::integer AS n FROM "ClientStateFeed" WHERE "eventType" = $1',
      ['THREAD_CONTENT_HEAD'],
    );
    expect(old.rows[0].n).toBe(0);
  });

  it('rolls back heads and their feed allocation together', async () => {
    const before = await state();
    const head = await service.readEndId(userId);
    await expect(
      db.db.transaction(async (tx) => {
        await ThreadFeedHeadWriter.advanceInTx(tx, userId, {
          threadId,
          messageEndSeq: 10,
          tombstoneEndSeq: 2,
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await state()).toEqual(before);
    expect(await service.readEndId(userId)).toBe(head);
  });
  const put = (
    seq: number,
    text = 'hello',
    patch: Partial<typeof message.$inferInsert> = {},
  ) =>
    db.db
      .insert(message)
      .values({
        threadId,
        seq,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text }),
        creatorAccount: 'peer',
        creatorDomain: 'local',
        updatedAt: new Date(),
        ...patch,
      })
      .onConflictDoNothing();
  async function run(taskId: string) {
    const claimed = await tasks.claim(BigInt(taskId));
    expect(claimed).toBeDefined();
    await service.executeTask(claimed!);
    await tasks.markSucceeded(BigInt(taskId));
    return claimed!;
  }
  async function projectCurrentHeads() {
    return db.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      const heads = await tx.execute<{
        messageEndSeq: number;
        tombstoneEndSeq: number;
      }>(sql`
        SELECT COALESCE((SELECT max(seq) FROM "Message" WHERE "threadId" = ${threadId}), 0) AS "messageEndSeq",
          COALESCE((SELECT max("deletionSeq") FROM "DeletedMessage" WHERE "threadId" = ${threadId}), 0) AS "tombstoneEndSeq"`);
      return ThreadFeedHeadWriter.advanceInTx(tx, userId, {
        threadId,
        ...heads.rows[0],
      });
    });
  }
  async function retractMention(seq: number, deletionSeq: number) {
    await db.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      await tx.insert(deletedMessage).values({
        threadId,
        messageSeq: seq,
        deletionSeq,
        type: 'USER_RETRACTION',
      });
      await tx
        .update(message)
        .set({ isDeleted: true })
        .where(eq(message.seq, seq));
    });
  }
  it('counts slots only at fanout, including deleted slots and excluding own messages', async () => {
    expect(await state()).toMatchObject({
      unreadCount: 0,
      lastReadSeq: 0,
      threadFeedId: 1,
    });
    await put(1);
    await put(1);
    await put(2, 'self', { creatorAccount: 'reader' });
    await put(3, 'stub', { localState: 'STUB' });
    await put(4, 'already deleted', { isDeleted: true });
    expect((await state()).unreadCount).toBe(0);
    await projectCurrentHeads();
    expect((await state()).unreadCount).toBe(3);
    const feedBeforeMaterialization = (await state()).threadFeedId;
    await db.db
      .update(message)
      .set({ localState: 'READY' })
      .where(eq(message.seq, 3));
    expect((await state()).unreadCount).toBe(3);
    expect((await state()).threadFeedId).toBe(feedBeforeMaterialization);
    await db.db
      .update(message)
      .set({ localState: 'FAILED' })
      .where(eq(message.seq, 3));
    expect((await state()).unreadCount).toBe(3);
    expect((await state()).threadFeedId).toBe(feedBeforeMaterialization);
    await db.db
      .update(message)
      .set({ isDeleted: true })
      .where(eq(message.seq, 1));
    await db.db
      .update(message)
      .set({ isDeleted: true })
      .where(eq(message.seq, 1));
    expect((await state()).unreadCount).toBe(3);
  });

  it.each([
    ['fanout', 'read', 'tomb'],
    ['fanout', 'tomb', 'read'],
    ['read', 'fanout', 'tomb'],
    ['read', 'tomb', 'fanout'],
    ['tomb', 'fanout', 'read'],
    ['tomb', 'read', 'fanout'],
  ])('converges for independently ordered %s / %s / %s', async (...order) => {
    await put(1);
    await put(2, 'own', { creatorAccount: 'reader' });
    await put(3, '[@All](somfp://audience/all)');
    await put(4);
    const before = await state();
    expect(before).toMatchObject({ unreadCount: 0, messageEndSeq: 0 });
    for (const action of order) {
      if (action === 'fanout') await projectCurrentHeads();
      if (action === 'read')
        await run(
          (
            await service.enqueueReadPosition(userId, {
              threadId,
              localReadHwm: 1,
            })
          ).taskId,
        );
      if (action === 'tomb') await retractMention(3, 1);
    }
    await projectCurrentHeads();
    expect(await state()).toMatchObject({
      lastReadSeq: 1,
      unreadCount: 2,
      messageEndSeq: 4,
      tombstoneEndSeq: 1,
      lastMentionSeq: null,
    });
    const settled = await state();
    await projectCurrentHeads();
    expect(await state()).toEqual(settled);
    await run(
      (
        await service.enqueueReadPosition(userId, {
          threadId,
          localReadHwm: 0,
          force: true,
        })
      ).taskId,
    );
    expect((await state()).unreadCount).toBe(3);
  });

  it('does not subtract unpublished messages and counts only the later unread suffix', async () => {
    for (let seq = 1; seq <= 5; seq++) await put(seq);
    await db.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      await ThreadFeedHeadWriter.advanceInTx(tx, userId, {
        threadId,
        messageEndSeq: 2,
        tombstoneEndSeq: 0,
      });
    });
    expect((await state()).unreadCount).toBe(2);
    await run(
      (
        await service.enqueueReadPosition(userId, {
          threadId,
          localReadHwm: 4,
        })
      ).taskId,
    );
    expect((await state()).unreadCount).toBe(0);
    await projectCurrentHeads();
    expect((await state()).unreadCount).toBe(1);
    await run(
      (
        await service.enqueueReadPosition(userId, {
          threadId,
          localReadHwm: 1,
          force: true,
        })
      ).taskId,
    );
    expect((await state()).unreadCount).toBe(4);
  });

  it.each(['USER_RETRACTION', 'MODERATION_REMOVAL'] as const)(
    'marks preview changes for %s without changing references or unread count',
    async (type) => {
      for (let seq = 1; seq <= 7; seq++) await put(seq);
      expect(await projectCurrentHeads()).toEqual({
        unreadCountChanged: true,
        previewChanged: true,
      });
      expect(await projectCurrentHeads()).toEqual({
        unreadCountChanged: false,
        previewChanged: false,
      });
      const before = await state();
      await db.db.transaction(async (tx) => {
        await requireThreadContentLockInTx(tx, threadId);
        await tx
          .insert(deletedMessage)
          .values({ threadId, messageSeq: 7, deletionSeq: 1, type });
        await tx
          .update(message)
          .set({ isDeleted: true })
          .where(eq(message.seq, 7));
      });
      expect(await projectCurrentHeads()).toEqual({
        unreadCountChanged: false,
        previewChanged: true,
      });
      expect(await state()).toMatchObject({
        unreadCount: before.unreadCount,
        previewSeqs: before.previewSeqs,
      });
      const delta = await service.queryThreadFeedDelta(userId, {
        after: 0,
        previewCount: 5,
      });
      expect(delta.items[0].previews?.at(-1)).toMatchObject({
        seq: 7,
        status: type,
      });
      expect(delta.items[0].previews?.at(-1)).not.toHaveProperty('text');
      await retractMention(1, 2);
      expect(await projectCurrentHeads()).toEqual({
        unreadCountChanged: false,
        previewChanged: false,
      });
    },
  );

  it('persists other-sender preview slots and queries exact references after restart', async () => {
    for (let seq = 1; seq <= 7; seq++) await put(seq);
    for (let seq = 8; seq <= 12; seq++)
      await put(seq, 'own', { creatorAccount: 'reader' });
    expect((await state()).previewSeqs).toEqual([]);
    await projectCurrentHeads();
    expect((await state()).previewSeqs).toEqual([7, 6, 5, 4, 3]);
    Object.assign(service, { previews: new ThreadPreviewService(db) });
    const delta = await service.queryThreadFeedDelta(userId, {
      after: 0,
      previewCount: 1,
    });
    expect(delta.items[0].previews?.map((row) => row.seq)).toEqual([7]);
    await retractMention(7, 1);
    await projectCurrentHeads();
    expect((await state()).previewSeqs).toEqual([7, 6, 5, 4, 3]);
    const deleted = await service.queryThreadFeedDelta(userId, {
      after: 0,
      previewCount: 5,
    });
    expect(deleted.items[0].previews?.map((row) => row.seq)).toEqual([
      3, 4, 5, 6, 7,
    ]);
    expect(deleted.items[0].previews?.at(-1)).toMatchObject({
      seq: 7,
      status: 'USER_RETRACTION',
    });
    expect(deleted.items[0].previews?.at(-1)).not.toHaveProperty('text');
  });

  it('prunes reads without refilling and restores slots on force rollback', async () => {
    for (let seq = 1; seq <= 8; seq++) await put(seq);
    await projectCurrentHeads();
    await run(
      (await service.enqueueReadPosition(userId, { threadId, localReadHwm: 6 }))
        .taskId,
    );
    expect((await state()).previewSeqs).toEqual([8, 7]);
    await projectCurrentHeads();
    expect((await state()).previewSeqs).toEqual([8, 7]);
    await run(
      (
        await service.enqueueReadPosition(userId, {
          threadId,
          localReadHwm: 0,
          force: true,
        })
      ).taskId,
    );
    expect((await state()).previewSeqs).toEqual([8, 7, 6, 5, 4]);
    await new ThreadHistoryService(db).clear(threadId, 7);
    expect((await state()).previewSeqs).toEqual([8]);
  });

  it('initializes empty previews and read state atomically without a cache or task', async () => {
    await put(1);
    await projectCurrentHeads();
    const before = await state();
    const previews = new ThreadPreviewService(db);
    await expect(
      db.db.transaction(async (tx) => {
        await requireThreadContentLockInTx(tx, threadId);
        await previews.initializeReadWindowsInTx(tx, threadId, [userId]);
        throw new Error('rollback initialization');
      }),
    ).rejects.toThrow('rollback initialization');
    expect(await state()).toEqual(before);
    await db.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      await previews.initializeReadWindowsInTx(tx, threadId, [userId]);
    });
    expect(await state()).toMatchObject({
      lastReadSeq: 2000,
      unreadCount: 0,
      previewSeqs: [],
    });
    expect(await db.db.select().from(durableTask)).toEqual([]);
  });

  it('counts beyond the old 1000 cap', async () => {
    await db.pool.query(
      `INSERT INTO "Message" ("threadId",seq,"contentType",content,"creatorAccount","creatorDomain","updatedAt")
      SELECT $1,s,'PURE_TEXT','{"text":"hello"}'::jsonb,'peer','local',now() FROM generate_series(1,1005) s`,
      [threadId],
    );
    await projectCurrentHeads();
    expect((await state()).unreadCount).toBe(1005);
  });
  it('MAX-merges pending reads, preserves force barriers and does not replay completed force tasks', async () => {
    await put(1);
    await put(2);
    await put(3);
    await projectCurrentHeads();
    const first = await service.enqueueReadPosition(userId, {
      threadId,
      localReadHwm: 1,
    });
    const merged = await service.enqueueReadPosition(userId, {
      threadId,
      localReadHwm: 2,
    });
    expect(first.taskId).toBe(merged.taskId);
    const force = await service.enqueueReadPosition(userId, {
      threadId,
      localReadHwm: 0,
      force: true,
    });
    const tail = await service.enqueueReadPosition(userId, {
      threadId,
      localReadHwm: 3,
    });
    expect(tail.taskId).not.toBe(first.taskId);
    await run(first.taskId);
    expect(await state()).toMatchObject({ lastReadSeq: 2, unreadCount: 1 });
    const replay = await run(force.taskId);
    expect(await state()).toMatchObject({ lastReadSeq: 0, unreadCount: 3 });
    await run(tail.taskId);
    await service.executeTask(replay);
    expect(await state()).toMatchObject({ lastReadSeq: 3, unreadCount: 0 });
  });
  it('preserves monotonic reads and publishes read position changes with unchanged count', async () => {
    const initial = (await state()).threadFeedId;
    await run(
      (await service.enqueueReadPosition(userId, { threadId, localReadHwm: 5 }))
        .taskId,
    );
    expect((await state()).threadFeedId).toBeGreaterThan(initial);
    const head = (await state()).threadFeedId;
    await run(
      (await service.enqueueReadPosition(userId, { threadId, localReadHwm: 3 }))
        .taskId,
    );
    expect(await state()).toMatchObject({
      lastReadSeq: 5,
      threadFeedId: head,
    });
  });
  it('maintains insertion MAX and recomputes retracted mentions above lastReadSeq', async () => {
    await projectCurrentHeads();
    await put(1, '[@Reader](somfp://user/reader)');
    await put(2, '[@Reader](somfp://user/reader)');
    await put(3, '[@All](somfp://audience/all)');
    await projectCurrentHeads();
    expect((await state()).lastMentionSeq).toBe(3);
    await put(2, '[@Reader](somfp://user/reader)');
    await projectCurrentHeads();
    expect((await state()).lastMentionSeq).toBe(3);
    await retractMention(3, 1);
    await projectCurrentHeads();
    expect((await state()).lastMentionSeq).toBe(2);
    await run(
      (await service.enqueueReadPosition(userId, { threadId, localReadHwm: 2 }))
        .taskId,
    );
    await retractMention(2, 2);
    await projectCurrentHeads();
    expect((await state()).lastMentionSeq).toBeNull();
    await run(
      (
        await service.enqueueReadPosition(userId, {
          threadId,
          localReadHwm: 0,
          force: true,
        })
      ).taskId,
    );
    await projectCurrentHeads();
    expect((await state()).lastMentionSeq).toBe(1);
  });
  it('projects coalesced message and tomb heads without creating mention tasks', async () => {
    await put(1, '[@All](somfp://audience/all)');
    await put(2, '[@All](somfp://audience/all)');
    await retractMention(2, 1);
    expect(await db.db.select().from(durableTask)).toEqual([]);
    const before = (await state()).threadFeedId;
    await projectCurrentHeads();
    expect(await state()).toMatchObject({
      lastMentionSeq: 1,
      messageEndSeq: 2,
      tombstoneEndSeq: 1,
      unreadCount: 2,
      threadFeedId: before + 1,
    });
    const after = await state();
    await projectCurrentHeads();
    expect(await state()).toEqual(after);
  });
  it('handles new messages and tombs of both old and new mentions in one fanout', async () => {
    await put(1, '[@All](somfp://audience/all)');
    await projectCurrentHeads();
    expect(await state()).toMatchObject({ lastMentionSeq: 1, unreadCount: 1 });
    await put(2, '[@All](somfp://audience/all)');
    await put(3, '[@All](somfp://audience/all)');
    await retractMention(1, 1);
    await retractMention(3, 2);
    const before = await state();
    expect(before.unreadCount).toBe(1);
    await projectCurrentHeads();
    expect(await state()).toMatchObject({
      messageEndSeq: 3,
      tombstoneEndSeq: 2,
      unreadCount: 3,
      lastMentionSeq: 2,
      threadFeedId: before.threadFeedId + 1,
    });
    const settled = await state();
    await projectCurrentHeads();
    expect(await state()).toEqual(settled);
  });

  it('rolls back mention, content head and feed allocation together', async () => {
    await put(1, '[@All](somfp://audience/all)');
    const before = await state();
    await expect(
      db.db.transaction(async (tx) => {
        await requireThreadContentLockInTx(tx, threadId);
        await ThreadFeedHeadWriter.advanceInTx(tx, userId, {
          threadId,
          messageEndSeq: 1,
          tombstoneEndSeq: 0,
        });
        throw new Error('rollback projection');
      }),
    ).rejects.toThrow('rollback projection');
    expect(await state()).toEqual(before);
    await projectCurrentHeads();
    expect(await state()).toMatchObject({
      lastMentionSeq: 1,
      messageEndSeq: 1,
      threadFeedId: before.threadFeedId + 1,
    });
  });
  it('clears a mention below the history boundary without a new content head', async () => {
    await put(1, '[@All](somfp://audience/all)');
    await projectCurrentHeads();
    expect((await state()).lastMentionSeq).toBe(1);
    await new ThreadHistoryService(db).clear(threadId, 1);
    expect(await state()).toMatchObject({
      lastMentionSeq: null,
      messageEndSeq: 1,
    });
  });
  it('rolls back source count and allocator without admitting mention tasks', async () => {
    const before = await state();
    const beforeTasks = await db.db.select().from(durableTask);
    await expect(
      db.db.transaction(async (tx) => {
        await tx.insert(message).values({
          threadId,
          seq: 1,
          contentType: 'PURE_TEXT',
          content: '{"text":"[@All](somfp://audience/all)"}',
          creatorAccount: 'peer',
          creatorDomain: 'local',
          updatedAt: new Date(),
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await state()).toEqual(before);
    expect(await db.db.select().from(durableTask)).toEqual(beforeTasks);
  });
  it('reconciles history clearing and visibility boundaries', async () => {
    await put(1);
    await put(2);
    await put(3);
    await projectCurrentHeads();
    await db.db
      .update(messageThread)
      .set({ clearedSeq: 1 })
      .where(eq(messageThread.id, threadId));
    expect((await state()).unreadCount).toBe(2);
    await db.db
      .update(accountThreadState)
      .set({ messageVisibleThroughSeq: 2 })
      .where(eq(accountThreadState.accountId, userId));
    expect((await state()).unreadCount).toBe(1);
    await db.db
      .update(accountThreadState)
      .set({ blocked: true })
      .where(eq(accountThreadState.accountId, userId));
    expect((await state()).unreadCount).toBe(0);
  });
  it('rejects an ahead cursor and advances across an empty compacted range', async () => {
    await expect(
      service.queryThreadFeedDelta(userId, { after: 2 }),
    ).rejects.toThrow('invalid attention feed range');
    await put(1);
    await projectCurrentHeads();
    const page = await service.queryThreadFeedDelta(userId, {
      after: 0,
      through: 1,
    });
    expect(page).toMatchObject({
      scannedThrough: 1,
      hasMore: false,
      items: [],
    });
    const tail = await service.queryThreadFeedDelta(userId, { after: 1 });
    expect(tail.items[0]).toMatchObject({ threadId, unreadCount: 1 });
  });
  it('fails allocator overflow atomically', async () => {
    await db.db
      .update(account)
      .set({ threadFeedEndId: 2147483647 })
      .where(eq(account.id, userId));
    await put(1);
    await expect(projectCurrentHeads()).rejects.toThrow();
    expect((await state()).unreadCount).toBe(0);
  });
  it('serializes concurrent insertion, read advancement and deletion without count drift', async () => {
    await put(1);
    const accepted = await service.enqueueReadPosition(userId, {
      threadId,
      localReadHwm: 2,
    });
    await Promise.all([
      db.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM "MessageThread" WHERE id = ${threadId} FOR UPDATE`,
        );
        await tx.insert(message).values({
          threadId,
          seq: 2,
          contentType: 'PURE_TEXT',
          content: '{"text":"late"}',
          creatorAccount: 'peer',
          creatorDomain: 'local',
          updatedAt: new Date(),
        });
      }),
      run(accepted.taskId),
      db.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM "MessageThread" WHERE id = ${threadId} FOR UPDATE`,
        );
        await tx
          .update(message)
          .set({ isDeleted: true })
          .where(eq(message.seq, 1));
      }),
    ]);
    await projectCurrentHeads();
    expect(await state()).toMatchObject({ lastReadSeq: 2, unreadCount: 0 });
  });
  it('pages multiple compacted rows without advancing past the fixed target', async () => {
    for (let i = 0; i < 2; i++) {
      const [thread] = await db.db
        .insert(messageThread)
        .values({ type: 'P2P', updatedAt: new Date() })
        .returning();
      await db.db.insert(accountThreadState).values({
        accountId: userId,
        threadId: thread.id,
        updatedAt: new Date(),
      });
    }
    const first = await service.queryThreadFeedDelta(userId, {
      after: 0,
      take: 1,
    });
    expect(first).toMatchObject({
      through: 3,
      scannedThrough: 1,
      hasMore: true,
    });
    await put(1);
    await projectCurrentHeads();
    const second = await service.queryThreadFeedDelta(userId, {
      after: first.scannedThrough,
      through: first.through,
    });
    expect(second).toMatchObject({
      through: 3,
      scannedThrough: 3,
      hasMore: false,
    });
    expect(second.items).toHaveLength(2);
    expect(
      (await service.queryThreadFeedDelta(userId, { after: 3 })).items[0]
        .unreadCount,
    ).toBe(1);
  });
});
