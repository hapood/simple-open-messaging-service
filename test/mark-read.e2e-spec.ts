import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { ThreadFeedService } from '../src/message/thread-feed.service.js';
import { ThreadFeedHeadWriter } from '../src/message/thread-feed-head.writer.js';
import { DurableTaskSchedulerService } from '../src/durable-task/durable-task-scheduler.service.js';
import { DurableAsyncTaskSchedulerService } from '../src/durable-task/durable-async-task-scheduler.service.js';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import {
  message,
  messageThread,
  accountThreadState,
  federationThreadHistoryGap,
  durableTask,
} from '../src/database/schema';
import {
  applyReadPositionInTx,
  resolveReadPositionInTx,
} from '../src/message/thread-read-position.js';
import { requireThreadContentLockInTx } from '../src/relationship/thread-content-lock.js';
import { ContentType } from '../src/database/enums.js';
import { seedAcceptedRelationship, seedSession, seedUser } from './seed';

describe('POST /thread/mark-read authoritative state', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let token: string;
  let viewerId: number;
  let peerId: number;
  let threadId: number;
  let viewerParticipantId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
    // This suite claims read tasks explicitly. Background fanout must not race
    // the next test's TRUNCATE or conceal an accidentally admitted read task.
    await app.get(DurableTaskSchedulerService).stop();
    await app.get(DurableAsyncTaskSchedulerService).stop();
  });

  afterAll(async () => app.close());

  beforeEach(async () => {
    await database.pool.query(
      'TRUNCATE TABLE "Account", "GroupAccount", "Profile", "MessageThread", "DurableTask" RESTART IDENTITY CASCADE',
    );
    const viewer = await seedUser(app, 'reader', { name: 'Reader' });
    const peer = await seedUser(app, 'peer', { name: 'Peer' });
    viewerId = viewer.id;
    peerId = peer.id;
    token = await seedSession(app, viewerId, 'app');
    const now = new Date();
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        curSeq: 1005,
        updatedAt: now,
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await seedAcceptedRelationship(database.db, viewerId, peerId, threadId);
    const viewerParticipant =
      await database.db.query.accountThreadState.findFirst({
        where: and(
          eq(accountThreadState.threadId, threadId),
          eq(accountThreadState.accountId, viewerId),
        ),
        columns: { id: true },
      });
    if (!viewerParticipant)
      throw new Error('viewer thread participant is missing');
    viewerParticipantId = viewerParticipant.id;
    await database.db.insert(message).values(
      Array.from({ length: 1005 }, (_, index) => {
        const seq = index + 1;
        return {
          threadId,
          seq,
          contentType: ContentType.PURE_TEXT,
          content: JSON.stringify({
            text:
              seq === 2
                ? '[@所有人](somfp://audience/all)'
                : seq === 3
                  ? '[@Reader](somfp://user/reader)'
                  : `message-${seq}`,
          }),
          // The viewer's own seq=1 message must never contribute to unreadCount.
          creatorAccount: seq === 1 ? 'reader' : 'peer',
          creatorDomain: 'local',
          updatedAt: now,
        };
      }),
    );
  });

  beforeEach(async () => {
    await database.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      await ThreadFeedHeadWriter.advanceInTx(tx, viewerId, {
        threadId,
        messageEndSeq: 1005,
        tombstoneEndSeq: 0,
      });
    });
  });

  function commit(localReadHwm: number) {
    return request(app.getHttpServer())
      .post('/api/v1/thread/mark-read')
      .set('Authorization', `Bearer ${token}`)
      .send({ threadId, localReadHwm });
  }

  it('does not read earlier peer messages or enqueue a read task when sending', async () => {
    const before = await database.db.query.accountThreadState.findFirst({
      where: eq(accountThreadState.id, viewerParticipantId),
    });
    expect(before).toMatchObject({ lastReadSeq: 0, unreadCount: 1004 });
    const sent = await request(app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${token}`)
      .send({
        threadId,
        content: 'reply without marking history read',
        contentType: 'PURE_TEXT',
      });
    expect(sent.body.code).toBe(0);
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: eq(accountThreadState.id, viewerParticipantId),
      }),
    ).toMatchObject({ lastReadSeq: 0, unreadCount: 1004 });
    expect(
      await database.db
        .select({ id: durableTask.id })
        .from(durableTask)
        .where(
          and(
            eq(durableTask.actorUserId, viewerId),
            eq(durableTask.taskType, 'COMMIT_THREAD_READ_POSITION'),
          ),
        ),
    ).toEqual([]);
  });

  it('validates mapped recoverable gaps, clipped to visible history, using the shared read path', async () => {
    await database.db.transaction(async (tx) => {
      await requireThreadContentLockInTx(tx, threadId);
      const [gap] = await tx
        .insert(federationThreadHistoryGap)
        .values({
          threadId,
          namespaceId: 0,
          startSeq: 1,
          endSeq: 20,
          messageSeqOffset: 500,
        })
        .returning();
      const validate = (seq: number) =>
        resolveReadPositionInTx(tx, viewerId, {
          threadId,
          localReadHwm: seq,
          force: true,
        });
      // Existing rows do not prove that the declared missing interval is complete.
      await expect(validate(519)).resolves.toBe(520);
      await expect(validate(520)).resolves.toBe(520);
      await expect(
        applyReadPositionInTx(tx, viewerId, {
          threadId,
          localReadHwm: 519,
          force: true,
        }),
      ).resolves.toBe(520);
      await tx
        .update(accountThreadState)
        .set({ messageVisibleThroughSeq: 510 })
        .where(eq(accountThreadState.id, viewerParticipantId));
      await expect(validate(509)).resolves.toBe(510);
      await expect(validate(510)).resolves.toBe(510);
      await expect(validate(1006)).resolves.toBe(510);
      await expect(
        applyReadPositionInTx(tx, viewerId, {
          threadId,
          localReadHwm: 1006,
          force: true,
        }),
      ).resolves.toBe(510);
      await tx
        .update(federationThreadHistoryGap)
        .set({ recoverable: false })
        .where(eq(federationThreadHistoryGap.id, gap.id));
      await expect(validate(0)).resolves.toBe(0);
    });
  });

  it('accepts a durable read and exposes exact committed state through attention-delta', async () => {
    const accepted = await commit(1000);
    expect(accepted.body.code).toBe(0);
    expect(accepted.body.data).toMatchObject({ status: 'PENDING' });
    expect(accepted.body.data.taskId).toMatch(/^\d+$/);
    const taskId = BigInt(accepted.body.data.taskId);
    const store = app.get(DurableTaskStoreService);
    const claimed = await store.claim(taskId);
    if (claimed) await app.get(ThreadFeedService).executeTask(claimed);
    await vi.waitFor(
      async () => {
        const current = await database.db.query.accountThreadState.findFirst({
          where: eq(accountThreadState.id, viewerParticipantId),
        });
        expect(current?.lastReadSeq).toBe(1000);
      },
      { timeout: 10000 },
    );
    const page = await request(app.getHttpServer())
      .post('/api/v1/thread/feed-delta')
      .set('Authorization', `Bearer ${token}`)
      .send({ after: 0, take: 100 });
    expect(page.body.code).toBe(0);
    expect(
      page.body.data.items.find(
        (item: { threadId: number }) => item.threadId === threadId,
      ),
    ).toMatchObject({ lastReadSeq: 1000, unreadCount: 5 });
    expect(page.body.data.threadFeedEndId).toBeGreaterThan(0);
    expect(page.body.data).not.toHaveProperty('readRevision');
  });

  it('rejects negative positions and attention cursors above the account head', async () => {
    expect((await commit(-1)).body.code).not.toBe(0);
    const response = await request(app.getHttpServer())
      .post('/api/v1/thread/feed-delta')
      .set('Authorization', `Bearer ${token}`)
      .send({ after: 2147483647 });
    expect(response.body.code).toBe(30007);
  });
});
