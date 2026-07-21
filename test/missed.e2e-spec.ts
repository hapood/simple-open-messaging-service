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
 * /notifications/missed-summary + /notifications/missed e2e — the two SEPARATED endpoints:
 *  - missed-summary (threadlist body pre-warm): the `(from, to]` double-boundary walk of per-thread latest
 *    bodies. `to ≤ from` (stale SSE) → empty no-op.
 *  - missed (away-notification renderers): per-sender aggregation of messages since `since` (the HWM) → ONE
 *    descriptor; `since` absent / nothing new → a `clear` descriptor.
 *
 * The BigInt message `id` is NEVER exposed — only per-thread `seq` + time. Three P2P threads seeded in
 * insertion order (Alice → Bob → Carol; Alice muted) so message ids strictly increase → deterministic.
 */
describe('notifications/missed-summary + notifications/missed', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessionToken: string;
  let recipientId: number;
  let tAlice: number; // muted
  let tBob: number;
  let tCarol: number;
  const base = Date.UTC(2026, 0, 1);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    const recipient = await seedUser(app, 'recip', { name: 'Recip' });
    recipientId = recipient.id;
    sessionToken = await seedSession(app, recipientId, 'app');
    tAlice = await seedThread({ name: 'Alice', muted: true });
    tBob = await seedThread({ name: 'Bob' });
    tCarol = await seedThread({ name: 'Carol' });
  });

  /** Seed one P2P thread: 3 messages (seq 0..2) from a fresh peer; the recipient is muted when asked. */
  async function seedThread(opts: { name: string; muted?: boolean }): Promise<number> {
    const peer = await prisma.user.create({
      data: { account: opts.name.toLowerCase(), hashPwd: 'x', name: opts.name, isForeigner: false },
    });
    const thread = await prisma.messageThread.create({
      data: { type: 'P2P', curSeq: 2, lastMessageSeq: 2, lastMessageAt: new Date(base + opts.name.length) },
    });
    await prisma.threadParticipant.createMany({
      data: [
        { userId: recipientId, threadId: thread.id, muted: opts.muted === true },
        { userId: peer.id, threadId: thread.id },
      ],
    });
    for (let seq = 0; seq <= 2; seq++) {
      await prisma.message.create({
        data: {
          threadId: thread.id, seq, originSeq: seq, contentType: ContentType.PURE_TEXT,
          content: `${opts.name}-${seq}`, creator: peer.id, createdAt: new Date(base + seq),
        },
      });
    }
    return thread.id;
  }

  function postSummary(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/notifications/missed-summary')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send(body);
  }

  function postMissed(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return request(app.getHttpServer())
      .post('/api/v1/notifications/missed')
      .set('Authorization', `Bearer ${sessionToken}`)
      .set(headers)
      .send(body);
  }

  // ── /notifications/missed-summary (threadlist) ───────────────────────────────────────────────

  it('missed-summary: threads whose latest-id ∈ (from, to], ASC; nextCursor = page max', async () => {
    // from = Alice's latest, to = Carol's latest → range = Bob + Carol (Alice's latest is the lower bound).
    const res = await postSummary({ from: { threadId: tAlice, seq: 2 }, to: { threadId: tCarol, seq: 2 }, take: 50 });
    expect(res.body.code).toBe(0);
    expect(res.body.data.items.map((i: { threadId: number }) => i.threadId)).toEqual([tBob, tCarol]);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.nextCursor).toBeNull();
    // Each item carries its thread's newest body (no BigInt id leaks).
    const bob = res.body.data.items.find((i: { threadId: number }) => i.threadId === tBob);
    expect(bob.latestMessage).toMatchObject({ seq: 2, content: 'Bob-2' });
    expect(bob.latestMessage).not.toHaveProperty('id');
  });

  it('missed-summary: paginates — nextCursor = page max-id when hasMore (ASC oldest-first)', async () => {
    // from absent (first boot), to = Carol's latest, take 2 → ASC oldest-first 2 of (−∞, carolLatest].
    const res = await postSummary({ to: { threadId: tCarol, seq: 2 }, take: 2 });
    expect(res.body.data.items.map((i: { threadId: number }) => i.threadId)).toEqual([tAlice, tBob]); // ids 3,6
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).toEqual({ threadId: tBob, seq: 2 }); // page max → the next `from`
  });

  it('missed-summary: to ≤ from (stale SSE) → empty no-op', async () => {
    const res = await postSummary({ from: { threadId: tCarol, seq: 2 }, to: { threadId: tAlice, seq: 2 }, take: 50 });
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.hasMore).toBe(false);
  });

  // ── /notifications/missed (renderer) ─────────────────────────────────────────────────────────

  it('missed: since absent (first-ever) → clear descriptor', async () => {
    const res = await postMissed({});
    expect(res.body.data.notifications).toHaveLength(1);
    expect(res.body.data.notifications[0].kind).toBe('clear');
  });

  it('missed: aggregates per sender since the HWM into one descriptor (en)', async () => {
    // since = Alice's seq 0 (the globally-oldest message) → everything after it: Alice 1,2 + Bob 0,1,2 +
    // Carol 0,1,2 = 8 messages across 3 senders → manyConv "Alice, Bob +1 sent you 8 messages".
    const res = await postMissed({ since: { threadId: tAlice, seq: 0 } }, { 'Accept-Language': 'en' });
    const d = res.body.data.notifications[0];
    expect(d.kind).toBe('message-summary');
    expect(d.body).toBe('Alice, Bob +1 sent you 8 messages');
    expect(d.lang).toBe('en');
    // The descriptor carries the HWM cursor (the newest covered message = Carol's seq-2), not a thread list.
    expect(d.data).toEqual({ threadId: tCarol, seq: 2 });
    expect(d.icon === null || /^\/uploads\/notif-icons\/[0-9a-f]+\.png$/.test(d.icon)).toBe(true);
  });

  it('missed: Accept-Language zh-CN → Chinese body', async () => {
    const res = await postMissed({ since: { threadId: tAlice, seq: 0 } }, { 'Accept-Language': 'zh-CN,zh;q=0.9' });
    expect(res.body.data.notifications[0].body).toBe('Alice、Bob 等 1 人给你发了 8 条消息');
    expect(res.body.data.notifications[0].lang).toBe('zh-CN');
  });

  it('missed: a blocked sender is excluded from the aggregation', async () => {
    // Block Carol's peer → her 3 messages drop out: Alice 1,2 + Bob 0,1,2 = 5, 2 senders.
    const carolPeer = await prisma.threadParticipant.findFirst({
      where: { threadId: tCarol, userId: { not: recipientId } },
    });
    await prisma.userBlock.create({ data: { blockerId: recipientId, blockedId: carolPeer!.userId } });
    const res = await postMissed({ since: { threadId: tAlice, seq: 0 } }, { 'Accept-Language': 'en' });
    expect(res.body.data.notifications[0].body).toBe('Alice, Bob sent you 5 messages');
  });

  it('missed: HWM at the global newest → nothing new → clear', async () => {
    // since = Carol's seq 2 (the newest) → nothing after → clear.
    const res = await postMissed({ since: { threadId: tCarol, seq: 2 } });
    expect(res.body.data.notifications[0].kind).toBe('clear');
  });
});
