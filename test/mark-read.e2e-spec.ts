import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withMessageDigest } from './support/message-fixture.js';
import { ThreadFeedHeadWriter } from '../src/message/thread-feed-head.writer.js';
import { DurableTaskSchedulerService } from '../src/durable-task/durable-task-scheduler.service.js';
import request from 'supertest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import {
  message,
  messageThread,
  accountThreadState,
  federationThreadHistoryGap,
} from '../src/database/schema';
import { applyReadPositionInTx } from '../src/message/thread-read-position.service.js';
import { requireThreadContentLockInTx } from '../src/common/locks/thread-content-lock.js';
import { ContentType } from '../src/database/enums.js';
import { seedAcceptedRelationship, seedSession, seedUser } from './seed';
import { createTestApp } from './support/app';
import { truncateTablesForTest } from './support/truncate';

describe('POST /thread/mark-read authoritative state', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  let token: string;
  let viewerId: number;
  let peerId: number;
  let threadId: number;
  let viewerParticipantId: number;

  beforeAll(async () => {
    ({ app, database } = await createTestApp());
    // This suite claims read tasks explicitly. Background fanout must not race
    // the next test's TRUNCATE or conceal an accidentally admitted read task.
    await app.get(DurableTaskSchedulerService).stop();
  });

  afterAll(async () => app.close());

  beforeEach(async () => {
    await truncateTablesForTest(
      database.pool,
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
      withMessageDigest(
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

            updatedAt: now,
          };
        }),
      ),
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

  it('does not read earlier peer messages when sending', async () => {
    const before = await database.db.query.accountThreadState.findFirst({
      where: eq(accountThreadState.id, viewerParticipantId),
    });
    expect(before).toMatchObject({ lastReadSeq: 0, unreadCount: 1004 });
    const sent = await request(app.getHttpServer())
      .post('/api/v1/send-message')
      .set('Authorization', `Bearer ${token}`)
      .send({
        threadId,
        content: '{"text":"reply without marking history read"}',
        contentType: 'PURE_TEXT',
      });
    expect(sent.body.code).toBe(0);
    expect(
      await database.db.query.accountThreadState.findFirst({
        where: eq(accountThreadState.id, viewerParticipantId),
      }),
    ).toMatchObject({ lastReadSeq: 0, unreadCount: 1004 });
  });

  it('validates mapped recoverable gaps, clipped to visible history, using the shared read path', async () => {
    await database.db.transaction(async (tx) => {
      const threadLock = await requireThreadContentLockInTx(tx, threadId);
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
      // Existing rows do not prove that the declared missing interval is complete.
      await expect(
        applyReadPositionInTx(tx, threadLock, viewerId, {
          threadId,
          localReadHwm: 519,
          force: true,
        }),
      ).resolves.toBe(520);
      await tx
        .update(accountThreadState)
        .set({ messageVisibleThroughSeq: 510 })
        .where(eq(accountThreadState.id, viewerParticipantId));
      await expect(
        applyReadPositionInTx(tx, threadLock, viewerId, {
          threadId,
          localReadHwm: 1006,
          force: true,
        }),
      ).resolves.toBe(510);
      await tx
        .update(federationThreadHistoryGap)
        .set({ recoverable: false })
        .where(eq(federationThreadHistoryGap.id, gap.id));
      await expect(
        applyReadPositionInTx(tx, threadLock, viewerId, {
          threadId,
          localReadHwm: 0,
          force: true,
        }),
      ).resolves.toBe(0);
    });
  });

  it('commits synchronously and exposes exact state through attention-delta', async () => {
    const accepted = await commit(1000);
    expect(accepted.body.code).toBe(0);
    expect(accepted.body.data).toEqual({
      status: 'APPLIED',
      lastReadSeq: 1000,
    });
    const page = await request(app.getHttpServer())
      .post('/api/v1/thread-feed')
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
      .post('/api/v1/thread-feed')
      .set('Authorization', `Bearer ${token}`)
      .send({ after: 2147483647 });
    expect(response.body.code).toBe(30007);
  });
});
