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
 * /notifications/missed e2e — the unified missed response: `items[]` (one row per thread, cursor-ordered)
 * + `notifications[]` (the server-authored descriptor). The single data source behind every "what did I
 * miss" path (Android FCM/WorkManager/RealtimeService, the Web Push SW, the web threadlist).
 *
 * Contract under test:
 *  - forward cursor `(threadId, seq)` → id → `id > cursor` ASC; adjacent pages NEVER overlap (no dedup);
 *    `nextCursor` = the page's max-id item's (threadId, seq), null when caught up.
 *  - absent cursor → snapshot of the newest `take` threads (ASC), `hasMore` = remainder.
 *  - `notifications[]`: the descriptor folds unread+unmuted senders (muted excluded); a `clear` descriptor
 *    when none qualify; `Accept-Language` → localized body.
 *  - the BigInt `id` NEVER appears (only per-thread `seq` + time leave the server).
 *
 * Three P2P threads seeded in insertion order (Alice → Bob → Carol), so their latest-message ids are
 * strictly increasing → id-ordering is deterministic. Alice is muted (the away-filter input).
 */
describe('notifications/missed (cursor + descriptor)', () => {
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

  function postMissed(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return request(app.getHttpServer())
      .post('/api/v1/notifications/missed')
      .set('Authorization', `Bearer ${sessionToken}`)
      .set(headers)
      .send(body);
  }

  it('snapshot (no cursor) returns threads ASC by latest-message id; nextCursor = max-id item', async () => {
    const res = await postMissed({});
    expect(res.body.code).toBe(0);
    // Insertion order Alice→Bob→Carol ⇒ latest ids strictly increase ⇒ ASC = [Alice, Bob, Carol].
    expect(res.body.data.items.map((i: { threadId: number }) => i.threadId)).toEqual([tAlice, tBob, tCarol]);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.nextCursor).toEqual({ threadId: tCarol, seq: 2 }); // max-id item
    // No BigInt MESSAGE id leaks — the per-item latestMessage must not carry the internal id. (The
    // descriptor's actions[].id is a legitimate string action id, NOT the message id, so it is fine.)
    for (const i of res.body.data.items) expect(i.latestMessage).not.toHaveProperty('id');
  });

  it('snapshot take caps the newest threads; hasMore reflects the remainder', async () => {
    const res = await postMissed({ take: 2 }); // newest 2 by id = Bob, Carol
    expect(res.body.data.items.map((i: { threadId: number }) => i.threadId)).toEqual([tBob, tCarol]);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).toEqual({ threadId: tCarol, seq: 2 });
  });

  it('forward cursor pagination: id > cursor, ASC, adjacent pages are DISJOINT (no overlap)', async () => {
    // Page 1: cursor = Alice's latest (the smallest id) → forward id>alice = [Bob, Carol] with take 1 → [Bob].
    const p1 = await postMissed({ cursor: { threadId: tAlice, seq: 2 }, take: 1 });
    expect(p1.body.data.items.map((i: { threadId: number }) => i.threadId)).toEqual([tBob]);
    expect(p1.body.data.nextCursor).toEqual({ threadId: tBob, seq: 2 });
    expect(p1.body.data.hasMore).toBe(true);

    // Page 2: cursor = Bob → forward = [Carol].
    const p2 = await postMissed({ cursor: { threadId: tBob, seq: 2 }, take: 1 });
    expect(p2.body.data.items.map((i: { threadId: number }) => i.threadId)).toEqual([tCarol]);
    expect(p2.body.data.nextCursor).toEqual({ threadId: tCarol, seq: 2 });

    // Page 3: cursor = Carol (max id) → nothing newer → empty, nextCursor null.
    const p3 = await postMissed({ cursor: { threadId: tCarol, seq: 2 }, take: 1 });
    expect(p3.body.data.items).toEqual([]);
    expect(p3.body.data.nextCursor).toBeNull();

    // The three pages are pairwise disjoint — no thread appears twice across the forward walk.
    const all = [...p1.body.data.items, ...p2.body.data.items, ...p3.body.data.items].map((i) => i.threadId);
    expect(new Set(all).size).toBe(all.length);
  });

  it('notifications[]: descriptor folds unread+unmuted senders (muted excluded)', async () => {
    const res = await postMissed({}, { 'Accept-Language': 'en' });
    // Alice muted → away = Bob + Carol, each unread 2 → "Bob, Carol sent you 4 messages".
    expect(res.body.data.notifications).toHaveLength(1);
    const d = res.body.data.notifications[0];
    expect(d.tag).toBe('soms-away');
    expect(d.kind).toBe('message-summary');
    expect(d.body).toBe('Bob, Carol sent you 4 messages');
    expect(d.lang).toBe('en');
    expect(d.data.threadIds).toEqual([tBob, tCarol]);
    // Icon: the stacked-avatar composite (initials B, C — no avatars seeded). Either a URL (librsvg
    // present) or null (absent); never throws.
    expect(d.icon === null || /^\/uploads\/notif-icons\/[0-9a-f]+\.png$/.test(d.icon)).toBe(true);
  });

  it('Accept-Language: zh-CN → Chinese descriptor body', async () => {
    const res = await postMissed({}, { 'Accept-Language': 'zh-CN,zh;q=0.9' });
    expect(res.body.data.notifications[0].body).toBe('Bob、Carol 给你发了 4 条消息');
    expect(res.body.data.notifications[0].lang).toBe('zh-CN');
  });

  it('a clear descriptor when every unread thread is muted', async () => {
    // Mute Bob + Carol too (Alice already muted) → no unread+unmuted → clear.
    await prisma.threadParticipant.updateMany({
      where: { userId: recipientId, threadId: { in: [tBob, tCarol] } },
      data: { muted: true },
    });
    const res = await postMissed({});
    expect(res.body.data.notifications[0].kind).toBe('clear');
    expect(res.body.data.notifications[0].body).toBe('');
  });

  it('carries unreadCount + muted + displayName + the newest body for the threadlist view', async () => {
    const res = await postMissed({});
    const byThread = new Map(
      res.body.data.items.map((i: { threadId: number }) => [i.threadId, i]),
    );
    expect(byThread.get(tBob).unreadCount).toBe(2); // seq 1,2 unread (no lastReadSeq)
    expect(byThread.get(tAlice).muted).toBe(true);
    expect(byThread.get(tBob).displayName).toBe('Bob'); // P2P → peer User.name
    expect(byThread.get(tBob).latestMessage).toMatchObject({ seq: 2, content: 'Bob-2' });
  });
});
