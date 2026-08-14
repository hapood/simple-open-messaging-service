import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import request from 'supertest';
import { and, eq, ne } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DatabaseService } from '../src/database/database.service';
import {
  message,
  messageThread,
  threadParticipant,
  user,
  userBlock,
} from '../src/database/schema';
import { ContentType } from '../src/database/enums.js';
import { seedUser, seedSession } from './seed';

/**
 * /notifications/missed-summary + /notifications/missed e2e — the two SEPARATED endpoints:
 *  - missed-summary (threadlist body pre-warm): the `(from, to]` double-boundary walk of per-thread latest
 *    bodies. `to ≤ from` (stale SSE) → empty no-op.
 *  - missed (away-notification renderers): one descriptor per conversation. Message mode includes a bounded
 *    recent-message sample; private mode omits content entirely.
 *
 * The BigInt message `id` is NEVER exposed — only per-thread `seq` + time. Three P2P threads seeded in
 * insertion order (Alice → Bob → Carol) so message ids strictly increase → deterministic.
 */
describe('notifications/missed-summary + notifications/missed', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let sessionToken: string;
  let recipientId: number;
  let tAlice: number;
  let tBob: number;
  let tCarol: number;
  const base = Date.UTC(2026, 0, 1);

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

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
    const recipient = await seedUser(app, 'recip', { name: 'Recip' });
    recipientId = recipient.id;
    sessionToken = await seedSession(app, recipientId, 'app');
    tAlice = await seedThread({ name: 'Alice' });
    tBob = await seedThread({ name: 'Bob' });
    tCarol = await seedThread({ name: 'Carol' });
  });

  /** Seed one P2P thread: 3 messages (seq 1..3) from a fresh peer. */
  async function seedThread(opts: { name: string }): Promise<number> {
    const now = new Date();
    const [peer] = await database.db
      .insert(user)
      .values({
        account: opts.name.toLowerCase(),
        hashPwd: 'x',
        name: opts.name,
        isForeigner: false,
        updatedAt: now,
      })
      .returning({ id: user.id });
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'P2P',
        curSeq: 3,
        lastMessageSeq: 3,
        lastMessageAt: new Date(base + opts.name.length),
        updatedAt: now,
      })
      .returning({ id: messageThread.id });
    await database.db.insert(threadParticipant).values([
      { userId: recipientId, threadId: thread.id, updatedAt: now },
      { userId: peer.id, threadId: thread.id, updatedAt: now },
    ]);
    await database.db.insert(message).values(
      Array.from({ length: 3 }, (_, index) => ({
        threadId: thread.id,
        seq: index + 1,
        originSeq: index + 1,
        contentType: ContentType.PURE_TEXT,
        content: JSON.stringify({ text: `${opts.name}-${index}` }),
        creator: peer.id,
        createdAt: new Date(base + index),
        updatedAt: now,
      })),
    );
    return thread.id;
  }

  function postSummary(body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/notifications/missed-summary')
      .set('Authorization', `Bearer ${sessionToken}`)
      .send(body);
  }

  function postMissed(
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    return request(app.getHttpServer())
      .post('/api/v1/notifications/missed')
      .set('Authorization', `Bearer ${sessionToken}`)
      .set(headers)
      .send(body);
  }

  // ── /notifications/missed-summary (threadlist) ───────────────────────────────────────────────

  it('missed-summary: threads whose latest-id ∈ (from, to], ASC; nextCursor = page max', async () => {
    // from = Alice's latest, to = Carol's latest → range = Bob + Carol (Alice's latest is the lower bound).
    const res = await postSummary({
      from: { threadId: tAlice, seq: 3 },
      to: { threadId: tCarol, seq: 3 },
      take: 50,
    });
    expect(res.body.code).toBe(0);
    expect(
      res.body.data.items.map((i: { threadId: number }) => i.threadId),
    ).toEqual([tBob, tCarol]);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.nextCursor).toBeNull();
    // Each item carries its thread's newest body (no BigInt id leaks).
    const bob = res.body.data.items.find(
      (i: { threadId: number }) => i.threadId === tBob,
    );
    expect(bob.latestMessage).toMatchObject({
      seq: 3,
      content: JSON.stringify({ text: 'Bob-2' }),
    });
    expect(bob.latestMessage).not.toHaveProperty('id');
  });

  it('missed-summary: paginates — nextCursor = page max-id when hasMore (ASC oldest-first)', async () => {
    // from absent (first boot), to = Carol's latest, take 2 → ASC oldest-first 2 of (−∞, carolLatest].
    const res = await postSummary({
      to: { threadId: tCarol, seq: 3 },
      take: 2,
    });
    expect(
      res.body.data.items.map((i: { threadId: number }) => i.threadId),
    ).toEqual([tAlice, tBob]); // ids 3,6
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).toEqual({ threadId: tBob, seq: 3 }); // page max → the next `from`
  });

  it('missed-summary: to ≤ from (stale SSE) → empty no-op', async () => {
    const res = await postSummary({
      from: { threadId: tCarol, seq: 3 },
      to: { threadId: tAlice, seq: 3 },
      take: 50,
    });
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.hasMore).toBe(false);
  });

  // ── /notifications/missed (renderer) ─────────────────────────────────────────────────────────

  it('missed: since absent (first-ever) → clear descriptor', async () => {
    const res = await postMissed({});
    expect(res.body.data.notifications).toHaveLength(1);
    expect(res.body.data.notifications[0].kind).toBe('clear');
  });

  it('missed: returns one message-preview descriptor per conversation (en)', async () => {
    // since = Alice's seq 1 (the globally-oldest message) → everything after it: Alice 2,3 + Bob 1,2,3 +
    // Carol 1,2,3 = 8 messages across 3 senders → manyConv "Alice, Bob +1 sent you 8 messages".
    const res = await postMissed(
      { since: { threadId: tAlice, seq: 1 } },
      { 'Accept-Language': 'en' },
    );
    const descriptors = res.body.data.notifications;
    expect(
      descriptors.map((d: { data: { threadId: number } }) => d.data.threadId),
    ).toEqual([tCarol, tBob, tAlice]);
    const alice = descriptors.find(
      (d: { data: { threadId: number } }) => d.data.threadId === tAlice,
    );
    expect(alice).toMatchObject({
      kind: 'thread-message',
      title: 'Alice',
      body: 'Alice sent you 2 messages',
      count: 2,
      lang: 'en',
      previewMode: 'message',
      data: { threadId: tAlice, seq: 3 },
    });
    expect(alice.messages.map((m: { text: string }) => m.text)).toEqual([
      'Alice-1',
      'Alice-2',
    ]);
    expect(alice.icon).toBeNull();
  });

  it('missed: private mode contains no sender or message content', async () => {
    const res = await postMissed(
      { since: { threadId: tAlice, seq: 1 }, previewMode: 'private' },
      { 'Accept-Language': 'zh-CN,zh;q=0.9' },
    );
    expect(res.body.data.notifications).toHaveLength(3);
    for (const descriptor of res.body.data.notifications) {
      expect(descriptor).toMatchObject({
        title: 'SOMS',
        body: '你有新消息',
        lang: 'zh-CN',
        previewMode: 'private',
      });
      expect(descriptor).not.toHaveProperty('messages');
      expect(JSON.stringify(descriptor)).not.toMatch(/Alice-|Bob-|Carol-/);
    }
  });

  it('missed: a blocked sender is excluded from the aggregation', async () => {
    // Block Carol's peer → her 3 messages drop out: Alice 1,2 + Bob 0,1,2 = 5, 2 senders.
    const [carolPeer] = await database.db
      .select({ userId: threadParticipant.userId })
      .from(threadParticipant)
      .where(
        and(
          eq(threadParticipant.threadId, tCarol),
          ne(threadParticipant.userId, recipientId),
        ),
      )
      .limit(1);
    await database.db.insert(userBlock).values({
      blockerId: recipientId,
      blockedId: carolPeer.userId,
    });
    const res = await postMissed(
      { since: { threadId: tAlice, seq: 1 } },
      { 'Accept-Language': 'en' },
    );
    expect(
      res.body.data.notifications.map(
        (d: { data: { threadId: number } }) => d.data.threadId,
      ),
    ).toEqual([tBob, tAlice]);
  });

  it('missed: a muted thread is excluded from the aggregation', async () => {
    // Mute Bob's thread → Bob's 3 messages drop out: Alice 1,2 + Carol 0,1,2 = 5, 2 senders.
    await database.db
      .update(threadParticipant)
      .set({ muted: true })
      .where(
        and(
          eq(threadParticipant.userId, recipientId),
          eq(threadParticipant.threadId, tBob),
        ),
      );
    const res = await postMissed(
      { since: { threadId: tAlice, seq: 1 } },
      { 'Accept-Language': 'en' },
    );
    expect(
      res.body.data.notifications.map(
        (d: { data: { threadId: number } }) => d.data.threadId,
      ),
    ).toEqual([tCarol, tAlice]);
  });

  it('missed: HWM at the global newest → no conversation descriptors', async () => {
    const res = await postMissed({ since: { threadId: tCarol, seq: 3 } });
    expect(res.body.data.notifications).toEqual([]);
  });
});
