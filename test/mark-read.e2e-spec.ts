import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  threadParticipant,
} from '../src/database/schema';
import { ContentType } from '../src/database/enums.js';
import { seedSession, seedUser } from './seed';

describe('POST /thread/mark-read authoritative state', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let token: string;
  let viewerId: number;
  let peerId: number;
  let threadId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    database = app.get(DatabaseService);
  });

  afterAll(async () => app.close());

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
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
        curSeq: 1004,
        lastMessageSeq: 1004,
        lastMessageAt: now,
        updatedAt: now,
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await database.db.insert(threadParticipant).values([
      { userId: viewerId, threadId, updatedAt: now },
      { userId: peerId, threadId, updatedAt: now },
    ]);
    await database.db.insert(message).values(
      Array.from({ length: 1005 }, (_, seq) => ({
        threadId,
        seq,
        originSeq: seq,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({
          text:
            seq === 2
              ? '[@所有人](soms://audience/all?v=1)'
              : seq === 3
                ? '[@Reader](soms://user/reader?v=1)'
                : `message-${seq}`,
        }),
        // The viewer's own seq=1 message must never contribute to unreadCount.
        creator: seq === 1 ? viewerId : peerId,
        updatedAt: now,
      })),
    );
  });

  function commit(localReadHwm: number) {
    return request(app.getHttpServer())
      .post('/api/v1/thread/mark-read')
      .set('Authorization', `Bearer ${token}`)
      .send({ threadId, localReadHwm });
  }

  it('takes max(server, local), caps at 1000, excludes self, and returns mention kinds as a set', async () => {
    const capped = await commit(0);
    expect(capped.body.code).toBe(0);
    expect(capped.body.data).toMatchObject({
      threadId,
      lastReadSeq: 0,
      unreadCount: 1000,
    });
    expect(capped.body.data.mentionUnread).toHaveLength(2);
    expect(new Set(capped.body.data.mentionUnread)).toEqual(
      new Set(['all', 'me']),
    );

    // Simulate a newer server cursor from another session; a stale local report cannot move it backwards.
    await database.db
      .update(threadParticipant)
      .set({ lastReadSeq: 3 })
      .where(
        and(
          eq(threadParticipant.userId, viewerId),
          eq(threadParticipant.threadId, threadId),
        ),
      );
    const monotonic = await commit(0);
    expect(monotonic.body.data.lastReadSeq).toBe(3);
    expect(monotonic.body.data.unreadCount).toBe(1000);
    expect(monotonic.body.data.mentionUnread).toEqual([]);

    // Below the cap the response is exact: seq 1001..1004 are four peer-authored unread messages.
    const exact = await commit(1000);
    expect(exact.body.data).toMatchObject({
      lastReadSeq: 1000,
      unreadCount: 4,
    });
  });
});
