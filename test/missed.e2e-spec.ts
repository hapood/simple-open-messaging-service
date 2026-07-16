import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma.service';
import { ContentType } from '../src/prisma/generated/client.js';
import { seedUser, seedSession } from './seed';

/**
 * /notifications/missed e2e — the paginated, message-based incremental-sync endpoint (Phase 1).
 * Exercises: init (newest-per-thread seed), catch-up (since a high-water-mark, time-ascending),
 * cursor pagination, and the legacy summary mode. Messages are inserted directly with controlled
 * `createdAt` so ordering + pagination are deterministic.
 */
describe('notifications/missed (paginated sync)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessionToken: string;
  let recipientId: number;
  const base = Date.UTC(2026, 0, 1); // stable epoch for deterministic createdAt spacing

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const adapter = new FastifyAdapter();
    app = moduleFixture.createNestApplication(adapter);
    await configureApp(app, adapter);
    await app.listen(0);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
    // Seed the recipient + a session directly (registration is closed; the spec needs an authenticated
    // user, not the login flow).
    const recipient = await seedUser(app, 'recip', { name: 'Recip' });
    recipientId = recipient.id;
    sessionToken = await seedSession(app, recipientId, 'app');

    // A peer user + a P2P thread both participate in; 5 messages from the peer, 1s apart.
    const peer = await prisma.user.create({
      data: { account: 'peer', hashPwd: 'x', name: 'Peer', isForeigner: false },
    });
    const thread = await prisma.messageThread.create({
      data: {
        type: 'P2P',
        curSeq: 4,
        lastMessageSeq: 4,
        lastMessageAt: new Date(base + 4_000),
      },
    });
    await prisma.threadParticipant.createMany({
      data: [
        { userId: recipientId, threadId: thread.id },
        { userId: peer.id, threadId: thread.id },
      ],
    });
    for (let i = 0; i < 5; i++) {
      await prisma.message.create({
        data: {
          threadId: thread.id,
          seq: i,
          originSeq: i,
          contentType: ContentType.PURE_TEXT,
          content: `msg-${i}`,
          creator: peer.id,
          createdAt: new Date(base + i * 1_000),
        },
      });
    }
  });

  it('init (no since) returns the NEWEST message of the thread, hasMore false', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/notifications/missed')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({});
    expect(res.body.code).toBe(0);
    const messages = res.body.data.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('msg-4'); // newest per thread
    expect(messages[0].id).toBeUndefined(); // internal BigInt id never leaks
    expect(res.body.data.hasMore).toBe(false);
  });

  it('catch-up since=0 returns all 5 messages ascending by time', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/notifications/missed')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ since: 0, take: 50 });
    expect(res.body.code).toBe(0);
    const seqs = res.body.data.messages.map((m: { seq: number }) => m.seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4]); // time-ascending
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.nextCursor).toBeUndefined();
  });

  it('paginates forward via the opaque nextCursor until caught up', async () => {
    // Page 1: take=2 from since=0 → seqs [0,1], hasMore true.
    const p1 = await request(app.getHttpServer())
      .post('/api/v1/notifications/missed')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ since: 0, take: 2 });
    expect(p1.body.data.messages.map((m: { seq: number }) => m.seq)).toEqual([0, 1]);
    expect(p1.body.data.hasMore).toBe(true);
    expect(p1.body.data.nextCursor).toBeTruthy();

    // Page 2 via cursor → seqs [2,3], hasMore true.
    const p2 = await request(app.getHttpServer())
      .post('/api/v1/notifications/missed')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ cursor: p1.body.data.nextCursor, take: 2 });
    expect(p2.body.data.messages.map((m: { seq: number }) => m.seq)).toEqual([2, 3]);
    expect(p2.body.data.hasMore).toBe(true);

    // Page 3 via cursor → seq [4], hasMore false.
    const p3 = await request(app.getHttpServer())
      .post('/api/v1/notifications/missed')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ cursor: p2.body.data.nextCursor, take: 2 });
    expect(p3.body.data.messages.map((m: { seq: number }) => m.seq).length).toBeGreaterThanOrEqual(1);
    expect(p3.body.data.hasMore).toBe(false);
  });

  it('summary=true returns the legacy unread-thread snapshot', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/notifications/missed')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send({ summary: true });
    expect(res.body.code).toBe(0);
    const threads = res.body.data;
    expect(Array.isArray(threads)).toBe(true);
    expect(threads).toHaveLength(1);
    // countUnreadByThread uses seq > COALESCE(lastReadSeq,0); a never-read thread (null→0) excludes
    // seq 0, so 4 of the 5 are counted. (Pre-existing query behavior, reused unchanged.)
    expect(threads[0].unreadCount).toBe(4);
    expect(threads[0].latestMessageId).toBe('4');
  });
});
